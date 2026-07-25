import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { NoteRecordV1 } from '../domain/note';
import type { PageIdentityExclusionRule } from '../domain/pageIdentity';
import type { SettingsRecordV1 } from '../domain/settings';
import { InMemoryChromeStorage } from '../../test/inMemoryChromeStorage';
import {
  type PlannedIdentityMigration,
  planIdentityMigration,
} from '../services/identityMigration';
import {
  createIdentityMigrationJournal,
  IDENTITY_MIGRATION_JOURNAL_STORAGE_KEY,
  parseIdentityMigrationJournal,
  type IdentityMigrationJournalV1,
} from '../services/identityMigrationPersistence';
import { ChromeLocalIdentityMigrationPersistence } from './chromeLocalIdentityMigrationPersistence';
import {
  getNoteOriginIndexStorageKey,
  getNoteStorageKey,
} from './chromeLocalNoteRepository';
import { SETTINGS_STORAGE_KEY } from './chromeLocalSettingsRepository';
import { DefaultPageIdentityService } from '../services/pageIdentity';

const ORIGIN = 'https://example.com';
const OTHER_ORIGIN = 'https://other.example';
const PLANNED_AT = '2026-07-25T12:00:00.000Z';
const CONTENT =
  '<!-- wp:paragraph -->\n<p>Stored note</p>\n<!-- /wp:paragraph -->';

function hash(value: string): string {
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

async function note(
  rawUrl: string,
  currentSettings: SettingsRecordV1,
  overrides: Partial<NoteRecordV1> = {},
): Promise<NoteRecordV1> {
  const result = await new DefaultPageIdentityService().identify(
    rawUrl,
    currentSettings.pageIdentityExclusions,
  );

  if (result.status !== 'supported') {
    throw new Error('Expected a supported note fixture URL.');
  }

  const contentHtml =
    overrides.contentHtml ?? (overrides.deletedAt === undefined ? CONTENT : '');

  return {
    schemaVersion: 1,
    pageKey: result.identity.pageKey,
    canonicalUrl: result.identity.canonicalUrl,
    representativeUrl: new URL(rawUrl).href,
    origin: result.identity.origin,
    title: 'Stored title',
    contentHtml,
    contentHash: hash(contentHtml),
    savedAt: '2026-07-24T10:00:00.000Z',
    revisionId: 'stored-revision',
    ...overrides,
  };
}

async function plannedMigration(
  currentSettings: SettingsRecordV1,
  requestedSettings: SettingsRecordV1,
  records: readonly NoteRecordV1[],
): Promise<PlannedIdentityMigration> {
  let revision = 0;
  const plan = await planIdentityMigration({
    currentSettings,
    requestedSettings,
    records,
    clock: () => new Date(PLANNED_AT),
    operationIdFactory: () => 'operation-1',
    revisionIdFactory: () => `planned-revision-${(revision += 1)}`,
    pageIdentityService: new DefaultPageIdentityService(),
  });

  if (plan.status !== 'planned') {
    throw new Error('Expected a planned fixture migration.');
  }

  return plan;
}

function originIndex(
  origin: string,
  pageKeys: readonly string[],
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    origin,
    pageKeys,
  };
}

function seededStorage(
  currentSettings: SettingsRecordV1 | undefined,
  records: readonly NoteRecordV1[],
  indexPageKeys: readonly string[] | undefined = records
    .filter((record) => record.origin === ORIGIN)
    .map((record) => record.pageKey),
): InMemoryChromeStorage {
  const values: Record<string, unknown> = {};

  if (currentSettings !== undefined) {
    values[SETTINGS_STORAGE_KEY] = currentSettings;
  }

  for (const record of records) {
    values[getNoteStorageKey(record.pageKey)] = record;
  }

  if (indexPageKeys !== undefined) {
    values[getNoteOriginIndexStorageKey(ORIGIN)] = originIndex(
      ORIGIN,
      indexPageKeys,
    );
  }

  return new InMemoryChromeStorage(values);
}

async function readJournal(
  storage: InMemoryChromeStorage,
): Promise<IdentityMigrationJournalV1 | undefined> {
  const value = storage.snapshot()[IDENTITY_MIGRATION_JOURNAL_STORAGE_KEY];

  return value === undefined
    ? undefined
    : await parseIdentityMigrationJournal(value);
}

describe('identity migration journal envelope', () => {
  it('strictly round-trips and freezes one versioned planned journal', async () => {
    const current = settings();
    const requested = settings([
      { origin: ORIGIN, parameterNames: ['variant'] },
    ]);
    const source = await note(`${ORIGIN}/a?variant=one`, current);
    const plan = await plannedMigration(current, requested, [source]);
    const journal = await createIdentityMigrationJournal(plan);
    const parsed = await parseIdentityMigrationJournal(
      JSON.parse(JSON.stringify(journal)),
    );

    expect(parsed).toEqual(journal);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.plan.destinations)).toBe(true);
  });

  it.each([
    [
      'future',
      {
        schemaVersion: 2,
        operationId: 'operation',
        phase: 'planned',
        plan: {},
      },
      'future-schema',
    ],
    [
      'extra-key',
      {
        schemaVersion: 1,
        operationId: 'operation',
        phase: 'planned',
        plan: {},
        extra: true,
      },
      'malformed',
    ],
    [
      'invalid-phase',
      {
        schemaVersion: 1,
        operationId: 'operation',
        phase: 'writing',
        plan: {},
      },
      'malformed',
    ],
  ])('rejects a %s envelope', async (_label, value, kind) => {
    await expect(parseIdentityMigrationJournal(value)).rejects.toMatchObject({
      name: 'IdentityMigrationJournalError',
      kind,
    });
  });
});

describe('ChromeLocalIdentityMigrationPersistence', () => {
  it('loads absent defaults without writing and explicitly persists understood v0 settings before planning', async () => {
    const emptyStorage = new InMemoryChromeStorage();
    const emptyPersistence = new ChromeLocalIdentityMigrationPersistence(
      emptyStorage,
    );

    await expect(emptyPersistence.loadPlanningSnapshot()).resolves.toEqual({
      settings: settings(),
      records: [],
    });
    expect(emptyStorage.setCalls).toEqual([]);

    const legacyStorage = new InMemoryChromeStorage({
      [SETTINGS_STORAGE_KEY]: {
        schemaVersion: 0,
        editorMode: 'paragraphs-only',
      },
    });
    const legacyPersistence = new ChromeLocalIdentityMigrationPersistence(
      legacyStorage,
    );

    await expect(legacyPersistence.loadPlanningSnapshot()).resolves.toEqual({
      settings: settings([], { editorMode: 'paragraphs-only' }),
      records: [],
    });
    expect(legacyStorage.snapshot()[SETTINGS_STORAGE_KEY]).toEqual(
      settings([], { editorMode: 'paragraphs-only' }),
    );
  });

  it('CAS-begins exactly one journal across adapter instances and repairs a valid dangling index in the same write', async () => {
    const current = settings();
    const requested = settings([
      { origin: ORIGIN, parameterNames: ['variant'] },
    ]);
    const source = await note(`${ORIGIN}/a?variant=one`, current);
    const plan = await plannedMigration(current, requested, [source]);
    const journal = await createIdentityMigrationJournal(plan);
    const storage = seededStorage(
      current,
      [source],
      [source.pageKey, hash('dangling')],
    );
    const first = new ChromeLocalIdentityMigrationPersistence(storage);
    const second = new ChromeLocalIdentityMigrationPersistence(storage);
    const results = await Promise.allSettled([
      first.beginJournal(journal),
      second.beginJournal(journal),
    ]);

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(
      1,
    );
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(
      1,
    );
    expect(
      (
        storage.snapshot()[getNoteOriginIndexStorageKey(ORIGIN)] as {
          pageKeys: string[];
        }
      ).pageKeys,
    ).toEqual([source.pageKey]);
    expect(await readJournal(storage)).toEqual(journal);
  });

  it('applies destination, tombstone, settings, index, and final removal in durable idempotent phases while isolating other origins', async () => {
    const current = settings();
    const requested = settings([
      { origin: ORIGIN, parameterNames: ['variant'] },
    ]);
    const source = await note(`${ORIGIN}/a?variant=one`, current);
    const outside = await note(`${OTHER_ORIGIN}/b?variant=one`, current);
    const plan = await plannedMigration(current, requested, [outside, source]);
    const journal = await createIdentityMigrationJournal(plan);
    const storage = seededStorage(current, [outside, source]);
    const persistence = new ChromeLocalIdentityMigrationPersistence(storage);

    await persistence.beginJournal(journal);
    let advanced = await persistence.applyDestinations(journal);
    expect(advanced.phase).toBe('destinations-applied');
    expect(
      storage.snapshot()[
        getNoteStorageKey(plan.destinations[0]?.record.pageKey ?? '')
      ],
    ).toEqual(plan.destinations[0]?.record);
    expect(storage.snapshot()[getNoteStorageKey(source.pageKey)]).toEqual(
      source,
    );

    storage.resetCalls();
    advanced = await persistence.applyDestinations(advanced);
    expect(storage.setCalls).toEqual([]);

    advanced = await persistence.applyTombstones(advanced);
    expect(advanced.phase).toBe('tombstones-applied');
    expect(storage.snapshot()[getNoteStorageKey(source.pageKey)]).toEqual(
      plan.sourceTombstones[0]?.record,
    );
    advanced = await persistence.applySettings(advanced);
    expect(advanced.phase).toBe('settings-applied');
    expect(storage.snapshot()[SETTINGS_STORAGE_KEY]).toEqual(
      plan.requestedSettings,
    );
    expect(storage.snapshot()[getNoteStorageKey(outside.pageKey)]).toEqual(
      outside,
    );

    await persistence.finalize(advanced);
    expect(
      storage.snapshot()[IDENTITY_MIGRATION_JOURNAL_STORAGE_KEY],
    ).toBeUndefined();
    const expectedIndexKeys = [
      ...plan.expected.sources.map(({ record }) => record.pageKey),
      ...plan.destinations
        .filter(
          ({ record }) =>
            !plan.expected.sources.some(
              (sourceRecord) => sourceRecord.record.pageKey === record.pageKey,
            ),
        )
        .map(({ record }) => record.pageKey),
    ].sort();
    expect(
      (
        storage.snapshot()[getNoteOriginIndexStorageKey(ORIGIN)] as {
          pageKeys: string[];
        }
      ).pageKeys,
    ).toEqual(expectedIndexKeys);
  });

  it('finishes a mixed partial destination phase by writing only missing outputs', async () => {
    const current = settings();
    const requested = settings([
      { origin: ORIGIN, parameterNames: ['variant'] },
    ]);
    const first = await note(`${ORIGIN}/a?variant=one`, current);
    const second = await note(`${ORIGIN}/b?variant=two`, current, {
      revisionId: 'second',
    });
    const plan = await plannedMigration(current, requested, [first, second]);
    const journal = await createIdentityMigrationJournal(plan);
    const storage = seededStorage(current, [first, second]);
    const persistence = new ChromeLocalIdentityMigrationPersistence(storage);

    await persistence.beginJournal(journal);
    const alreadyApplied = plan.destinations[0]?.record;

    if (alreadyApplied === undefined) {
      throw new Error('Expected two destination fixtures.');
    }

    await storage.set({
      [getNoteStorageKey(alreadyApplied.pageKey)]: alreadyApplied,
    });
    storage.resetCalls();
    await persistence.applyDestinations(journal);
    const destinationWrite = storage.setCalls[0] ?? {};

    expect(destinationWrite).not.toHaveProperty(
      getNoteStorageKey(alreadyApplied.pageKey),
    );
    expect(
      plan.destinations
        .slice(1)
        .every(({ record }) =>
          Object.prototype.hasOwnProperty.call(
            destinationWrite,
            getNoteStorageKey(record.pageKey),
          ),
        ),
    ).toBe(true);
  });

  it.each(['settings', 'changed-note', 'missing-note', 'extra-note'] as const)(
    'detects %s CAS drift before phase mutation',
    async (kind) => {
      const current = settings();
      const requested = settings([
        { origin: ORIGIN, parameterNames: ['variant'] },
      ]);
      const source = await note(`${ORIGIN}/a?variant=one`, current);
      const plan = await plannedMigration(current, requested, [source]);
      const journal = await createIdentityMigrationJournal(plan);
      const storage = seededStorage(current, [source]);
      const persistence = new ChromeLocalIdentityMigrationPersistence(storage);

      await persistence.beginJournal(journal);

      if (kind === 'settings') {
        await storage.set({
          [SETTINGS_STORAGE_KEY]: settings([], {
            editorMode: 'paragraphs-only',
          }),
        });
      } else if (kind === 'changed-note') {
        const changedContent =
          '<!-- wp:paragraph -->\n<p>Concurrent edit</p>\n<!-- /wp:paragraph -->';
        await storage.set({
          [getNoteStorageKey(source.pageKey)]: {
            ...source,
            contentHtml: changedContent,
            contentHash: hash(changedContent),
            revisionId: 'concurrent',
          },
        });
      } else if (kind === 'missing-note') {
        await storage.remove(getNoteStorageKey(source.pageKey));
      } else {
        const extra = await note(`${ORIGIN}/extra`, current, {
          revisionId: 'extra',
        });
        await storage.set({
          [getNoteStorageKey(extra.pageKey)]: extra,
        });
      }

      storage.resetCalls();
      await expect(
        persistence.applyDestinations(journal),
      ).rejects.toMatchObject({
        name: 'IdentityMigrationPersistenceError',
        code: 'conflict',
      });
      expect(storage.setCalls).toEqual([]);
      expect(await readJournal(storage)).toEqual(journal);
    },
  );

  it.each([
    [
      'malformed journal',
      IDENTITY_MIGRATION_JOURNAL_STORAGE_KEY,
      { schemaVersion: 1, partial: true },
    ],
    [
      'future journal',
      IDENTITY_MIGRATION_JOURNAL_STORAGE_KEY,
      { schemaVersion: 9, future: true },
    ],
    [
      'malformed settings',
      SETTINGS_STORAGE_KEY,
      { schemaVersion: 1, editorMode: 'unknown' },
    ],
    [
      'future settings',
      SETTINGS_STORAGE_KEY,
      { schemaVersion: 9, editorMode: 'future' },
    ],
    [
      'malformed note',
      `${getNoteStorageKey(hash('malformed'))}`,
      { schemaVersion: 1, partial: true },
    ],
    [
      'future note',
      `${getNoteStorageKey(hash('future-note'))}`,
      {
        schemaVersion: 9,
        pageKey: hash('future-note'),
        future: true,
      },
    ],
  ])('preserves and reports %s for recovery', async (_label, key, value) => {
    const storage = new InMemoryChromeStorage({ [key]: value });
    const persistence = new ChromeLocalIdentityMigrationPersistence(storage);

    await expect(
      key === IDENTITY_MIGRATION_JOURNAL_STORAGE_KEY
        ? persistence.loadJournal()
        : persistence.loadPlanningSnapshot(),
    ).rejects.toMatchObject({
      name: 'IdentityMigrationPersistenceError',
      code: 'recovery-required',
    });
    expect(storage.snapshot()[key]).toEqual(value);
    expect(storage.removeCalls).toEqual([]);
  });

  it.each([
    ['malformed', (pageKey: string) => originIndex(ORIGIN, [pageKey, pageKey])],
    [
      'future',
      (pageKey: string) => ({
        schemaVersion: 9,
        origin: ORIGIN,
        pageKeys: [pageKey],
      }),
    ],
  ])(
    'never overwrites a %s affected index before begin',
    async (_label, makeInvalidIndex) => {
      const current = settings();
      const requested = settings([
        { origin: ORIGIN, parameterNames: ['variant'] },
      ]);
      const source = await note(`${ORIGIN}/a?variant=one`, current);
      const plan = await plannedMigration(current, requested, [source]);
      const journal = await createIdentityMigrationJournal(plan);
      const invalidIndex = makeInvalidIndex(source.pageKey);
      const storage = seededStorage(current, [source], undefined);
      await storage.set({
        [getNoteOriginIndexStorageKey(ORIGIN)]: invalidIndex,
      });
      storage.resetCalls();
      const persistence = new ChromeLocalIdentityMigrationPersistence(storage);

      await expect(persistence.beginJournal(journal)).rejects.toMatchObject({
        code: 'recovery-required',
      });
      expect(storage.snapshot()[getNoteOriginIndexStorageKey(ORIGIN)]).toEqual(
        invalidIndex,
      );
      expect(
        storage.snapshot()[IDENTITY_MIGRATION_JOURNAL_STORAGE_KEY],
      ).toBeUndefined();
    },
  );

  it('preserves a journal and an affected index that becomes malformed during resume', async () => {
    const current = settings();
    const requested = settings([
      { origin: ORIGIN, parameterNames: ['variant'] },
    ]);
    const source = await note(`${ORIGIN}/a?variant=one`, current);
    const plan = await plannedMigration(current, requested, [source]);
    const journal = await createIdentityMigrationJournal(plan);
    const storage = seededStorage(current, [source]);
    const persistence = new ChromeLocalIdentityMigrationPersistence(storage);
    await persistence.beginJournal(journal);
    const malformedIndex = originIndex(ORIGIN, [
      source.pageKey,
      source.pageKey,
    ]);
    await storage.set({
      [getNoteOriginIndexStorageKey(ORIGIN)]: malformedIndex,
    });
    storage.resetCalls();

    await expect(persistence.applyDestinations(journal)).rejects.toMatchObject({
      code: 'recovery-required',
    });
    expect(storage.snapshot()[getNoteOriginIndexStorageKey(ORIGIN)]).toEqual(
      malformedIndex,
    );
    expect(await readJournal(storage)).toEqual(journal);
    expect(storage.setCalls).toEqual([]);
  });

  it('preserves the current journal and completed writes across set and removal failures', async () => {
    const current = settings();
    const requested = settings([
      { origin: ORIGIN, parameterNames: ['variant'] },
    ]);
    const source = await note(`${ORIGIN}/a?variant=one`, current);
    const plan = await plannedMigration(current, requested, [source]);
    const journal = await createIdentityMigrationJournal(plan);
    const storage = seededStorage(current, [source]);
    const persistence = new ChromeLocalIdentityMigrationPersistence(storage);

    storage.failNextSet();
    await expect(persistence.beginJournal(journal)).rejects.toMatchObject({
      code: 'storage-failure',
    });
    expect(await readJournal(storage)).toBeUndefined();

    await persistence.beginJournal(journal);
    storage.failNextSet();
    await expect(persistence.applyDestinations(journal)).rejects.toMatchObject({
      code: 'storage-failure',
    });
    expect((await readJournal(storage))?.phase).toBe('planned');

    let advanced = await persistence.applyDestinations(journal);
    advanced = await persistence.applyTombstones(advanced);
    advanced = await persistence.applySettings(advanced);
    storage.failNextRemove();
    await expect(persistence.finalize(advanced)).rejects.toMatchObject({
      code: 'storage-failure',
    });
    expect((await readJournal(storage))?.phase).toBe('settings-applied');
    await expect(persistence.finalize(advanced)).resolves.toBeUndefined();
  });

  it('never lets a stale operation remove another matching-key journal', async () => {
    const current = settings();
    const requested = settings([
      { origin: ORIGIN, parameterNames: ['variant'] },
    ]);
    const source = await note(`${ORIGIN}/a?variant=one`, current);
    const plan = await plannedMigration(current, requested, [source]);
    const journal = await createIdentityMigrationJournal(plan);
    const storage = seededStorage(current, [source]);
    const persistence = new ChromeLocalIdentityMigrationPersistence(storage);
    await persistence.beginJournal(journal);
    let advanced = await persistence.applyDestinations(journal);
    advanced = await persistence.applyTombstones(advanced);
    advanced = await persistence.applySettings(advanced);
    const stale = await createIdentityMigrationJournal({
      ...plan,
      operationId: 'stale-operation',
    });

    await expect(persistence.finalize(stale)).rejects.toMatchObject({
      code: 'stale-journal',
    });
    expect(await readJournal(storage)).toEqual(advanced);
    await persistence.finalize(advanced);
  });
});
