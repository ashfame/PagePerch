import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { NoteRecordV1 } from '../domain/note';
import type {
  PageIdentity,
  PageIdentityExclusionRule,
  PageIdentityService,
} from '../domain/pageIdentity';
import type { SettingsRecordV1 } from '../domain/settings';
import { isNoteRecordV1 } from '../repositories/validation';
import {
  IDENTITY_MIGRATION_PLAN_SCHEMA_VERSION,
  fingerprintIdentityMigrationNote,
  fingerprintIdentityMigrationSettings,
  type IdentityMigrationPlan,
  type IdentityMigrationPlanError,
  type IdentityMigrationPlannerInput,
  type PlannedIdentityMigration,
  parseIdentityMigrationPlan,
  planIdentityMigration,
} from './identityMigration';
import { normalizeGutenbergContent } from './note';
import {
  BUILT_IN_PAGE_IDENTITY_EXCLUSIONS,
  DefaultPageIdentityService,
} from './pageIdentity';

const ORIGIN = 'https://example.com';
const OTHER_ORIGIN = 'https://other.example';
const PLANNED_AT = '2026-07-25T12:34:56.789Z';
const SAVED_AT = '2026-07-24T10:00:00.000Z';
const CONTENT =
  '<!-- wp:paragraph -->\n<p>Original note</p>\n<!-- /wp:paragraph -->';

function independentHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

function settings(
  pageIdentityExclusions: readonly PageIdentityExclusionRule[] = [],
  overrides: Partial<SettingsRecordV1> = {},
): SettingsRecordV1 {
  return {
    schemaVersion: 1,
    editorMode: 'text-focused-blocks',
    pageIdentityExclusions,
    ...overrides,
  };
}

async function supportedIdentity(
  rawUrl: string,
  rules: readonly PageIdentityExclusionRule[] = [],
): Promise<PageIdentity> {
  const result = await new DefaultPageIdentityService().identify(rawUrl, rules);

  if (result.status !== 'supported') {
    throw new Error(`Expected ${rawUrl} to be supported.`);
  }

  return result.identity;
}

function identityForCanonical(canonicalUrl: string): PageIdentity {
  const parsed = new URL(canonicalUrl);

  return {
    canonicalUrl,
    isRoot: canonicalUrl === `${parsed.origin}/`,
    origin: parsed.origin,
    pageKey: independentHash(canonicalUrl),
    pathname: parsed.pathname,
  };
}

async function note(
  rawUrl: string,
  currentSettings: SettingsRecordV1,
  overrides: Partial<NoteRecordV1> = {},
): Promise<NoteRecordV1> {
  const identity = await supportedIdentity(
    rawUrl,
    currentSettings.pageIdentityExclusions,
  );
  const deletedAt = overrides.deletedAt;
  const contentHtml =
    overrides.contentHtml ?? (deletedAt === undefined ? CONTENT : '');

  return {
    schemaVersion: 1,
    pageKey: identity.pageKey,
    canonicalUrl: identity.canonicalUrl,
    representativeUrl: new URL(rawUrl).href,
    origin: identity.origin,
    title: 'Example title',
    contentHtml,
    contentHash: independentHash(contentHtml),
    savedAt: SAVED_AT,
    revisionId: 'source-revision',
    ...overrides,
  };
}

function noteFingerprint(record: NoteRecordV1): string {
  return independentHash(
    JSON.stringify({
      schemaVersion: record.schemaVersion,
      pageKey: record.pageKey,
      canonicalUrl: record.canonicalUrl,
      representativeUrl: record.representativeUrl,
      origin: record.origin,
      title: record.title,
      contentHtml: record.contentHtml,
      contentHash: record.contentHash,
      savedAt: record.savedAt,
      revisionId: record.revisionId,
      deletedAt: record.deletedAt ?? null,
    }),
  );
}

function settingsFingerprint(record: SettingsRecordV1): string {
  return independentHash(
    JSON.stringify({
      schemaVersion: record.schemaVersion,
      editorMode: record.editorMode,
      pageIdentityExclusions: record.pageIdentityExclusions.map((rule) => ({
        origin: rule.origin,
        parameterNames: [...rule.parameterNames],
      })),
      byosConnection:
        record.byosConnection === undefined
          ? null
          : {
              accessToken: record.byosConnection.accessToken,
              expiresAt: record.byosConnection.expiresAt,
              connectedAt: record.byosConnection.connectedAt,
              lastSuccessfulSyncAt:
                record.byosConnection.lastSuccessfulSyncAt ?? null,
            },
    }),
  );
}

function plannerHarness(
  input: Pick<
    IdentityMigrationPlannerInput,
    'currentSettings' | 'requestedSettings' | 'records'
  >,
  overrides: Partial<
    Pick<
      IdentityMigrationPlannerInput,
      | 'clock'
      | 'operationIdFactory'
      | 'revisionIdFactory'
      | 'pageIdentityService'
    >
  > = {},
): {
  readonly input: IdentityMigrationPlannerInput;
  readonly clock: ReturnType<typeof vi.fn<() => Date>>;
  readonly operationIdFactory: ReturnType<typeof vi.fn<() => string>>;
  readonly revisionIdFactory: ReturnType<typeof vi.fn<() => string>>;
} {
  let revision = 0;
  const clock = vi.fn<() => Date>(() => new Date(PLANNED_AT));
  const operationIdFactory = vi.fn<() => string>(
    () => 'identity-migration-operation',
  );
  const revisionIdFactory = vi.fn<() => string>(
    () => `planned-revision-${(revision += 1)}`,
  );

  return {
    input: {
      ...input,
      clock: overrides.clock ?? clock,
      operationIdFactory: overrides.operationIdFactory ?? operationIdFactory,
      revisionIdFactory: overrides.revisionIdFactory ?? revisionIdFactory,
      pageIdentityService:
        overrides.pageIdentityService ?? new DefaultPageIdentityService(),
    },
    clock,
    operationIdFactory,
    revisionIdFactory,
  };
}

function requirePlanned(
  plan: IdentityMigrationPlan,
): asserts plan is PlannedIdentityMigration {
  expect(plan.status).toBe('planned');

  if (plan.status !== 'planned') {
    throw new Error('Expected a planned identity migration.');
  }
}

function applyPlanWrites(
  records: readonly NoteRecordV1[],
  plan: PlannedIdentityMigration,
): readonly NoteRecordV1[] {
  const applied = new Map(
    records.map((record) => [record.pageKey, record] as const),
  );

  for (const { record } of plan.destinations) {
    applied.set(record.pageKey, record);
  }

  for (const { record } of plan.sourceTombstones) {
    applied.set(record.pageKey, record);
  }

  return [...applied.values()];
}

function jsonCopy(value: unknown): unknown {
  const parsed: unknown = JSON.parse(JSON.stringify(value));

  return parsed;
}

function mutableObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected a mutable object fixture.');
  }

  return value as Record<string, unknown>;
}

function mutableArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error('Expected a mutable array fixture.');
  }

  return value;
}

async function expectPlanError(
  promise: Promise<unknown>,
  code: IdentityMigrationPlanError['code'],
): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    name: 'IdentityMigrationPlanError',
    code,
  });
}

describe('planIdentityMigration additions', () => {
  it('plans one normalized exact-origin addition with an unwrapped move and exact durable metadata', async () => {
    const currentSettings = settings();
    const requestedSettings = settings([
      {
        origin: 'HTTPS://EXAMPLE.COM:443/',
        parameterNames: ['Session.ID'],
      },
    ]);
    const source = await note(
      `${ORIGIN}/article?session.id=one&view=full`,
      currentSettings,
      {
        title: 'Article note',
      },
    );
    const inputSnapshot = JSON.stringify({
      currentSettings,
      requestedSettings,
      records: [source],
    });
    const harness = plannerHarness({
      currentSettings,
      requestedSettings,
      records: [source],
    });
    const plan = await planIdentityMigration(harness.input);

    requirePlanned(plan);
    expect(plan).toMatchObject({
      schemaVersion: IDENTITY_MIGRATION_PLAN_SCHEMA_VERSION,
      status: 'planned',
      operationId: 'identity-migration-operation',
      phase: 'planned',
      plannedAt: PLANNED_AT,
      change: {
        kind: 'add-parameter-exclusion',
        origin: ORIGIN,
        parameterName: 'session.id',
      },
    });
    expect(plan.requestedSettings).toEqual(
      settings([
        {
          origin: ORIGIN,
          parameterNames: ['session.id'],
        },
      ]),
    );
    expect(plan.expected.settings).toEqual({
      record: currentSettings,
      fingerprint: settingsFingerprint(currentSettings),
    });
    expect(plan.expected.sources).toEqual([
      {
        record: source,
        fingerprint: noteFingerprint(source),
      },
    ]);

    expect(plan.destinations).toHaveLength(1);
    const destination = plan.destinations[0];
    expect(destination).toBeDefined();
    expect(destination?.expectedRecordFingerprint).toBeNull();
    expect(destination?.record).toMatchObject({
      canonicalUrl: `${ORIGIN}/article?view=full`,
      representativeUrl: `${ORIGIN}/article?session.id=one&view=full`,
      origin: ORIGIN,
      title: 'Article note',
      contentHtml: CONTENT,
      contentHash: independentHash(CONTENT),
      savedAt: PLANNED_AT,
      revisionId: 'planned-revision-1',
    });
    expect(destination?.record.pageKey).toBe(
      independentHash(`${ORIGIN}/article?view=full`),
    );
    expect(isNoteRecordV1(destination?.record)).toBe(true);
    expect(destination?.record.deletedAt).toBeUndefined();

    expect(plan.sourceTombstones).toHaveLength(1);
    expect(plan.sourceTombstones[0]).toEqual({
      expectedRecordFingerprint: noteFingerprint(source),
      record: {
        ...source,
        contentHtml: '',
        contentHash: independentHash(''),
        savedAt: PLANNED_AT,
        revisionId: 'planned-revision-2',
        deletedAt: PLANNED_AT,
      },
    });
    expect(isNoteRecordV1(plan.sourceTombstones[0]?.record)).toBe(true);
    expect(harness.clock).toHaveBeenCalledTimes(1);
    expect(harness.operationIdFactory).toHaveBeenCalledTimes(1);
    expect(harness.revisionIdFactory).toHaveBeenCalledTimes(2);
    expect(
      JSON.stringify({ currentSettings, requestedSettings, records: [source] }),
    ).toBe(inputSnapshot);
  });

  it('handles root and meaningful-query destinations independently and sorts writes by page key', async () => {
    const currentSettings = settings();
    const requestedSettings = settings([
      { origin: ORIGIN, parameterNames: ['variant'] },
    ]);
    const rootSource = await note(
      `${ORIGIN}/?variant=compact`,
      currentSettings,
      { contentHtml: '<!-- wp:paragraph --><p>Root</p><!-- /wp:paragraph -->' },
    );
    const querySource = await note(
      `${ORIGIN}/guide?variant=compact&view=print`,
      currentSettings,
      {
        contentHtml: '<!-- wp:paragraph --><p>Query</p><!-- /wp:paragraph -->',
      },
    );
    const plan = await planIdentityMigration(
      plannerHarness({
        currentSettings,
        requestedSettings,
        records: [querySource, rootSource],
      }).input,
    );

    requirePlanned(plan);
    const destinations = new Map(
      plan.destinations.map(({ record }) => [record.canonicalUrl, record]),
    );
    expect(destinations.get(`${ORIGIN}/`)).toMatchObject({
      canonicalUrl: `${ORIGIN}/`,
      pageKey: independentHash(`${ORIGIN}/`),
    });
    expect(destinations.get(`${ORIGIN}/guide?view=print`)).toMatchObject({
      canonicalUrl: `${ORIGIN}/guide?view=print`,
      pageKey: independentHash(`${ORIGIN}/guide?view=print`),
    });
    expect(plan.destinations.map(({ record }) => record.pageKey)).toEqual(
      [...plan.destinations.map(({ record }) => record.pageKey)].sort(),
    );
    expect(plan.sourceTombstones.map(({ record }) => record.pageKey)).toEqual(
      [...plan.sourceTombstones.map(({ record }) => record.pageKey)].sort(),
    );
  });

  it('merges every live collision source, including an existing destination, in stable age/revision/page-key order', async () => {
    const currentSettings = settings();
    const requestedSettings = settings([
      { origin: ORIGIN, parameterNames: ['variant'] },
    ]);
    const existingDestination = await note(
      `${ORIGIN}/article?view=all`,
      currentSettings,
      {
        title: 'Stable destination title',
        contentHtml:
          '<!-- wp:paragraph -->\n<p>Existing destination</p>\n<!-- /wp:paragraph -->',
        savedAt: '2026-07-20T10:00:00.000Z',
        revisionId: 'revision-z',
      },
    );
    const alpha = await note(
      `${ORIGIN}/article?variant=alpha&view=all`,
      currentSettings,
      {
        contentHtml:
          '<!-- wp:paragraph -->\n<p>Alpha</p>\n<!-- /wp:paragraph -->',
        savedAt: '2026-07-21T10:00:00.000Z',
        revisionId: 'revision-z',
      },
    );
    const beta = await note(
      `${ORIGIN}/article?variant=beta&view=all`,
      currentSettings,
      {
        contentHtml:
          '<!-- wp:paragraph -->\n<p>Beta</p>\n<!-- /wp:paragraph -->',
        savedAt: '2026-07-21T10:00:00Z',
        revisionId: 'revision-a',
      },
    );
    const sources = [alpha, existingDestination, beta];
    const expectedOrder = [...sources].sort(
      (left, right) =>
        new Date(left.savedAt).valueOf() - new Date(right.savedAt).valueOf() ||
        left.revisionId.localeCompare(right.revisionId) ||
        left.pageKey.localeCompare(right.pageKey),
    );
    const plan = await planIdentityMigration(
      plannerHarness({
        currentSettings,
        requestedSettings,
        records: sources,
      }).input,
    );

    requirePlanned(plan);
    expect(plan.destinations).toHaveLength(1);
    const destination = plan.destinations[0];
    expect(destination?.expectedRecordFingerprint).toBe(
      noteFingerprint(existingDestination),
    );
    expect(destination?.record.title).toBe(expectedOrder[0]?.title);
    expect(destination?.record.representativeUrl).toBe(
      expectedOrder.find(
        (source) => source.pageKey !== existingDestination.pageKey,
      )?.representativeUrl,
    );
    const expectedContent = expectedOrder
      .map(
        (source) =>
          `<!-- wp:heading -->\n<h2 class="wp-block-heading">Source: ${source.canonicalUrl.replaceAll('&', '&amp;')}</h2>\n<!-- /wp:heading -->\n\n${source.contentHtml}`,
      )
      .join('\n\n');
    expect(destination?.record.contentHtml).toBe(expectedContent);
    expect(destination?.record.contentHash).toBe(
      independentHash(expectedContent),
    );
    expect(
      expectedOrder.map((source) =>
        destination?.record.contentHtml.indexOf(source.contentHtml),
      ),
    ).toEqual(
      [...expectedOrder.keys()].map((index) => {
        const source = expectedOrder[index];
        return source === undefined
          ? -1
          : expectedContent.indexOf(source.contentHtml);
      }),
    );
    expect(destination?.record.contentHtml).toContain('&amp;view=all');
    expect(
      destination?.record.contentHtml.match(/<!-- wp:heading -->/gu),
    ).toHaveLength(3);
    expect(plan.sourceTombstones.map(({ record }) => record.pageKey)).toEqual(
      [alpha.pageKey, beta.pageKey].sort(),
    );
    expect(
      plan.sourceTombstones.some(
        ({ record }) => record.pageKey === existingDestination.pageKey,
      ),
    ).toBe(false);
  });

  it('replaces an existing destination tombstone and leaves unrelated adequate tombstones unchanged', async () => {
    const currentSettings = settings();
    const requestedSettings = settings([
      { origin: ORIGIN, parameterNames: ['variant'] },
    ]);
    const liveSource = await note(
      `${ORIGIN}/article?variant=one`,
      currentSettings,
    );
    const destinationTombstone = await note(
      `${ORIGIN}/article`,
      currentSettings,
      {
        deletedAt: '2026-07-20T10:00:00.000Z',
        savedAt: '2026-07-20T10:00:00.000Z',
        revisionId: 'old-destination-tombstone',
      },
    );
    const unrelatedTombstone = await note(
      `${ORIGIN}/article?variant=two`,
      currentSettings,
      {
        deletedAt: '2026-07-21T10:00:00.000Z',
        savedAt: '2026-07-21T10:00:00.000Z',
        revisionId: 'adequate-tombstone',
      },
    );
    const plan = await planIdentityMigration(
      plannerHarness({
        currentSettings,
        requestedSettings,
        records: [unrelatedTombstone, destinationTombstone, liveSource],
      }).input,
    );

    requirePlanned(plan);
    expect(plan.destinations[0]?.expectedRecordFingerprint).toBe(
      noteFingerprint(destinationTombstone),
    );
    expect(plan.destinations[0]?.record.deletedAt).toBeUndefined();
    expect(plan.sourceTombstones.map(({ record }) => record.pageKey)).toEqual([
      liveSource.pageKey,
    ]);
    expect(
      plan.sourceTombstones.some(
        ({ record }) => record.pageKey === unrelatedTombstone.pageKey,
      ),
    ).toBe(false);
    expect(plan.expected.sources.map(({ record }) => record.pageKey)).toEqual(
      [liveSource, destinationTombstone, unrelatedTombstone]
        .map((record) => record.pageKey)
        .sort(),
    );
  });

  it('isolates one exact origin and never asks identity derivation about other-origin records', async () => {
    const currentSettings = settings();
    const requestedSettings = settings([
      { origin: ORIGIN, parameterNames: ['variant'] },
    ]);
    const affected = await note(
      `${ORIGIN}/article?variant=one`,
      currentSettings,
    );
    const outside = await note(
      `${OTHER_ORIGIN}/article?variant=one`,
      currentSettings,
    );
    const service = new DefaultPageIdentityService();
    const identify = vi.spyOn(service, 'identify');
    const plan = await planIdentityMigration(
      plannerHarness(
        {
          currentSettings,
          requestedSettings,
          records: [outside, affected],
        },
        { pageIdentityService: service },
      ).input,
    );

    requirePlanned(plan);
    expect(plan.expected.sources).toHaveLength(1);
    expect(plan.expected.sources[0]?.record).toEqual(affected);
    expect(plan.destinations).toHaveLength(1);
    expect(plan.sourceTombstones).toHaveLength(1);
    expect(identify).toHaveBeenCalledTimes(2);
    expect(
      identify.mock.calls.every(([rawUrl]) => rawUrl.startsWith(ORIGIN)),
    ).toBe(true);
  });

  it('plans a durable settings-only operation when the affected origin has no records', async () => {
    const currentSettings = settings();
    const requestedSettings = settings([
      { origin: ORIGIN, parameterNames: ['variant'] },
    ]);
    const harness = plannerHarness({
      currentSettings,
      requestedSettings,
      records: [],
    });
    const plan = await planIdentityMigration(harness.input);

    requirePlanned(plan);
    expect(plan.expected.sources).toEqual([]);
    expect(plan.destinations).toEqual([]);
    expect(plan.sourceTombstones).toEqual([]);
    expect(harness.clock).toHaveBeenCalledTimes(1);
    expect(harness.operationIdFactory).toHaveBeenCalledTimes(1);
    expect(harness.revisionIdFactory).not.toHaveBeenCalled();
  });
});

describe('planIdentityMigration exact parameter-name domain', () => {
  it.each([
    ['bracketed', 'filters[]', 'filters%5B%5D'],
    ['delimiter ampersand', 'A&B', 'A%26B'],
    ['delimiter equals', 'x=y', 'x%3Dy'],
    ['encoded percent', '%encoded', '%25encoded'],
    ['Unicode', 'Étiquette', '%C3%89tiquette'],
    ['significant whitespace', ' spaced ', '%20spaced%20'],
    ['long', 'a'.repeat(256), 'a'.repeat(256)],
  ])(
    'uses a %s name case-insensitively with the default identity service for addition and removal',
    async (_label, parameterName, encodedParameterName) => {
      const originalSettings = settings();
      const exclusionSettings = settings([
        { origin: ORIGIN, parameterNames: [parameterName] },
      ]);
      const representativeUrl = `${ORIGIN}/article?${encodedParameterName}=one&view=full`;
      const source = await note(representativeUrl, originalSettings);
      const addition = await planIdentityMigration(
        plannerHarness({
          currentSettings: originalSettings,
          requestedSettings: exclusionSettings,
          records: [source],
        }).input,
      );

      requirePlanned(addition);
      expect(addition.change.parameterName).toBe(parameterName.toLowerCase());
      expect(addition.destinations[0]?.record.canonicalUrl).toBe(
        `${ORIGIN}/article?view=full`,
      );
      const applied = applyPlanWrites([source], addition);
      const removal = await planIdentityMigration(
        plannerHarness({
          currentSettings: addition.requestedSettings,
          requestedSettings: originalSettings,
          records: applied,
        }).input,
      );
      const originalIdentity = await supportedIdentity(representativeUrl);

      requirePlanned(removal);
      expect(removal.destinations[0]?.record.canonicalUrl).toBe(
        originalIdentity.canonicalUrl,
      );
      expect(removal.destinations[0]?.record.contentHtml).toBe(
        addition.destinations[0]?.record.contentHtml,
      );
    },
  );

  it('normalizes CRLF and surrounding Gutenberg serialization whitespace before single and collision hashes are generated', async () => {
    const currentSettings = settings();
    const requestedSettings = settings([
      { origin: ORIGIN, parameterNames: ['variant'] },
    ]);
    const rawSingle =
      ' \r\n<!-- wp:paragraph -->\r\n<p>Single</p>\r\n<!-- /wp:paragraph -->\r\n ';
    const single = await note(`${ORIGIN}/single?variant=one`, currentSettings, {
      contentHtml: rawSingle,
    });
    const singlePlan = await planIdentityMigration(
      plannerHarness({
        currentSettings,
        requestedSettings,
        records: [single],
      }).input,
    );

    requirePlanned(singlePlan);
    const normalizedSingle = normalizeGutenbergContent(rawSingle);
    expect(singlePlan.destinations[0]?.record.contentHtml).toBe(
      normalizedSingle,
    );
    expect(singlePlan.destinations[0]?.record.contentHash).toBe(
      independentHash(normalizedSingle),
    );

    const rawAlpha =
      '\r\n<!-- wp:paragraph -->\r\n<p>Alpha</p>\r\n<!-- /wp:paragraph -->\r\n';
    const rawBeta =
      ' \n<!-- wp:paragraph -->\n<p>Beta</p>\n<!-- /wp:paragraph --> \n';
    const alpha = await note(
      `${ORIGIN}/collision?variant=alpha`,
      currentSettings,
      {
        contentHtml: rawAlpha,
        revisionId: 'alpha',
      },
    );
    const beta = await note(
      `${ORIGIN}/collision?variant=beta`,
      currentSettings,
      {
        contentHtml: rawBeta,
        revisionId: 'beta',
      },
    );
    const collisionPlan = await planIdentityMigration(
      plannerHarness({
        currentSettings,
        requestedSettings,
        records: [beta, alpha],
      }).input,
    );

    requirePlanned(collisionPlan);
    const merged = collisionPlan.destinations[0]?.record.contentHtml;
    expect(merged).not.toContain('\r');
    expect(merged).toContain(normalizeGutenbergContent(rawAlpha));
    expect(merged).toContain(normalizeGutenbergContent(rawBeta));
    expect(merged).toBe(normalizeGutenbergContent(merged ?? ''));
    expect(collisionPlan.destinations[0]?.record.contentHash).toBe(
      independentHash(merged ?? ''),
    );
  });
});

describe('planIdentityMigration removals and idempotency', () => {
  it('round-trips a real default-service collision addition into a removal through old-key tombstones without splitting or nesting content', async () => {
    const originalSettings = settings();
    const exclusionSettings = settings([
      { origin: ORIGIN, parameterNames: ['variant'] },
    ]);
    const alpha = await note(
      `${ORIGIN}/article?variant=alpha`,
      originalSettings,
      {
        contentHtml:
          '<!-- wp:paragraph -->\n<p>Alpha</p>\n<!-- /wp:paragraph -->',
        revisionId: 'alpha-revision',
      },
    );
    const beta = await note(
      `${ORIGIN}/article?variant=beta`,
      originalSettings,
      {
        contentHtml:
          '<!-- wp:paragraph -->\n<p>Beta</p>\n<!-- /wp:paragraph -->',
        revisionId: 'beta-revision',
      },
    );
    const addition = await planIdentityMigration(
      plannerHarness({
        currentSettings: originalSettings,
        requestedSettings: exclusionSettings,
        records: [beta, alpha],
      }).input,
    );

    requirePlanned(addition);
    const combined = addition.destinations[0]?.record;
    expect(combined).toBeDefined();
    expect(addition.sourceTombstones).toHaveLength(2);
    const applied = applyPlanWrites([alpha, beta], addition);
    const removal = await planIdentityMigration(
      plannerHarness({
        currentSettings: addition.requestedSettings,
        requestedSettings: originalSettings,
        records: applied,
      }).input,
    );

    requirePlanned(removal);
    expect(removal.change.kind).toBe('remove-parameter-exclusion');
    expect(removal.destinations).toHaveLength(1);
    expect(removal.destinations[0]?.record.contentHtml).toBe(
      combined?.contentHtml,
    );
    expect(
      removal.destinations[0]?.record.contentHtml.match(
        /<!-- wp:heading -->/gu,
      ),
    ).toHaveLength(2);
    expect(removal.sourceTombstones).toHaveLength(1);
    const removalDestinationKey = removal.destinations[0]?.record.pageKey;
    const priorDestinationTombstone = applied.find(
      (record) =>
        record.pageKey === removalDestinationKey &&
        record.deletedAt !== undefined,
    );
    expect(priorDestinationTombstone).toBeDefined();
    expect(removal.destinations[0]?.expectedRecordFingerprint).toBe(
      priorDestinationTombstone === undefined
        ? undefined
        : noteFingerprint(priorDestinationTombstone),
    );
  });

  it('replaces a realistic removal destination tombstone and deterministically preserves a resurrected requested-identity live collision', async () => {
    const originalSettings = settings();
    const exclusionSettings = settings([
      { origin: ORIGIN, parameterNames: ['variant'] },
    ]);
    const source = await note(
      `${ORIGIN}/article?variant=blue`,
      originalSettings,
      {
        contentHtml:
          '<!-- wp:paragraph -->\n<p>Original source</p>\n<!-- /wp:paragraph -->',
      },
    );
    const addition = await planIdentityMigration(
      plannerHarness({
        currentSettings: originalSettings,
        requestedSettings: exclusionSettings,
        records: [source],
      }).input,
    );

    requirePlanned(addition);
    const applied = applyPlanWrites([source], addition);
    const destinationTombstone = applied.find(
      (record) => record.pageKey === source.pageKey,
    );
    expect(destinationTombstone?.deletedAt).toBeDefined();

    const tombstoneRemoval = await planIdentityMigration(
      plannerHarness({
        currentSettings: exclusionSettings,
        requestedSettings: originalSettings,
        records: applied,
      }).input,
    );

    requirePlanned(tombstoneRemoval);
    expect(tombstoneRemoval.destinations[0]?.expectedRecordFingerprint).toBe(
      destinationTombstone === undefined
        ? undefined
        : noteFingerprint(destinationTombstone),
    );

    if (destinationTombstone === undefined) {
      throw new Error('Expected an addition source tombstone.');
    }

    const resurrectedContent =
      '<!-- wp:paragraph -->\n<p>Resurrected old identity</p>\n<!-- /wp:paragraph -->';
    const resurrected: NoteRecordV1 = {
      schemaVersion: destinationTombstone.schemaVersion,
      pageKey: destinationTombstone.pageKey,
      canonicalUrl: destinationTombstone.canonicalUrl,
      representativeUrl: destinationTombstone.representativeUrl,
      origin: destinationTombstone.origin,
      title: destinationTombstone.title,
      contentHtml: resurrectedContent,
      contentHash: independentHash(resurrectedContent),
      savedAt: '2026-07-26T10:00:00.000Z',
      revisionId: 'resurrected-revision',
    };
    const collidedRecords = applied.map((record) =>
      record.pageKey === resurrected.pageKey ? resurrected : record,
    );
    const liveCollision = await planIdentityMigration(
      plannerHarness({
        currentSettings: exclusionSettings,
        requestedSettings: originalSettings,
        records: collidedRecords,
      }).input,
    );

    requirePlanned(liveCollision);
    expect(liveCollision.destinations).toHaveLength(1);
    expect(liveCollision.destinations[0]?.expectedRecordFingerprint).toBe(
      noteFingerprint(resurrected),
    );
    expect(liveCollision.destinations[0]?.record.contentHtml).toContain(
      resurrectedContent,
    );
    expect(liveCollision.destinations[0]?.record.contentHtml).toContain(
      addition.destinations[0]?.record.contentHtml,
    );
    expect(liveCollision.sourceTombstones).toHaveLength(1);
  });

  it('moves a combined document without splitting or nesting it, then becomes an ID-free no-op once applied', async () => {
    const currentSettings = settings([
      { origin: ORIGIN, parameterNames: ['variant'] },
    ]);
    const requestedSettings = settings();
    const combinedContent =
      '<!-- wp:heading -->\n<h2>Source: old A</h2>\n<!-- /wp:heading -->\n\n<!-- wp:paragraph -->\n<p>A</p>\n<!-- /wp:paragraph -->\n\n<!-- wp:heading -->\n<h2>Source: old B</h2>\n<!-- /wp:heading -->\n\n<!-- wp:paragraph -->\n<p>B</p>\n<!-- /wp:paragraph -->';
    const combined = await note(
      `${ORIGIN}/article?variant=blue`,
      currentSettings,
      {
        contentHtml: combinedContent,
        title: 'Combined note',
      },
    );
    const firstHarness = plannerHarness({
      currentSettings,
      requestedSettings,
      records: [combined],
    });
    const plan = await planIdentityMigration(firstHarness.input);

    requirePlanned(plan);
    expect(plan.change).toEqual({
      kind: 'remove-parameter-exclusion',
      origin: ORIGIN,
      parameterName: 'variant',
    });
    expect(plan.destinations).toHaveLength(1);
    expect(plan.destinations[0]?.record).toMatchObject({
      canonicalUrl: `${ORIGIN}/article?variant=blue`,
      contentHtml: combinedContent,
      contentHash: independentHash(combinedContent),
      representativeUrl: `${ORIGIN}/article?variant=blue`,
    });
    expect(
      plan.destinations[0]?.record.contentHtml.match(/<!-- wp:heading -->/gu),
    ).toHaveLength(2);
    expect(plan.sourceTombstones).toHaveLength(1);

    const appliedRecords = new Map([[combined.pageKey, combined]]);

    for (const { record } of plan.destinations) {
      appliedRecords.set(record.pageKey, record);
    }

    for (const { record } of plan.sourceTombstones) {
      appliedRecords.set(record.pageKey, record);
    }

    const repeatedHarness = plannerHarness({
      currentSettings: plan.requestedSettings,
      requestedSettings: plan.requestedSettings,
      records: [...appliedRecords.values()],
    });
    const repeated = await planIdentityMigration(repeatedHarness.input);

    expect(repeated).toEqual({
      schemaVersion: IDENTITY_MIGRATION_PLAN_SCHEMA_VERSION,
      status: 'no-op',
      reason: 'already-applied',
    });
    expect(repeatedHarness.clock).not.toHaveBeenCalled();
    expect(repeatedHarness.operationIdFactory).not.toHaveBeenCalled();
    expect(repeatedHarness.revisionIdFactory).not.toHaveBeenCalled();
  });

  it('preserves all content in a deterministic merge if an injected identity implementation exposes an unexpected removal collision', async () => {
    const currentSettings = settings([
      { origin: ORIGIN, parameterNames: ['variant'] },
    ]);
    const requestedSettings = settings();
    const firstCurrentIdentity = identityForCanonical(`${ORIGIN}/a`);
    const secondCurrentIdentity = identityForCanonical(`${ORIGIN}/b`);
    const destinationIdentity = identityForCanonical(`${ORIGIN}/destination`);
    const firstRepresentative = `${ORIGIN}/source-one`;
    const secondRepresentative = `${ORIGIN}/source-two`;
    const firstContent =
      '<!-- wp:paragraph -->\n<p>First</p>\n<!-- /wp:paragraph -->';
    const secondContent =
      '<!-- wp:paragraph -->\n<p>Second</p>\n<!-- /wp:paragraph -->';
    const first: NoteRecordV1 = {
      schemaVersion: 1,
      pageKey: firstCurrentIdentity.pageKey,
      canonicalUrl: firstCurrentIdentity.canonicalUrl,
      origin: firstCurrentIdentity.origin,
      representativeUrl: firstRepresentative,
      title: 'First',
      contentHtml: firstContent,
      contentHash: independentHash(firstContent),
      savedAt: '2026-07-20T10:00:00.000Z',
      revisionId: 'revision-b',
    };
    const second: NoteRecordV1 = {
      schemaVersion: 1,
      pageKey: secondCurrentIdentity.pageKey,
      canonicalUrl: secondCurrentIdentity.canonicalUrl,
      origin: secondCurrentIdentity.origin,
      representativeUrl: secondRepresentative,
      title: 'Second',
      contentHtml: secondContent,
      contentHash: independentHash(secondContent),
      savedAt: '2026-07-20T10:00:00.000Z',
      revisionId: 'revision-a',
    };
    const service: PageIdentityService = {
      builtInExclusions: BUILT_IN_PAGE_IDENTITY_EXCLUSIONS,
      identify(rawUrl, rules = []) {
        const isCurrent = rules.some((rule) =>
          rule.parameterNames.includes('variant'),
        );

        if (!isCurrent) {
          return Promise.resolve({
            status: 'supported',
            identity: destinationIdentity,
          });
        }

        return Promise.resolve({
          status: 'supported',
          identity:
            rawUrl === firstRepresentative
              ? firstCurrentIdentity
              : secondCurrentIdentity,
        });
      },
    };
    const plan = await planIdentityMigration(
      plannerHarness(
        {
          currentSettings,
          requestedSettings,
          records: [first, second],
        },
        { pageIdentityService: service },
      ).input,
    );

    requirePlanned(plan);
    expect(plan.destinations).toHaveLength(1);
    expect(plan.destinations[0]?.record.canonicalUrl).toBe(
      `${ORIGIN}/destination`,
    );
    expect(plan.destinations[0]?.record.title).toBe('Second');
    expect(plan.destinations[0]?.record.contentHtml).toContain(secondContent);
    expect(plan.destinations[0]?.record.contentHtml).toContain(firstContent);
    expect(
      plan.destinations[0]?.record.contentHtml.indexOf(secondContent),
    ).toBeLessThan(
      plan.destinations[0]?.record.contentHtml.indexOf(firstContent) ?? -1,
    );
    expect(plan.sourceTombstones).toHaveLength(2);
  });

  it('returns a deeply immutable semantic no-op for case/order-only settings differences without consuming IDs or time', async () => {
    const currentSettings = settings([
      { origin: ORIGIN, parameterNames: ['zeta', 'Alpha'] },
    ]);
    const requestedSettings = settings([
      {
        origin: 'HTTPS://EXAMPLE.COM:443/',
        parameterNames: ['alpha', 'ZETA'],
      },
    ]);
    const source = await note(`${ORIGIN}/article?alpha=one`, currentSettings);
    const harness = plannerHarness({
      currentSettings,
      requestedSettings,
      records: [source],
    });
    const plan = await planIdentityMigration(harness.input);

    expect(plan).toEqual({
      schemaVersion: IDENTITY_MIGRATION_PLAN_SCHEMA_VERSION,
      status: 'no-op',
      reason: 'already-applied',
    });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(harness.clock).not.toHaveBeenCalled();
    expect(harness.operationIdFactory).not.toHaveBeenCalled();
    expect(harness.revisionIdFactory).not.toHaveBeenCalled();
  });

  it('deep-freezes a planned operation while leaving every caller-owned object mutable and unchanged', async () => {
    const currentSettings = settings();
    const requestedSettings = settings([
      { origin: ORIGIN, parameterNames: ['variant'] },
    ]);
    const source = await note(`${ORIGIN}/article?variant=one`, currentSettings);
    const plan = await planIdentityMigration(
      plannerHarness({
        currentSettings,
        requestedSettings,
        records: [source],
      }).input,
    );

    requirePlanned(plan);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.change)).toBe(true);
    expect(Object.isFrozen(plan.expected.sources)).toBe(true);
    expect(Object.isFrozen(plan.expected.sources[0]?.record)).toBe(true);
    expect(Object.isFrozen(plan.destinations)).toBe(true);
    expect(Object.isFrozen(plan.destinations[0]?.record)).toBe(true);
    expect(Object.isFrozen(plan.sourceTombstones[0]?.record)).toBe(true);
    expect(Object.isFrozen(plan.requestedSettings)).toBe(true);
    expect(
      Object.isFrozen(plan.requestedSettings.pageIdentityExclusions[0]),
    ).toBe(true);
    expect(
      Object.isFrozen(
        plan.requestedSettings.pageIdentityExclusions[0]?.parameterNames,
      ),
    ).toBe(true);
    expect(Object.isFrozen(source)).toBe(false);
    expect(Object.isFrozen(currentSettings)).toBe(false);
    expect(Object.isFrozen(requestedSettings)).toBe(false);
    expect(() => {
      (plan.destinations as unknown as unknown[]).push(source);
    }).toThrow();
  });
});

describe('persisted identity migration boundary', () => {
  it('exports canonical async settings/note fingerprints and parses JSON round trips into deeply frozen safe clones without identity dependencies', async () => {
    const currentSettings = settings();
    const requestedSettings = settings([
      {
        origin: 'HTTPS://EXAMPLE.COM:443/',
        parameterNames: ['Variant'],
      },
    ]);
    const normalizedRequestedSettings = settings([
      { origin: ORIGIN, parameterNames: ['variant'] },
    ]);
    const source = await note(`${ORIGIN}/article?variant=one`, currentSettings);

    expect(await fingerprintIdentityMigrationSettings(requestedSettings)).toBe(
      settingsFingerprint(normalizedRequestedSettings),
    );
    expect(await fingerprintIdentityMigrationNote(source)).toBe(
      noteFingerprint(source),
    );

    const plan = await planIdentityMigration(
      plannerHarness({
        currentSettings,
        requestedSettings,
        records: [source],
      }).input,
    );

    requirePlanned(plan);
    const persisted: unknown = JSON.parse(JSON.stringify(plan));
    const parsed = await parseIdentityMigrationPlan(persisted);

    expect(parsed).toEqual(plan);
    expect(parsed).not.toBe(plan);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(
      parsed.status === 'planned' &&
        Object.isFrozen(parsed.expected.sources[0]?.record) &&
        Object.isFrozen(parsed.requestedSettings.pageIdentityExclusions),
    ).toBe(true);
    expect(
      await parseIdentityMigrationPlan(
        JSON.parse(
          JSON.stringify({
            schemaVersion: IDENTITY_MIGRATION_PLAN_SCHEMA_VERSION,
            status: 'no-op',
            reason: 'already-applied',
          }),
        ),
      ),
    ).toEqual({
      schemaVersion: IDENTITY_MIGRATION_PLAN_SCHEMA_VERSION,
      status: 'no-op',
      reason: 'already-applied',
    });
  });

  it('rejects future schemas and adversarial corruption across every durable field family', async () => {
    const currentSettings = settings();
    const requestedSettings = settings([
      { origin: ORIGIN, parameterNames: ['variant'] },
    ]);
    const first = await note(`${ORIGIN}/a?variant=one`, currentSettings, {
      revisionId: 'source-a',
    });
    const second = await note(`${ORIGIN}/b?variant=two`, currentSettings, {
      revisionId: 'source-b',
    });
    const plan = await planIdentityMigration(
      plannerHarness({
        currentSettings,
        requestedSettings,
        records: [second, first],
      }).input,
    );

    requirePlanned(plan);
    const corruptions: readonly [string, (candidate: unknown) => void][] = [
      [
        'future schema',
        (candidate) => {
          mutableObject(candidate).schemaVersion = 2;
        },
      ],
      [
        'extra root key',
        (candidate) => {
          mutableObject(candidate).unexpected = true;
        },
      ],
      [
        'missing root key',
        (candidate) => {
          delete mutableObject(candidate).operationId;
        },
      ],
      [
        'wrong status',
        (candidate) => {
          mutableObject(candidate).status = 'running';
        },
      ],
      [
        'wrong phase',
        (candidate) => {
          mutableObject(candidate).phase = 'writing';
        },
      ],
      [
        'malformed operation id',
        (candidate) => {
          mutableObject(candidate).operationId = ' operation ';
        },
      ],
      [
        'malformed planned timestamp',
        (candidate) => {
          mutableObject(candidate).plannedAt = 'yesterday';
        },
      ],
      [
        'extra change key',
        (candidate) => {
          mutableObject(mutableObject(candidate).change).extra = true;
        },
      ],
      [
        'change transition mismatch',
        (candidate) => {
          mutableObject(mutableObject(candidate).change).parameterName =
            'different';
        },
      ],
      [
        'noncanonical requested settings',
        (candidate) => {
          const requested = mutableObject(
            mutableObject(candidate).requestedSettings,
          );
          const rules = mutableArray(requested.pageIdentityExclusions);
          const rule = mutableObject(rules[0]);
          mutableArray(rule.parameterNames)[0] = 'VARIANT';
        },
      ],
      [
        'invalid settings transition',
        (candidate) => {
          const requested = mutableObject(
            mutableObject(candidate).requestedSettings,
          );
          requested.pageIdentityExclusions = [];
        },
      ],
      [
        'settings fingerprint mismatch',
        (candidate) => {
          const expected = mutableObject(mutableObject(candidate).expected);
          mutableObject(expected.settings).fingerprint =
            independentHash('wrong settings');
        },
      ],
      [
        'source fingerprint mismatch',
        (candidate) => {
          const expected = mutableObject(mutableObject(candidate).expected);
          const source = mutableObject(mutableArray(expected.sources)[0]);
          source.fingerprint = independentHash('wrong source');
        },
      ],
      [
        'unsorted expected sources',
        (candidate) => {
          const expected = mutableObject(mutableObject(candidate).expected);
          mutableArray(expected.sources).reverse();
        },
      ],
      [
        'duplicate expected source key',
        (candidate) => {
          const expected = mutableObject(mutableObject(candidate).expected);
          const sources = mutableArray(expected.sources);
          sources.push(jsonCopy(sources[0]));
        },
      ],
      [
        'invalid source canonical hash',
        (candidate) => {
          const expected = mutableObject(mutableObject(candidate).expected);
          const source = mutableObject(mutableArray(expected.sources)[0]);
          mutableObject(source.record).canonicalUrl = `${ORIGIN}/wrong`;
        },
      ],
      [
        'invalid destination content hash',
        (candidate) => {
          const destination = mutableObject(
            mutableArray(mutableObject(candidate).destinations)[0],
          );
          mutableObject(destination.record).contentHash =
            independentHash('wrong content');
        },
      ],
      [
        'unnormalized destination content',
        (candidate) => {
          const destination = mutableObject(
            mutableArray(mutableObject(candidate).destinations)[0],
          );
          const record = mutableObject(destination.record);
          const contentHtml = ` \r\n${String(record.contentHtml)}\r\n `;
          record.contentHtml = contentHtml;
          record.contentHash = independentHash(contentHtml);
        },
      ],
      [
        'destination expected fingerprint mismatch',
        (candidate) => {
          const destination = mutableObject(
            mutableArray(mutableObject(candidate).destinations)[0],
          );
          destination.expectedRecordFingerprint = independentHash(
            'unexpected destination',
          );
        },
      ],
      [
        'unsorted destinations',
        (candidate) => {
          mutableArray(mutableObject(candidate).destinations).reverse();
        },
      ],
      [
        'duplicate destination key',
        (candidate) => {
          const destinations = mutableArray(
            mutableObject(candidate).destinations,
          );
          destinations.push(jsonCopy(destinations[0]));
        },
      ],
      [
        'inconsistent destination plannedAt',
        (candidate) => {
          const destination = mutableObject(
            mutableArray(mutableObject(candidate).destinations)[0],
          );
          mutableObject(destination.record).savedAt =
            '2026-07-25T12:34:56.000Z';
        },
      ],
      [
        'unsorted tombstones',
        (candidate) => {
          mutableArray(mutableObject(candidate).sourceTombstones).reverse();
        },
      ],
      [
        'inconsistent tombstone deletion',
        (candidate) => {
          const tombstone = mutableObject(
            mutableArray(mutableObject(candidate).sourceTombstones)[0],
          );
          mutableObject(tombstone.record).deletedAt =
            '2026-07-25T12:34:56.000Z';
        },
      ],
      [
        'tombstone fingerprint mismatch',
        (candidate) => {
          const tombstone = mutableObject(
            mutableArray(mutableObject(candidate).sourceTombstones)[0],
          );
          tombstone.expectedRecordFingerprint = independentHash(
            'wrong tombstone source',
          );
        },
      ],
      [
        'duplicate write revision',
        (candidate) => {
          const root = mutableObject(candidate);
          const destination = mutableObject(mutableArray(root.destinations)[0]);
          const tombstone = mutableObject(
            mutableArray(root.sourceTombstones)[0],
          );
          mutableObject(tombstone.record).revisionId = mutableObject(
            destination.record,
          ).revisionId;
        },
      ],
      [
        'malformed write revision',
        (candidate) => {
          const destination = mutableObject(
            mutableArray(mutableObject(candidate).destinations)[0],
          );
          mutableObject(destination.record).revisionId = 'revision\ninjection';
        },
      ],
      [
        'extra nested note key',
        (candidate) => {
          const destination = mutableObject(
            mutableArray(mutableObject(candidate).destinations)[0],
          );
          mutableObject(destination.record).unexpected = true;
        },
      ],
    ];

    for (const [label, corrupt] of corruptions) {
      const candidate = jsonCopy(plan);
      corrupt(candidate);
      expect(label).not.toBe('');
      await expectPlanError(
        parseIdentityMigrationPlan(candidate),
        'invalid-plan',
      );
    }

    await expectPlanError(
      parseIdentityMigrationPlan({
        schemaVersion: IDENTITY_MIGRATION_PLAN_SCHEMA_VERSION,
        status: 'no-op',
        reason: 'already-applied',
        extra: true,
      }),
      'invalid-plan',
    );
  });
});

describe('planIdentityMigration validation', () => {
  it.each([
    ['non-http scheme', 'ftp://example.com', 'variant'],
    ['origin path', `${ORIGIN}/path`, 'variant'],
    ['origin credentials', 'https://user:secret@example.com', 'variant'],
    ['origin whitespace', ` ${ORIGIN}`, 'variant'],
    ['origin empty query', `${ORIGIN}?`, 'variant'],
    ['origin empty fragment', `${ORIGIN}#`, 'variant'],
    ['empty name', ORIGIN, ''],
    ['built-in exact name', ORIGIN, 'GCLID'],
    ['built-in prefix name', ORIGIN, 'UTM_campaign'],
  ])(
    'rejects malformed settings: %s',
    async (_label, origin, parameterName) => {
      const harness = plannerHarness({
        currentSettings: settings(),
        requestedSettings: settings([
          { origin, parameterNames: [parameterName] },
        ]),
        records: [],
      });

      await expectPlanError(
        planIdentityMigration(harness.input),
        'invalid-settings',
      );
    },
  );

  it('rejects duplicate case-insensitive names, duplicate normalized origins, and extra rule keys', async () => {
    const invalidRequestedSettings = [
      settings([{ origin: ORIGIN, parameterNames: ['variant', 'VARIANT'] }]),
      settings([
        { origin: ORIGIN, parameterNames: ['variant'] },
        {
          origin: 'HTTPS://EXAMPLE.COM:443/',
          parameterNames: ['session'],
        },
      ]),
      settings([
        {
          origin: ORIGIN,
          parameterNames: ['variant'],
          extra: true,
        } as PageIdentityExclusionRule,
      ]),
    ];

    for (const requestedSettings of invalidRequestedSettings) {
      await expectPlanError(
        planIdentityMigration(
          plannerHarness({
            currentSettings: settings(),
            requestedSettings,
            records: [],
          }).input,
        ),
        'invalid-settings',
      );
    }
  });

  it('rejects invalid schema/BYOS shapes even when the rule change itself is valid', async () => {
    const requestedRule = [{ origin: ORIGIN, parameterNames: ['variant'] }];
    const invalidRequestedSettings = [
      {
        ...settings(requestedRule),
        schemaVersion: 2,
      } as unknown as SettingsRecordV1,
      {
        ...settings(requestedRule),
        byosConnection: {
          accessToken: 'token',
          expiresAt: PLANNED_AT,
          connectedAt: PLANNED_AT,
          extra: true,
        },
      } as unknown as SettingsRecordV1,
    ];

    for (const requestedSettings of invalidRequestedSettings) {
      await expectPlanError(
        planIdentityMigration(
          plannerHarness({
            currentSettings: settings(),
            requestedSettings,
            records: [],
          }).input,
        ),
        'invalid-settings',
      );
    }
  });

  it.each([
    [
      'multiple names',
      settings(),
      settings([{ origin: ORIGIN, parameterNames: ['variant', 'session'] }]),
    ],
    [
      'cross-origin move',
      settings([{ origin: ORIGIN, parameterNames: ['variant'] }]),
      settings([{ origin: OTHER_ORIGIN, parameterNames: ['variant'] }]),
    ],
    [
      'editor mode',
      settings(),
      settings([{ origin: ORIGIN, parameterNames: ['variant'] }], {
        editorMode: 'paragraphs-only',
      }),
    ],
    [
      'BYOS connection',
      settings(),
      settings([{ origin: ORIGIN, parameterNames: ['variant'] }], {
        byosConnection: {
          accessToken: 'token',
          expiresAt: '2026-08-01T00:00:00.000Z',
          connectedAt: '2026-07-01T00:00:00.000Z',
        },
      }),
    ],
  ])(
    'rejects unrelated or non-atomic settings changes: %s',
    async (_label, currentSettings, requestedSettings) => {
      await expectPlanError(
        planIdentityMigration(
          plannerHarness({
            currentSettings,
            requestedSettings,
            records: [],
          }).input,
        ),
        'invalid-settings-change',
      );
    },
  );

  it('rejects records with mismatched hashes, live tombstone content, duplicate keys, or malformed shape', async () => {
    const currentSettings = settings();
    const requestedSettings = settings([
      { origin: ORIGIN, parameterNames: ['variant'] },
    ]);
    const valid = await note(`${ORIGIN}/article?variant=one`, currentSettings);
    const invalidRecordSets: readonly (readonly NoteRecordV1[])[] = [
      [{ ...valid, pageKey: independentHash('wrong canonical') }],
      [{ ...valid, contentHash: independentHash('wrong content') }],
      [
        {
          ...valid,
          deletedAt: PLANNED_AT,
        },
      ],
      [valid, { ...valid }],
      [
        {
          ...valid,
          schemaVersion: 2,
        } as unknown as NoteRecordV1,
      ],
    ];

    for (const records of invalidRecordSets) {
      await expectPlanError(
        planIdentityMigration(
          plannerHarness({
            currentSettings,
            requestedSettings,
            records,
          }).input,
        ),
        'invalid-record',
      );
    }
  });

  it('rejects a stored record whose representative no longer derives its current canonical identity', async () => {
    const currentSettings = settings();
    const requestedSettings = settings([
      { origin: ORIGIN, parameterNames: ['variant'] },
    ]);
    const record = await note(
      `${ORIGIN}/article?variant=one`,
      currentSettings,
      {
        representativeUrl: `${ORIGIN}/different?variant=one`,
      },
    );

    await expectPlanError(
      planIdentityMigration(
        plannerHarness({
          currentSettings,
          requestedSettings,
          records: [record],
        }).input,
      ),
      'mismatched-identity',
    );
  });

  it('strictly rejects malformed injected identities and contains throwing result/identity getters as typed failures', async () => {
    const currentSettings = settings();
    const requestedSettings = settings([
      { origin: ORIGIN, parameterNames: ['variant'] },
    ]);
    const record = await note(`${ORIGIN}/article?variant=one`, currentSettings);
    const validIdentity = await supportedIdentity(record.representativeUrl);
    const serviceFor = (result: unknown): PageIdentityService =>
      ({
        builtInExclusions: BUILT_IN_PAGE_IDENTITY_EXCLUSIONS,
        identify: () => Promise.resolve(result),
      }) as unknown as PageIdentityService;
    const throwingStatus = Object.defineProperty({}, 'status', {
      enumerable: true,
      get() {
        throw new Error('status getter failed');
      },
    });
    const throwingIdentity = Object.defineProperty(
      { status: 'supported' },
      'identity',
      {
        enumerable: true,
        get() {
          throw new Error('identity getter failed');
        },
      },
    );
    const services: readonly [
      PageIdentityService,
      IdentityMigrationPlanError['code'],
    ][] = [
      [
        {
          builtInExclusions: BUILT_IN_PAGE_IDENTITY_EXCLUSIONS,
          identify: () =>
            Promise.resolve({ status: 'unsupported', reason: 'invalid-url' }),
        },
        'unsupported-identity',
      ],
      [
        {
          builtInExclusions: BUILT_IN_PAGE_IDENTITY_EXCLUSIONS,
          identify: () => Promise.reject(new Error('injected failure')),
        },
        'identity-failure',
      ],
      [
        {
          builtInExclusions: BUILT_IN_PAGE_IDENTITY_EXCLUSIONS,
          async identify() {
            const identity = await supportedIdentity(record.representativeUrl);

            return {
              status: 'supported',
              identity: {
                ...identity,
                pageKey: independentHash('wrong identity'),
              },
            };
          },
        },
        'mismatched-identity',
      ],
      [
        serviceFor({
          status: 'supported',
          identity: validIdentity,
          extra: true,
        }),
        'mismatched-identity',
      ],
      [
        serviceFor({
          status: 'supported',
          identity: { ...validIdentity, extra: true },
        }),
        'mismatched-identity',
      ],
      [
        serviceFor({
          status: 'unsupported',
          reason: 'invalid-url',
          extra: true,
        }),
        'mismatched-identity',
      ],
      [
        serviceFor({
          status: 'supported',
          identity: identityForCanonical(`${ORIGIN}/article?`),
        }),
        'mismatched-identity',
      ],
      [
        serviceFor({
          status: 'supported',
          identity: identityForCanonical(`${ORIGIN}/article#`),
        }),
        'mismatched-identity',
      ],
      [
        serviceFor({
          status: 'supported',
          identity: identityForCanonical(
            'https://user:secret@example.com/article',
          ),
        }),
        'mismatched-identity',
      ],
      [
        serviceFor({
          status: 'supported',
          identity: identityForCanonical(`${ORIGIN}/article#fragment`),
        }),
        'mismatched-identity',
      ],
      [
        serviceFor({
          status: 'supported',
          identity: identityForCanonical('https://EXAMPLE.com/article'),
        }),
        'mismatched-identity',
      ],
      [serviceFor(throwingStatus), 'identity-failure'],
      [serviceFor(throwingIdentity), 'identity-failure'],
    ];

    for (const [pageIdentityService, code] of services) {
      await expectPlanError(
        planIdentityMigration(
          plannerHarness(
            {
              currentSettings,
              requestedSettings,
              records: [record],
            },
            { pageIdentityService },
          ).input,
        ),
        code,
      );
    }
  });

  it('rejects malformed built-ins and missing service dependencies', async () => {
    const currentSettings = settings();
    const requestedSettings = settings([
      { origin: ORIGIN, parameterNames: ['variant'] },
    ]);
    const malformedBuiltIns = {
      builtInExclusions: {
        exactParameterNames: [null],
        parameterNamePrefixes: ['utm_'],
      },
      identify: () =>
        Promise.resolve({ status: 'unsupported', reason: 'invalid-url' }),
    } as unknown as PageIdentityService;

    await expectPlanError(
      planIdentityMigration(
        plannerHarness(
          { currentSettings, requestedSettings, records: [] },
          { pageIdentityService: malformedBuiltIns },
        ).input,
      ),
      'invalid-dependency',
    );
    await expectPlanError(
      planIdentityMigration({
        ...plannerHarness({
          currentSettings,
          requestedSettings,
          records: [],
        }).input,
        pageIdentityService: null,
      } as unknown as IdentityMigrationPlannerInput),
      'invalid-dependency',
    );
  });

  it('does not consume time or identifiers for invalid settings, records, or identities', async () => {
    const invalidSettingsHarness = plannerHarness({
      currentSettings: settings(),
      requestedSettings: settings([
        {
          origin: ORIGIN,
          parameterNames: ['variant', 'session'],
        },
      ]),
      records: [],
    });

    await expectPlanError(
      planIdentityMigration(invalidSettingsHarness.input),
      'invalid-settings-change',
    );
    expect(invalidSettingsHarness.clock).not.toHaveBeenCalled();
    expect(invalidSettingsHarness.operationIdFactory).not.toHaveBeenCalled();
    expect(invalidSettingsHarness.revisionIdFactory).not.toHaveBeenCalled();

    const currentSettings = settings();
    const requestedSettings = settings([
      { origin: ORIGIN, parameterNames: ['variant'] },
    ]);
    const valid = await note(`${ORIGIN}/article?variant=one`, currentSettings);
    const invalidRecordHarness = plannerHarness({
      currentSettings,
      requestedSettings,
      records: [
        {
          ...valid,
          contentHash: independentHash('wrong'),
        },
      ],
    });

    await expectPlanError(
      planIdentityMigration(invalidRecordHarness.input),
      'invalid-record',
    );
    expect(invalidRecordHarness.clock).not.toHaveBeenCalled();
    expect(invalidRecordHarness.operationIdFactory).not.toHaveBeenCalled();
    expect(invalidRecordHarness.revisionIdFactory).not.toHaveBeenCalled();

    const identityHarness = plannerHarness(
      {
        currentSettings,
        requestedSettings,
        records: [valid],
      },
      {
        pageIdentityService: {
          builtInExclusions: BUILT_IN_PAGE_IDENTITY_EXCLUSIONS,
          identify: () => Promise.reject(new Error('identity failed')),
        },
      },
    );

    await expectPlanError(
      planIdentityMigration(identityHarness.input),
      'identity-failure',
    );
    expect(identityHarness.clock).not.toHaveBeenCalled();
    expect(identityHarness.operationIdFactory).not.toHaveBeenCalled();
    expect(identityHarness.revisionIdFactory).not.toHaveBeenCalled();
  });

  it('surfaces hashing failures directly without consuming time or identifiers', async () => {
    const currentSettings = settings();
    const requestedSettings = settings([
      { origin: ORIGIN, parameterNames: ['variant'] },
    ]);
    const harness = plannerHarness({
      currentSettings,
      requestedSettings,
      records: [],
    });
    const digest = vi
      .spyOn(globalThis.crypto.subtle, 'digest')
      .mockRejectedValue(new Error('injected digest failure'));

    try {
      await expectPlanError(
        planIdentityMigration(harness.input),
        'hash-failure',
      );
    } finally {
      digest.mockRestore();
    }

    expect(harness.clock).not.toHaveBeenCalled();
    expect(harness.operationIdFactory).not.toHaveBeenCalled();
    expect(harness.revisionIdFactory).not.toHaveBeenCalled();
  });

  it.each([
    [
      'clock throw',
      {
        clock: () => {
          throw new Error('clock failed');
        },
      },
    ],
    ['invalid date', { clock: () => new Date(Number.NaN) }],
    [
      'operation throw',
      {
        operationIdFactory: () => {
          throw new Error('operation failed');
        },
      },
    ],
    ['empty operation', { operationIdFactory: () => '' }],
  ])(
    'rejects injected operation dependency failure: %s',
    async (_label, overrides) => {
      const currentSettings = settings();
      const requestedSettings = settings([
        { origin: ORIGIN, parameterNames: ['variant'] },
      ]);

      await expectPlanError(
        planIdentityMigration(
          plannerHarness(
            { currentSettings, requestedSettings, records: [] },
            overrides,
          ).input,
        ),
        'dependency-failure',
      );
    },
  );

  it('rejects throwing, empty, and duplicate injected revision IDs', async () => {
    const currentSettings = settings();
    const requestedSettings = settings([
      { origin: ORIGIN, parameterNames: ['variant'] },
    ]);
    const record = await note(`${ORIGIN}/article?variant=one`, currentSettings);
    const revisionFactories = [
      () => {
        throw new Error('revision failed');
      },
      () => '',
      () => 'duplicate-revision',
    ];

    for (const revisionIdFactory of revisionFactories) {
      await expectPlanError(
        planIdentityMigration(
          plannerHarness(
            {
              currentSettings,
              requestedSettings,
              records: [record],
            },
            { revisionIdFactory },
          ).input,
        ),
        'dependency-failure',
      );
    }
  });
});
