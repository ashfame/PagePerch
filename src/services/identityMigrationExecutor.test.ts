import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { NoteRecordV1 } from '../domain/note';
import type { PageIdentityExclusionRule } from '../domain/pageIdentity';
import type { SettingsRecordV1 } from '../domain/settings';
import { InMemoryChromeStorage } from '../../test/inMemoryChromeStorage';
import { ChromeLocalIdentityMigrationPersistence } from '../repositories/chromeLocalIdentityMigrationPersistence';
import {
  getNoteOriginIndexStorageKey,
  getNoteStorageKey,
} from '../repositories/chromeLocalNoteRepository';
import { SETTINGS_STORAGE_KEY } from '../repositories/chromeLocalSettingsRepository';
import {
  type PlannedIdentityMigration,
  planIdentityMigration,
} from './identityMigration';
import {
  IdentityMigrationExecutor,
  type IdentityMigrationExecutorDependencies,
} from './identityMigrationExecutor';
import {
  createIdentityMigrationJournal,
  IDENTITY_MIGRATION_JOURNAL_STORAGE_KEY,
  IdentityMigrationPersistenceError,
  parseIdentityMigrationJournal,
  type IdentityMigrationJournalPhase,
  type IdentityMigrationJournalV1,
  type IdentityMigrationPersistence,
} from './identityMigrationPersistence';
import { DefaultPageIdentityService } from './pageIdentity';

const ORIGIN = 'https://example.com';
const OTHER_ORIGIN = 'https://other.example';
const CONTENT =
  '<!-- wp:paragraph -->\n<p>Executor note</p>\n<!-- /wp:paragraph -->';
const PLANNED_AT = '2026-07-25T15:00:00.000Z';

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
    showRecentNotesOnOrigin: false,
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
    throw new Error('Expected a supported executor fixture URL.');
  }

  const contentHtml =
    overrides.contentHtml ?? (overrides.deletedAt === undefined ? CONTENT : '');

  return {
    schemaVersion: 1,
    pageKey: result.identity.pageKey,
    canonicalUrl: result.identity.canonicalUrl,
    representativeUrl: new URL(rawUrl).href,
    origin: result.identity.origin,
    title: 'Executor title',
    contentHtml,
    contentHash: hash(contentHtml),
    savedAt: '2026-07-24T10:00:00.000Z',
    revisionId: 'source-revision',
    ...overrides,
  };
}

function seededStorage(
  currentSettings: SettingsRecordV1 | undefined,
  records: readonly NoteRecordV1[],
): InMemoryChromeStorage {
  const values: Record<string, unknown> = {};

  if (currentSettings !== undefined) {
    values[SETTINGS_STORAGE_KEY] = currentSettings;
  }

  const origins = new Map<string, string[]>();

  for (const record of records) {
    values[getNoteStorageKey(record.pageKey)] = record;
    const pageKeys = origins.get(record.origin) ?? [];
    pageKeys.push(record.pageKey);
    origins.set(record.origin, pageKeys);
  }

  for (const [origin, pageKeys] of origins) {
    values[getNoteOriginIndexStorageKey(origin)] = {
      schemaVersion: 1,
      origin,
      pageKeys: pageKeys.sort(),
    };
  }

  return new InMemoryChromeStorage(values);
}

function executorHarness(
  storage: InMemoryChromeStorage,
  overrides: Partial<
    Omit<IdentityMigrationExecutorDependencies, 'persistence'>
  > & {
    readonly persistence?: IdentityMigrationPersistence;
  } = {},
): {
  readonly executor: IdentityMigrationExecutor;
  readonly clock: ReturnType<typeof vi.fn<() => Date>>;
  readonly operationIdFactory: ReturnType<typeof vi.fn<() => string>>;
  readonly revisionIdFactory: ReturnType<typeof vi.fn<() => string>>;
} {
  let revision = 0;
  const clock = vi.fn<() => Date>(() => new Date(PLANNED_AT));
  const operationIdFactory = vi.fn<() => string>(() => 'operation-1');
  const revisionIdFactory = vi.fn<() => string>(
    () => `executor-revision-${(revision += 1)}`,
  );

  return {
    executor: new IdentityMigrationExecutor({
      persistence:
        overrides.persistence ??
        new ChromeLocalIdentityMigrationPersistence(storage),
      pageIdentityService:
        overrides.pageIdentityService ?? new DefaultPageIdentityService(),
      clock: overrides.clock ?? clock,
      operationIdFactory: overrides.operationIdFactory ?? operationIdFactory,
      revisionIdFactory: overrides.revisionIdFactory ?? revisionIdFactory,
    }),
    clock,
    operationIdFactory,
    revisionIdFactory,
  };
}

async function fixturePlan(
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
    operationIdFactory: () => 'fixture-operation',
    revisionIdFactory: () => `fixture-revision-${(revision += 1)}`,
    pageIdentityService: new DefaultPageIdentityService(),
  });

  if (plan.status !== 'planned') {
    throw new Error('Expected a planned executor fixture.');
  }

  return plan;
}

async function prepareJournal(
  storage: InMemoryChromeStorage,
  plan: PlannedIdentityMigration,
  phase: IdentityMigrationJournalPhase,
): Promise<IdentityMigrationJournalV1> {
  const persistence = new ChromeLocalIdentityMigrationPersistence(storage);
  let journal = await createIdentityMigrationJournal(plan);
  await persistence.beginJournal(journal);

  if (phase !== 'planned') {
    journal = await persistence.applyDestinations(journal);
  }

  if (phase === 'tombstones-applied' || phase === 'settings-applied') {
    journal = await persistence.applyTombstones(journal);
  }

  if (phase === 'settings-applied') {
    journal = await persistence.applySettings(journal);
  }

  return journal;
}

function allStoredNotes(
  storage: InMemoryChromeStorage,
): readonly NoteRecordV1[] {
  return Object.entries(storage.snapshot())
    .filter(([key]) => key.startsWith('pageperch:v1:notes:'))
    .map(([, value]) => value as NoteRecordV1);
}

describe('IdentityMigrationExecutor start', () => {
  it('applies a no-record settings-only migration from absent defaults without persisting a no-op journal', async () => {
    const storage = new InMemoryChromeStorage();
    const requested = settings([
      { origin: ORIGIN, parameterNames: ['variant'] },
    ]);
    const { executor } = executorHarness(storage);
    const outcome = await executor.start(requested);

    expect(outcome).toMatchObject({
      status: 'applied',
      operationId: 'operation-1',
    });
    expect(Object.isFrozen(outcome)).toBe(true);
    expect(storage.snapshot()[SETTINGS_STORAGE_KEY]).toEqual(requested);
    expect(
      storage.snapshot()[IDENTITY_MIGRATION_JOURNAL_STORAGE_KEY],
    ).toBeUndefined();
    expect(storage.snapshot()[getNoteOriginIndexStorageKey(ORIGIN)]).toEqual({
      schemaVersion: 1,
      origin: ORIGIN,
      pageKeys: [],
    });

    storage.resetCalls();
    const repeated = await executor.start(requested);
    expect(repeated).toEqual({
      status: 'no-op',
      reason: 'already-applied',
    });
    expect(
      storage.setCalls.some((call) =>
        Object.prototype.hasOwnProperty.call(
          call,
          IDENTITY_MIGRATION_JOURNAL_STORAGE_KEY,
        ),
      ),
    ).toBe(false);
  });

  it('applies a single move with destination-first/tombstone/settings ordering and exact-origin isolation', async () => {
    const current = settings();
    const requested = settings([
      { origin: ORIGIN, parameterNames: ['variant'] },
    ]);
    const source = await note(`${ORIGIN}/a?variant=one`, current);
    const outside = await note(`${OTHER_ORIGIN}/a?variant=one`, current);
    const storage = seededStorage(current, [source, outside]);
    const { executor } = executorHarness(storage);
    await expect(executor.start(requested)).resolves.toMatchObject({
      status: 'applied',
    });

    const stored = allStoredNotes(storage);
    const destination = stored.find(
      (record) => record.origin === ORIGIN && record.deletedAt === undefined,
    );
    const tombstone = stored.find(
      (record) => record.pageKey === source.pageKey,
    );
    expect(destination?.contentHtml).toBe(CONTENT);
    expect(tombstone?.deletedAt).toBe(PLANNED_AT);
    expect(stored.find((record) => record.pageKey === outside.pageKey)).toEqual(
      outside,
    );

    const migrationSets = storage.setCalls.filter((call) =>
      Object.prototype.hasOwnProperty.call(
        call,
        IDENTITY_MIGRATION_JOURNAL_STORAGE_KEY,
      ),
    );
    expect(
      migrationSets.map((call) => {
        const journal = call[IDENTITY_MIGRATION_JOURNAL_STORAGE_KEY] as {
          phase: string;
        };
        return journal.phase;
      }),
    ).toEqual([
      'planned',
      'destinations-applied',
      'tombstones-applied',
      'settings-applied',
    ]);
  });

  it('preserves a deterministic collision and then performs a real removal through old-key tombstones without duplicate headings', async () => {
    const original = settings();
    const excluded = settings([
      { origin: ORIGIN, parameterNames: ['variant'] },
    ]);
    const alpha = await note(`${ORIGIN}/a?variant=alpha`, original, {
      contentHtml:
        '<!-- wp:paragraph -->\n<p>Alpha</p>\n<!-- /wp:paragraph -->',
      revisionId: 'alpha',
    });
    const beta = await note(`${ORIGIN}/a?variant=beta`, original, {
      contentHtml: '<!-- wp:paragraph -->\n<p>Beta</p>\n<!-- /wp:paragraph -->',
      revisionId: 'beta',
    });
    const storage = seededStorage(original, [beta, alpha]);
    const addition = executorHarness(storage);
    await addition.executor.start(excluded);
    const combined = allStoredNotes(storage).find(
      (record) => record.origin === ORIGIN && record.deletedAt === undefined,
    );
    expect(combined?.contentHtml.match(/<!-- wp:heading -->/gu)).toHaveLength(
      2,
    );

    const removal = executorHarness(storage, {
      clock: () => new Date('2026-07-25T16:00:00.000Z'),
      operationIdFactory: () => 'operation-2',
      revisionIdFactory: (() => {
        let revision = 0;
        return () => `removal-revision-${(revision += 1)}`;
      })(),
    });
    await removal.executor.start(original);
    const restored = allStoredNotes(storage).find(
      (record) =>
        record.deletedAt === undefined &&
        record.contentHtml === combined?.contentHtml,
    );

    expect(restored).toBeDefined();
    expect(restored?.contentHtml.match(/<!-- wp:heading -->/gu)).toHaveLength(
      2,
    );
    expect(
      storage.snapshot()[IDENTITY_MIGRATION_JOURNAL_STORAGE_KEY],
    ).toBeUndefined();
  });

  it('allows only one concurrent start to create a journal and reports the losing race without extra writes', async () => {
    const current = settings();
    const requested = settings([
      { origin: ORIGIN, parameterNames: ['variant'] },
    ]);
    const source = await note(`${ORIGIN}/a?variant=one`, current);
    const storage = seededStorage(current, [source]);
    const first = executorHarness(storage, {
      operationIdFactory: () => 'first-operation',
    });
    const second = executorHarness(storage, {
      operationIdFactory: () => 'second-operation',
    });
    const results = await Promise.allSettled([
      first.executor.start(requested),
      second.executor.start(requested),
    ]);

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(
      1,
    );
    const rejection = results.find(({ status }) => status === 'rejected');
    expect(rejection).toMatchObject({
      status: 'rejected',
      reason: {
        name: 'IdentityMigrationExecutionError',
        code: 'pending-conflict',
      },
    });
  });

  it('distinguishes begin-time inventory CAS drift from a pending-operation conflict', async () => {
    const current = settings();
    const requested = settings([
      { origin: ORIGIN, parameterNames: ['variant'] },
    ]);
    const source = await note(`${ORIGIN}/a?variant=one`, current);
    const persistence: IdentityMigrationPersistence = {
      loadJournal: () => Promise.resolve(undefined),
      loadPlanningSnapshot: () =>
        Promise.resolve({ settings: current, records: [source] }),
      beginJournal: () =>
        Promise.reject(
          new IdentityMigrationPersistenceError(
            'conflict',
            'redacted conflict',
          ),
        ),
      applyDestinations: () => Promise.reject(new Error('not expected')),
      applyTombstones: () => Promise.reject(new Error('not expected')),
      applySettings: () => Promise.reject(new Error('not expected')),
      finalize: () => Promise.reject(new Error('not expected')),
    };
    const { executor } = executorHarness(new InMemoryChromeStorage(), {
      persistence,
    });

    await expect(executor.start(requested)).rejects.toMatchObject({
      name: 'IdentityMigrationExecutionError',
      code: 'cas-conflict',
    });
  });
});

describe('IdentityMigrationExecutor resume and recovery', () => {
  it('returns immutable no-pending and matching-start resumed outcomes without generating a replacement operation', async () => {
    const empty = executorHarness(new InMemoryChromeStorage());
    const noPending = await empty.executor.resumePending();
    expect(noPending).toEqual({
      status: 'no-op',
      reason: 'no-pending-operation',
    });
    expect(Object.isFrozen(noPending)).toBe(true);

    const current = settings();
    const requested = settings([
      { origin: ORIGIN, parameterNames: ['variant'] },
    ]);
    const source = await note(`${ORIGIN}/a?variant=one`, current);
    const plan = await fixturePlan(current, requested, [source]);
    const storage = seededStorage(current, [source]);
    await prepareJournal(storage, plan, 'planned');
    const operationIdFactory = vi.fn<() => string>(() => 'replacement');
    const { executor } = executorHarness(storage, {
      operationIdFactory,
    });
    const resumed = await executor.start(requested);

    expect(resumed).toEqual({
      status: 'resumed',
      operationId: plan.operationId,
      fromPhase: 'planned',
    });
    expect(operationIdFactory).not.toHaveBeenCalled();
  });

  it.each([
    'planned',
    'destinations-applied',
    'tombstones-applied',
    'settings-applied',
  ] as const)(
    'resumes from %s with a fresh adapter without consuming production IDs/time or changing content',
    async (phase) => {
      const current = settings();
      const requested = settings([
        { origin: ORIGIN, parameterNames: ['variant'] },
      ]);
      const first = await note(`${ORIGIN}/a?variant=one`, current);
      const second = await note(`${ORIGIN}/b?variant=two`, current, {
        revisionId: 'second',
      });
      const plan = await fixturePlan(current, requested, [second, first]);
      const storage = seededStorage(current, [first, second]);
      await prepareJournal(storage, plan, phase);
      const clock = vi.fn<() => Date>(() => {
        throw new Error('resume must not consume production time');
      });
      const operationIdFactory = vi.fn<() => string>(() => {
        throw new Error('resume must not consume operation IDs');
      });
      const revisionIdFactory = vi.fn<() => string>(() => {
        throw new Error('resume must not consume revision IDs');
      });
      const { executor } = executorHarness(storage, {
        clock,
        operationIdFactory,
        revisionIdFactory,
      });
      const outcome = await executor.resumePending();

      expect(outcome).toEqual({
        status: 'resumed',
        operationId: plan.operationId,
        fromPhase: phase,
      });
      expect(Object.isFrozen(outcome)).toBe(true);
      expect(clock).not.toHaveBeenCalled();
      expect(operationIdFactory).not.toHaveBeenCalled();
      expect(revisionIdFactory).not.toHaveBeenCalled();
      expect(
        storage.snapshot()[IDENTITY_MIGRATION_JOURNAL_STORAGE_KEY],
      ).toBeUndefined();

      for (const { record } of [
        ...plan.destinations,
        ...plan.sourceTombstones,
      ]) {
        expect(storage.snapshot()[getNoteStorageKey(record.pageKey)]).toEqual(
          record,
        );
      }
    },
  );

  it.each([
    ['planned', 'set'],
    ['destinations-applied', 'set'],
    ['tombstones-applied', 'set'],
    ['settings-applied', 'remove'],
  ] as const)(
    'recovers with a fresh executor when storage fails after %s',
    async (phase, failureKind) => {
      const current = settings();
      const requested = settings([
        { origin: ORIGIN, parameterNames: ['variant'] },
      ]);
      const source = await note(`${ORIGIN}/a?variant=one`, current);
      const plan = await fixturePlan(current, requested, [source]);
      const storage = seededStorage(current, [source]);
      await prepareJournal(storage, plan, phase);

      if (failureKind === 'set') {
        storage.failNextSet();
      } else {
        storage.failNextRemove();
      }

      await expect(
        executorHarness(storage).executor.resumePending(),
      ).rejects.toMatchObject({
        name: 'IdentityMigrationExecutionError',
        code: 'persistence-failure',
      });
      expect(
        (
          await parseIdentityMigrationJournal(
            storage.snapshot()[IDENTITY_MIGRATION_JOURNAL_STORAGE_KEY],
          )
        ).phase,
      ).toBe(phase);

      const clock = vi.fn<() => Date>(() => {
        throw new Error('fresh resume must not use production time');
      });
      const operationIdFactory = vi.fn<() => string>(() => {
        throw new Error('fresh resume must not use operation IDs');
      });
      const revisionIdFactory = vi.fn<() => string>(() => {
        throw new Error('fresh resume must not use revision IDs');
      });
      const fresh = executorHarness(storage, {
        clock,
        operationIdFactory,
        revisionIdFactory,
      });

      await expect(fresh.executor.resumePending()).resolves.toMatchObject({
        status: 'resumed',
        fromPhase: phase,
      });
      expect(clock).not.toHaveBeenCalled();
      expect(operationIdFactory).not.toHaveBeenCalled();
      expect(revisionIdFactory).not.toHaveBeenCalled();
    },
  );

  it('resumes a partially applied collision without duplicating headings or changing merged content', async () => {
    const current = settings();
    const requested = settings([
      { origin: ORIGIN, parameterNames: ['variant'] },
    ]);
    const first = await note(`${ORIGIN}/a?variant=one`, current, {
      contentHtml:
        '<!-- wp:paragraph -->\n<p>First</p>\n<!-- /wp:paragraph -->',
      revisionId: 'first',
    });
    const second = await note(`${ORIGIN}/a?variant=two`, current, {
      contentHtml:
        '<!-- wp:paragraph -->\n<p>Second</p>\n<!-- /wp:paragraph -->',
      revisionId: 'second',
    });
    const plan = await fixturePlan(current, requested, [first, second]);
    const storage = seededStorage(current, [first, second]);
    await prepareJournal(storage, plan, 'destinations-applied');
    const merged = plan.destinations[0]?.record;

    await executorHarness(storage).executor.resumePending();
    expect(
      storage.snapshot()[getNoteStorageKey(merged?.pageKey ?? '')],
    ).toEqual(merged);
    expect(merged?.contentHtml.match(/<!-- wp:heading -->/gu)).toHaveLength(2);
  });

  it('resumes safely after a failed journal removal without rewriting completed records', async () => {
    const current = settings();
    const requested = settings([
      { origin: ORIGIN, parameterNames: ['variant'] },
    ]);
    const source = await note(`${ORIGIN}/a?variant=one`, current);
    const plan = await fixturePlan(current, requested, [source]);
    const storage = seededStorage(current, [source]);
    await prepareJournal(storage, plan, 'settings-applied');
    storage.failNextRemove();
    const first = executorHarness(storage);

    await expect(first.executor.resumePending()).rejects.toMatchObject({
      name: 'IdentityMigrationExecutionError',
      code: 'persistence-failure',
    });
    const completedSnapshot = storage.snapshot();
    storage.resetCalls();
    const fresh = executorHarness(storage);
    await expect(fresh.executor.resumePending()).resolves.toMatchObject({
      status: 'resumed',
      fromPhase: 'settings-applied',
    });
    expect(storage.setCalls).toEqual([]);

    for (const { record } of [...plan.destinations, ...plan.sourceTombstones]) {
      expect(completedSnapshot[getNoteStorageKey(record.pageKey)]).toEqual(
        record,
      );
    }
  });

  it('rejects a different requested migration while preserving the matching pending journal', async () => {
    const current = settings();
    const requested = settings([
      { origin: ORIGIN, parameterNames: ['variant'] },
    ]);
    const conflicting = settings([
      { origin: ORIGIN, parameterNames: ['session'] },
    ]);
    const source = await note(`${ORIGIN}/a?variant=one`, current);
    const plan = await fixturePlan(current, requested, [source]);
    const storage = seededStorage(current, [source]);
    const journal = await prepareJournal(storage, plan, 'planned');
    const { executor } = executorHarness(storage);

    await expect(executor.start(conflicting)).rejects.toMatchObject({
      name: 'IdentityMigrationExecutionError',
      code: 'pending-conflict',
    });
    expect(
      await parseIdentityMigrationJournal(
        storage.snapshot()[IDENTITY_MIGRATION_JOURNAL_STORAGE_KEY],
      ),
    ).toEqual(journal);
  });

  it('rejects a parser-valid semantically rehashed journal tamper before any persistence mutation', async () => {
    const current = settings();
    const requested = settings([
      { origin: ORIGIN, parameterNames: ['variant'] },
    ]);
    const source = await note(`${ORIGIN}/a?variant=one`, current);
    const plan = await fixturePlan(current, requested, [source]);
    const storage = seededStorage(current, [source]);
    await prepareJournal(storage, plan, 'planned');
    const raw = structuredClone(
      storage.snapshot()[IDENTITY_MIGRATION_JOURNAL_STORAGE_KEY],
    ) as {
      plan: {
        destinations: {
          record: {
            contentHtml: string;
            contentHash: string;
          };
        }[];
      };
    };
    const destination = raw.plan.destinations[0]?.record;

    if (destination === undefined) {
      throw new Error('Expected a destination tamper fixture.');
    }

    const tamperedContent =
      '<!-- wp:paragraph -->\n<p>Semantically tampered</p>\n<!-- /wp:paragraph -->';
    destination.contentHtml = tamperedContent;
    destination.contentHash = hash(tamperedContent);
    await storage.set({
      [IDENTITY_MIGRATION_JOURNAL_STORAGE_KEY]: raw,
    });
    await expect(parseIdentityMigrationJournal(raw)).resolves.toBeDefined();
    storage.resetCalls();
    const { executor } = executorHarness(storage);

    await expect(executor.resumePending()).rejects.toMatchObject({
      name: 'IdentityMigrationExecutionError',
      code: 'provenance-failure',
    });
    expect(storage.setCalls).toEqual([]);
    expect(storage.removeCalls).toEqual([]);
  });

  it('maps recovery, CAS, and storage failures to stable redacted errors', async () => {
    const secretContent = 'PRIVATE NOTE BODY';
    const secretUrl = `${ORIGIN}/private?secret=URL_SECRET&variant=one`;
    const secretToken = 'TOKEN_SECRET';
    const current = settings([], {
      byosConnection: {
        accessToken: secretToken,
        expiresAt: '2026-08-01T00:00:00.000Z',
        connectedAt: '2026-07-01T00:00:00.000Z',
      },
    });
    const requested = settings(
      [{ origin: ORIGIN, parameterNames: ['variant'] }],
      { byosConnection: current.byosConnection },
    );
    const source = await note(secretUrl, current, {
      contentHtml: secretContent,
    });
    const plan = await fixturePlan(current, requested, [source]);
    const storage = seededStorage(current, [source]);
    await prepareJournal(storage, plan, 'planned');
    await storage.remove(getNoteStorageKey(source.pageKey));
    const { executor } = executorHarness(storage);
    let caught: unknown;

    try {
      await executor.resumePending();
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      name: 'IdentityMigrationExecutionError',
      code: 'cas-conflict',
    });
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).not.toContain(secretContent);
    expect(message).not.toContain(secretUrl);
    expect(message).not.toContain(secretToken);

    const malformedStorage = new InMemoryChromeStorage({
      [IDENTITY_MIGRATION_JOURNAL_STORAGE_KEY]: {
        schemaVersion: 99,
      },
    });
    await expect(
      executorHarness(malformedStorage).executor.resumePending(),
    ).rejects.toMatchObject({ code: 'recovery-required' });

    const failureStorage = seededStorage(current, [source]);
    const failurePlan = await fixturePlan(current, requested, [source]);
    await prepareJournal(failureStorage, failurePlan, 'planned');
    failureStorage.failNextSet();
    await expect(
      executorHarness(failureStorage).executor.resumePending(),
    ).rejects.toMatchObject({ code: 'persistence-failure' });
  });

  it('uses a strict deterministic persistence call order on every resume', async () => {
    const current = settings();
    const requested = settings([
      { origin: ORIGIN, parameterNames: ['variant'] },
    ]);
    const source = await note(`${ORIGIN}/a?variant=one`, current);
    const plan = await fixturePlan(current, requested, [source]);
    const journal = await createIdentityMigrationJournal(plan);
    const calls: string[] = [];
    const phaseJournal = (
      phase: IdentityMigrationJournalPhase,
    ): IdentityMigrationJournalV1 => ({
      ...journal,
      phase,
    });
    const persistence: IdentityMigrationPersistence = {
      loadJournal() {
        calls.push('loadJournal');
        return Promise.resolve(journal);
      },
      loadPlanningSnapshot() {
        calls.push('loadPlanningSnapshot');
        return Promise.reject(new Error('not expected'));
      },
      beginJournal() {
        calls.push('beginJournal');
        return Promise.reject(new Error('not expected'));
      },
      applyDestinations() {
        calls.push('applyDestinations');
        return Promise.resolve(phaseJournal('destinations-applied'));
      },
      applyTombstones() {
        calls.push('applyTombstones');
        return Promise.resolve(phaseJournal('tombstones-applied'));
      },
      applySettings() {
        calls.push('applySettings');
        return Promise.resolve(phaseJournal('settings-applied'));
      },
      finalize() {
        calls.push('finalize');
        return Promise.resolve();
      },
    };
    const { executor } = executorHarness(new InMemoryChromeStorage(), {
      persistence,
    });

    await executor.resumePending();
    expect(calls).toEqual([
      'loadJournal',
      'applyDestinations',
      'applyTombstones',
      'applySettings',
      'finalize',
    ]);
  });
});
