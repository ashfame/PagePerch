import { describe, expect, it, vi } from 'vitest';

import { InMemoryChromeStorage } from '../../test/inMemoryChromeStorage';
import type { NoteRecordV1 } from '../domain/note';
import { ChromeLocalNoteRepository } from '../repositories/chromeLocalNoteRepository';
import { ChromeLocalSyncQueue } from '../repositories/chromeLocalSyncQueue';
import type {
  NoteRepository,
  NoteRepositoryConditionalPutResult,
} from '../repositories/noteRepository';
import type { RemoteReplicaRepository } from '../repositories/remoteReplicaRepository';
import {
  compareReplicaRecords,
  SyncEngine,
  SyncEngineError,
  type SyncEngineDependencies,
} from './syncEngine';
import type { SyncQueueEntry } from './syncQueue';

const PAGE_KEY_A = 'A'.repeat(43);
const PAGE_KEY_B = `${'B'.repeat(42)}E`;
const PAGE_KEY_C = `${'C'.repeat(42)}I`;
const PAGE_KEY_D = `${'D'.repeat(42)}M`;
const PAGE_KEY_E = `${'E'.repeat(42)}Q`;
const CONTENT_HASH = `${'H'.repeat(42)}U`;
const EMPTY_CONTENT_HASH = '47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU';
const NOW = '2026-07-25T12:00:00.000Z';

function note(
  pageKey = PAGE_KEY_A,
  overrides: Partial<NoteRecordV1> = {},
): NoteRecordV1 {
  return {
    schemaVersion: 1,
    pageKey,
    canonicalUrl: `https://example.com/${pageKey}`,
    representativeUrl: `https://example.com/${pageKey}`,
    origin: 'https://example.com',
    title: `Note ${pageKey.slice(0, 4)}`,
    contentHtml: '<!-- wp:paragraph --><p>Note body</p><!-- /wp:paragraph -->',
    contentHash: CONTENT_HASH,
    savedAt: '2026-07-25T10:00:00.000Z',
    revisionId: `revision-${pageKey.slice(0, 4)}`,
    ...overrides,
  };
}

function tombstone(
  pageKey: string,
  overrides: Partial<NoteRecordV1> = {},
): NoteRecordV1 {
  return note(pageKey, {
    contentHtml: '',
    contentHash: EMPTY_CONTENT_HASH,
    deletedAt: '2026-07-25T11:00:00.000Z',
    savedAt: '2026-07-25T11:00:00.000Z',
    ...overrides,
  });
}

class MemoryNoteRepository implements NoteRepository {
  readonly records = new Map<string, NoteRecordV1>();
  readonly getCalls: string[] = [];
  readonly putCalls: NoteRecordV1[] = [];
  readonly conditionalPutCalls: {
    readonly expected: NoteRecordV1 | undefined;
    readonly record: NoteRecordV1;
  }[] = [];
  readonly conditionalFailureKeys = new Set<string>();
  listFailure?: Error;
  listedRecords?: readonly NoteRecordV1[];
  beforeConditionalPut?: (
    expected: NoteRecordV1 | undefined,
    record: NoteRecordV1,
  ) => Promise<void>;

  constructor(records: readonly NoteRecordV1[] = []) {
    for (const record of records) {
      this.records.set(record.pageKey, { ...record });
    }
  }

  get(pageKey: string): Promise<NoteRecordV1 | undefined> {
    this.getCalls.push(pageKey);
    const record = this.records.get(pageKey);
    return Promise.resolve(record === undefined ? undefined : { ...record });
  }

  put(record: NoteRecordV1): Promise<void> {
    const snapshot = { ...record };
    this.putCalls.push(snapshot);
    this.records.set(snapshot.pageKey, snapshot);
    return Promise.resolve();
  }

  async putIfCurrent(
    expected: NoteRecordV1 | undefined,
    record: NoteRecordV1,
  ): Promise<NoteRepositoryConditionalPutResult> {
    const snapshot = { ...record };
    const expectedSnapshot =
      expected === undefined ? undefined : { ...expected };
    this.conditionalPutCalls.push({
      expected: expectedSnapshot,
      record: snapshot,
    });

    if (this.beforeConditionalPut !== undefined) {
      await this.beforeConditionalPut(expectedSnapshot, snapshot);
    }

    if (this.conditionalFailureKeys.has(record.pageKey)) {
      throw new Error('local URL/title should not escape');
    }

    if (
      JSON.stringify(this.records.get(record.pageKey)) !==
      JSON.stringify(expectedSnapshot)
    ) {
      return 'mismatch';
    }

    this.records.set(snapshot.pageKey, snapshot);
    return 'applied';
  }

  delete(pageKey: string): Promise<void> {
    this.records.delete(pageKey);
    return Promise.resolve();
  }

  listByOrigin(origin: string): Promise<readonly NoteRecordV1[]> {
    return Promise.resolve(
      [...this.records.values()]
        .filter((record) => record.origin === origin)
        .map((record) => ({ ...record })),
    );
  }

  listAll(): Promise<readonly NoteRecordV1[]> {
    if (this.listFailure !== undefined) {
      return Promise.reject(this.listFailure);
    }

    return Promise.resolve(
      (this.listedRecords ?? [...this.records.values()]).map((record) => ({
        ...record,
      })),
    );
  }
}

class MemoryRemoteRepository implements RemoteReplicaRepository {
  readonly records = new Map<string, NoteRecordV1>();
  readonly putCalls: NoteRecordV1[] = [];
  readonly putFailureKeys = new Set<string>();
  listFailure?: Error;
  listedRecords?: readonly NoteRecordV1[];
  beforePut?: (record: NoteRecordV1) => Promise<void>;

  constructor(records: readonly NoteRecordV1[] = []) {
    for (const record of records) {
      this.records.set(record.pageKey, { ...record });
    }
  }

  get(pageKey: string): Promise<NoteRecordV1 | undefined> {
    const record = this.records.get(pageKey);
    return Promise.resolve(record === undefined ? undefined : { ...record });
  }

  async put(record: NoteRecordV1): Promise<void> {
    const snapshot = { ...record };
    this.putCalls.push(snapshot);

    if (this.beforePut !== undefined) {
      await this.beforePut(snapshot);
    }

    if (this.putFailureKeys.has(record.pageKey)) {
      throw new Error(
        'transport secret OAuth token title https://private.example',
      );
    }

    this.records.set(snapshot.pageKey, snapshot);
  }

  listAll(): Promise<readonly NoteRecordV1[]> {
    if (this.listFailure !== undefined) {
      return Promise.reject(this.listFailure);
    }

    return Promise.resolve(
      (this.listedRecords ?? [...this.records.values()]).map((record) => ({
        ...record,
      })),
    );
  }
}

function harness(
  localRecords: readonly NoteRecordV1[] = [],
  remoteRecords: readonly NoteRecordV1[] = [],
  overrides: Partial<SyncEngineDependencies> = {},
) {
  const local = new MemoryNoteRepository(localRecords);
  const remote = new MemoryRemoteRepository(remoteRecords);
  const storage = new InMemoryChromeStorage();
  let now = new Date(NOW);
  const clock = vi.fn(() => new Date(now));
  const queue = new ChromeLocalSyncQueue({
    storageArea: storage,
    clock,
    random: () => 0,
  });
  const prepareLocalState = vi.fn(() => Promise.resolve());
  const engine = new SyncEngine({
    localRepository: local,
    remoteRepository: remote,
    queue,
    prepareLocalState,
    clock,
    ...overrides,
  });

  return {
    clock,
    engine,
    local,
    prepareLocalState,
    queue,
    remote,
    setNow(value: string) {
      now = new Date(value);
    },
    storage,
  };
}

describe('replica comparison', () => {
  it('chooses the later savedAt in either direction', () => {
    const earlier = note(PAGE_KEY_A);
    const later = note(PAGE_KEY_A, {
      savedAt: '2026-07-25T10:00:00.001Z',
      revisionId: 'revision-later',
    });

    expect(compareReplicaRecords(later, earlier)).toBe('local-wins');
    expect(compareReplicaRecords(earlier, later)).toBe('remote-wins');
  });

  it('breaks exact timestamp ties with the lexicographically greatest revision', () => {
    const lower = note(PAGE_KEY_A, { revisionId: 'revision-a' });
    const greater = note(PAGE_KEY_A, { revisionId: 'revision-z' });

    expect(compareReplicaRecords(greater, lower)).toBe('local-wins');
    expect(compareReplicaRecords(lower, greater)).toBe('remote-wins');
  });

  it('treats exact live records and tombstones as equal', () => {
    const live = note();
    const deleted = tombstone(PAGE_KEY_A);

    expect(compareReplicaRecords(live, { ...live })).toBe('equal');
    expect(compareReplicaRecords(deleted, { ...deleted })).toBe('equal');
  });

  it('surfaces same-timestamp same-revision differing records as an integrity conflict', () => {
    const local = note(PAGE_KEY_A, { revisionId: 'same-revision' });
    const remote = note(PAGE_KEY_A, {
      revisionId: 'same-revision',
      title: 'Different record',
    });

    expect(compareReplicaRecords(local, remote)).toBe('integrity-conflict');
  });

  it('rejects invalid or cross-page comparisons with a stable error', () => {
    expect(() =>
      compareReplicaRecords(note(PAGE_KEY_A), note(PAGE_KEY_B)),
    ).toThrow(SyncEngineError);
    expect(() =>
      compareReplicaRecords(note(PAGE_KEY_A), note(PAGE_KEY_B)),
    ).toThrow('Replica comparison received invalid note records.');
  });
});

describe('SyncEngine', () => {
  it('prepares local state and fully reconciles the exact page-key union', async () => {
    const localOnly = note(PAGE_KEY_A, { revisionId: 'local-only' });
    const remoteOnly = note(PAGE_KEY_B, { revisionId: 'remote-only' });
    const localNewer = note(PAGE_KEY_C, {
      savedAt: '2026-07-25T10:02:00.000Z',
      revisionId: 'local-newer',
    });
    const remoteOlder = note(PAGE_KEY_C, {
      savedAt: '2026-07-25T10:01:00.000Z',
      revisionId: 'remote-older',
    });
    const localOlder = note(PAGE_KEY_D, {
      savedAt: '2026-07-25T10:01:00.000Z',
      revisionId: 'local-older',
    });
    const remoteNewer = note(PAGE_KEY_D, {
      savedAt: '2026-07-25T10:02:00.000Z',
      revisionId: 'remote-newer',
    });
    const equal = note(PAGE_KEY_E, { revisionId: 'equal' });
    const events: string[] = [];
    const test = harness(
      [localOnly, localNewer, localOlder, equal],
      [remoteOnly, remoteOlder, remoteNewer, equal],
      {
        prepareLocalState: () => {
          events.push('prepare');
          return Promise.resolve();
        },
      },
    );
    const originalLocalList = test.local.listAll.bind(test.local);
    test.local.listAll = () => {
      events.push('local-list');
      return originalLocalList();
    };

    const result = await test.engine.sync();

    expect(events[0]).toBe('prepare');
    expect(result).toEqual({
      status: 'synced',
      total: 5,
      uploaded: 2,
      downloaded: 2,
      unchanged: 1,
      deferred: 0,
      conflicts: 0,
      failed: 0,
      pending: 0,
      issues: [],
    });
    expect(test.remote.putCalls).toEqual([localOnly, localNewer]);
    expect(test.local.conditionalPutCalls).toEqual([
      { expected: undefined, record: remoteOnly },
      {
        expected: localOlder,
        record: remoteNewer,
      },
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.issues)).toBe(true);
  });

  it('reconciles tombstones in both directions without physical deletion', async () => {
    const localDeleted = tombstone(PAGE_KEY_A, {
      revisionId: 'local-tombstone',
    });
    const remoteLive = note(PAGE_KEY_A, {
      savedAt: '2026-07-25T10:00:00.000Z',
      revisionId: 'remote-live',
    });
    const localLive = note(PAGE_KEY_B, {
      savedAt: '2026-07-25T10:00:00.000Z',
      revisionId: 'local-live',
    });
    const remoteDeleted = tombstone(PAGE_KEY_B, {
      revisionId: 'remote-tombstone',
    });
    const test = harness(
      [localDeleted, localLive],
      [remoteLive, remoteDeleted],
    );

    const result = await test.engine.sync();

    expect(result.uploaded).toBe(1);
    expect(result.downloaded).toBe(1);
    expect(test.remote.putCalls).toEqual([localDeleted]);
    expect(test.local.records.get(PAGE_KEY_B)).toEqual(remoteDeleted);
  });

  it('applies lexicographic revision winners for exact-timestamp conflicts in both directions', async () => {
    const localWinner = note(PAGE_KEY_A, { revisionId: 'revision-z' });
    const remoteLoser = note(PAGE_KEY_A, { revisionId: 'revision-a' });
    const localLoser = note(PAGE_KEY_B, { revisionId: 'revision-b' });
    const remoteWinner = note(PAGE_KEY_B, { revisionId: 'revision-y' });
    const test = harness(
      [localWinner, localLoser],
      [remoteLoser, remoteWinner],
    );

    const result = await test.engine.sync();

    expect(result).toMatchObject({
      status: 'synced',
      uploaded: 1,
      downloaded: 1,
    });
    expect(test.remote.records.get(PAGE_KEY_A)).toEqual(localWinner);
    expect(test.local.records.get(PAGE_KEY_B)).toEqual(remoteWinner);
  });

  it('reports an integrity conflict without choosing or writing either side', async () => {
    const local = note(PAGE_KEY_A, { revisionId: 'same-revision' });
    const remote = note(PAGE_KEY_A, {
      revisionId: 'same-revision',
      contentHtml:
        '<!-- wp:paragraph --><p>Different</p><!-- /wp:paragraph -->',
    });
    const test = harness([local], [remote]);

    const result = await test.engine.sync();

    expect(result).toMatchObject({
      status: 'partial',
      conflicts: 1,
      failed: 0,
      issues: [{ pageKey: PAGE_KEY_A, code: 'integrity-conflict' }],
    });
    expect(test.local.conditionalPutCalls).toEqual([]);
    expect(test.remote.putCalls).toEqual([]);
    expect(Object.isFrozen(result.issues[0])).toBe(true);
  });

  it('queues a partial remote failure, continues other pages, defers it until due, then clears it', async () => {
    const first = note(PAGE_KEY_A, { revisionId: 'revision-first' });
    const second = note(PAGE_KEY_B, { revisionId: 'revision-second' });
    const test = harness([first, second]);
    test.remote.putFailureKeys.add(PAGE_KEY_A);

    const failed = await test.engine.sync();

    expect(failed).toMatchObject({
      status: 'partial',
      uploaded: 1,
      failed: 1,
      pending: 1,
      issues: [{ pageKey: PAGE_KEY_A, code: 'remote-write-failure' }],
    });
    await expect(test.queue.listAll()).resolves.toEqual([
      {
        pageKey: PAGE_KEY_A,
        revisionId: first.revisionId,
        attemptCount: 1,
        nextAttemptAt: '2026-07-25T12:00:05.000Z',
      },
    ]);

    test.remote.putCalls.length = 0;
    const deferred = await test.engine.sync();
    expect(deferred).toMatchObject({
      status: 'pending',
      deferred: 1,
      failed: 0,
      pending: 1,
    });
    expect(test.remote.putCalls).toEqual([]);

    test.setNow('2026-07-25T12:00:05.000Z');
    test.remote.putFailureKeys.clear();
    const retried = await test.engine.sync();
    expect(retried).toMatchObject({
      status: 'synced',
      uploaded: 1,
      pending: 0,
    });
    await expect(test.queue.listAll()).resolves.toEqual([]);
  });

  it('continues after a per-page local hydration failure', async () => {
    const first = note(PAGE_KEY_A, { revisionId: 'remote-a' });
    const second = note(PAGE_KEY_B, { revisionId: 'remote-b' });
    const test = harness([], [first, second]);
    test.local.conditionalFailureKeys.add(PAGE_KEY_A);

    const result = await test.engine.sync();

    expect(result).toMatchObject({
      status: 'partial',
      downloaded: 1,
      failed: 1,
      issues: [{ pageKey: PAGE_KEY_A, code: 'local-write-failure' }],
    });
    expect(test.local.records.get(PAGE_KEY_A)).toBeUndefined();
    expect(test.local.records.get(PAGE_KEY_B)).toEqual(second);
  });

  it('clears a stale outbound revision after a remote-winner hydration', async () => {
    const local = note(PAGE_KEY_A, {
      savedAt: '2026-07-25T10:00:00.000Z',
      revisionId: 'revision-local-old',
    });
    const remote = note(PAGE_KEY_A, {
      savedAt: '2026-07-25T10:01:00.000Z',
      revisionId: 'revision-remote-new',
    });
    const test = harness([local], [remote]);
    await test.queue.enqueue(local.pageKey, local.revisionId);

    const result = await test.engine.sync();

    expect(result).toMatchObject({
      status: 'synced',
      downloaded: 1,
      pending: 0,
    });
    await expect(test.queue.listAll()).resolves.toEqual([]);
  });

  it('removes a queue-only orphan through revision CAS so pending state does not stick', async () => {
    const test = harness();
    await test.queue.enqueue(PAGE_KEY_A, 'revision-orphan');

    const result = await test.engine.sync();

    expect(result).toMatchObject({
      status: 'synced',
      total: 1,
      unchanged: 1,
      pending: 0,
    });
    await expect(test.queue.listAll()).resolves.toEqual([]);
    expect(test.local.conditionalPutCalls).toEqual([]);
    expect(test.remote.putCalls).toEqual([]);
  });

  it('preserves a concurrently replaced queue-only revision through cleanup CAS', async () => {
    const test = harness();
    await test.queue.enqueue(PAGE_KEY_A, 'revision-old');
    const complete = test.queue.complete.bind(test.queue);
    let replaced = false;
    test.queue.complete = async (pageKey, revisionId) => {
      if (!replaced) {
        replaced = true;
        await test.queue.enqueue(pageKey, 'revision-new');
      }

      return complete(pageKey, revisionId);
    };

    const result = await test.engine.sync();

    expect(result).toMatchObject({
      status: 'pending',
      total: 1,
      unchanged: 1,
      pending: 1,
    });
    await expect(test.queue.listAll()).resolves.toEqual([
      {
        pageKey: PAGE_KEY_A,
        revisionId: 'revision-new',
        attemptCount: 0,
        nextAttemptAt: NOW,
      },
    ]);
  });

  it('surfaces queue completion failure without hiding a successful upload', async () => {
    const local = note(PAGE_KEY_A);
    const test = harness([local]);
    test.queue.complete = vi.fn(() =>
      Promise.reject(new Error('OAuth token title secret')),
    );

    const result = await test.engine.sync();

    expect(result).toMatchObject({
      status: 'partial',
      uploaded: 1,
      failed: 0,
      issues: [{ pageKey: PAGE_KEY_A, code: 'queue-write-failure' }],
    });
    expect(JSON.stringify(result)).not.toMatch(/OAuth|title|secret/iu);
  });

  it('coalesces simultaneous triggers into one exact in-flight promise', async () => {
    let releasePreparation = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    const prepare = vi.fn(() => gate);
    const test = harness([], [], { prepareLocalState: prepare });

    const first = test.engine.sync();
    const second = test.engine.sync();

    expect(first).toBe(second);
    expect(prepare).toHaveBeenCalledOnce();
    releasePreparation();
    await expect(first).resolves.toMatchObject({ status: 'synced', total: 0 });
    await test.engine.sync();
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it('clears single-flight state after a handled preparation rejection without leaking the cause', async () => {
    const prepare = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(
        new Error('OAuth token URL title https://private.example'),
      )
      .mockResolvedValue(undefined);
    const test = harness([], [], { prepareLocalState: prepare });
    const first = test.engine.sync();
    const second = test.engine.sync();

    expect(first).toBe(second);
    const error = await first.catch((failure: unknown) => failure);
    expect(error).toMatchObject({
      name: 'SyncEngineError',
      code: 'prepare-failure',
      message:
        'Local PagePerch data could not be prepared for synchronization.',
    });
    expect(error).not.toHaveProperty('cause');
    await expect(test.engine.sync()).resolves.toMatchObject({
      status: 'synced',
    });
  });

  it.each([
    ['local', 'local-list-failure'],
    ['remote', 'remote-list-failure'],
    ['queue', 'queue-state-failure'],
  ] as const)(
    'maps a %s list failure to a stable redacted error',
    async (target, code) => {
      const test = harness();

      if (target === 'local') {
        test.local.listFailure = new Error(
          'local body title https://private.example',
        );
      } else if (target === 'remote') {
        test.remote.listFailure = new Error('S3 secret access key');
      } else {
        test.storage.failNextGet(new Error('OAuth token'));
      }

      const error = await test.engine
        .sync()
        .catch((failure: unknown) => failure);

      expect(error).toMatchObject({ name: 'SyncEngineError', code });
      expect(String(error)).not.toMatch(
        /body|title|private\.example|secret|oauth/iu,
      );
      expect(error).not.toHaveProperty('cause');
    },
  );

  it('maps a synchronous replica list throw to the same stable error', async () => {
    const test = harness([note(PAGE_KEY_A)]);
    test.remote.listAll = () => {
      throw new Error('S3 secret URL title');
    };

    const error = await test.engine.sync().catch((failure: unknown) => failure);

    expect(error).toMatchObject({
      name: 'SyncEngineError',
      code: 'remote-list-failure',
      message: 'Remote notes could not be read for synchronization.',
    });
    expect(error).not.toHaveProperty('cause');
    expect(test.remote.putCalls).toEqual([]);
  });

  it.each([
    ['non-array', { invalid: true }],
    [
      'extra field',
      [
        {
          pageKey: PAGE_KEY_A,
          revisionId: 'revision-a',
          attemptCount: 0,
          nextAttemptAt: NOW,
          title: 'must not be accepted',
        },
      ],
    ],
    [
      'invalid page key',
      [
        {
          pageKey: 'not-a-page-key',
          revisionId: 'revision-a',
          attemptCount: 0,
          nextAttemptAt: NOW,
        },
      ],
    ],
    [
      'untrimmed revision',
      [
        {
          pageKey: PAGE_KEY_A,
          revisionId: ' revision-a ',
          attemptCount: 0,
          nextAttemptAt: NOW,
        },
      ],
    ],
    [
      'attempt count above the bound',
      [
        {
          pageKey: PAGE_KEY_A,
          revisionId: 'revision-a',
          attemptCount: 32,
          nextAttemptAt: NOW,
        },
      ],
    ],
    [
      'negative attempt count',
      [
        {
          pageKey: PAGE_KEY_A,
          revisionId: 'revision-a',
          attemptCount: -1,
          nextAttemptAt: NOW,
        },
      ],
    ],
    [
      'fractional attempt count',
      [
        {
          pageKey: PAGE_KEY_A,
          revisionId: 'revision-a',
          attemptCount: 1.5,
          nextAttemptAt: NOW,
        },
      ],
    ],
    [
      'invalid timestamp',
      [
        {
          pageKey: PAGE_KEY_A,
          revisionId: 'revision-a',
          attemptCount: 0,
          nextAttemptAt: 'tomorrow',
        },
      ],
    ],
    [
      'duplicate page key',
      [
        {
          pageKey: PAGE_KEY_A,
          revisionId: 'revision-a',
          attemptCount: 0,
          nextAttemptAt: NOW,
        },
        {
          pageKey: PAGE_KEY_A,
          revisionId: 'revision-b',
          attemptCount: 1,
          nextAttemptAt: NOW,
        },
      ],
    ],
  ])(
    'rejects a %s queue snapshot before any page write',
    async (_label, value) => {
      const test = harness([note(PAGE_KEY_A)]);
      test.queue.listAll = vi.fn(() =>
        Promise.resolve(value as unknown as readonly SyncQueueEntry[]),
      );

      const error = await test.engine
        .sync()
        .catch((failure: unknown) => failure);

      expect(error).toMatchObject({
        name: 'SyncEngineError',
        code: 'queue-state-failure',
        message: 'Pending sync state is invalid and was left untouched.',
      });
      expect(error).not.toHaveProperty('cause');
      expect(test.remote.putCalls).toEqual([]);
      expect(test.local.conditionalPutCalls).toEqual([]);
    },
  );

  it.each([
    [
      'throwing',
      () => {
        throw new Error('OAuth secret');
      },
    ],
    ['invalid', () => new Date(Number.NaN)],
  ])(
    'rejects a %s engine clock before replica reads',
    async (_label, clock) => {
      const test = harness([], [], { clock });

      const error = await test.engine
        .sync()
        .catch((failure: unknown) => failure);

      expect(error).toMatchObject({
        name: 'SyncEngineError',
        code: 'clock-failure',
      });
      expect(test.remote.putCalls).toEqual([]);
    },
  );

  it('preserves and queues a newer local save that races a remote-winner hydration', async () => {
    const original = note(PAGE_KEY_A, {
      savedAt: '2026-07-25T10:00:00.000Z',
      revisionId: 'revision-original',
    });
    const remoteWinner = note(PAGE_KEY_A, {
      savedAt: '2026-07-25T10:01:00.000Z',
      revisionId: 'revision-remote',
    });
    const newerLocal = note(PAGE_KEY_A, {
      savedAt: '2026-07-25T10:02:00.000Z',
      revisionId: original.revisionId,
      title: 'Newest local save',
    });
    const storage = new InMemoryChromeStorage();
    const local = new ChromeLocalNoteRepository(storage);
    const queue = new ChromeLocalSyncQueue({
      storageArea: storage,
      clock: () => new Date(NOW),
      random: () => 0,
    });
    await local.put(original);
    const remote = new MemoryRemoteRepository([remoteWinner]);
    const racingLocal: NoteRepository = {
      delete: (pageKey) => local.delete(pageKey),
      get: (pageKey) => local.get(pageKey),
      listAll: () => local.listAll(),
      listByOrigin: (origin) => local.listByOrigin(origin),
      put: (record) => local.put(record),
      putIfCurrent: async (expected, record) => {
        await local.put(newerLocal);
        await queue.enqueue(newerLocal.pageKey, newerLocal.revisionId);
        return local.putIfCurrent(expected, record);
      },
    };
    const engine = new SyncEngine({
      localRepository: racingLocal,
      remoteRepository: remote,
      queue,
      prepareLocalState: () => Promise.resolve(),
      clock: () => new Date(NOW),
    });

    const result = await engine.sync();

    expect(result).toMatchObject({
      status: 'partial',
      downloaded: 0,
      failed: 1,
      pending: 1,
      issues: [{ pageKey: PAGE_KEY_A, code: 'local-state-changed' }],
    });
    await expect(local.get(PAGE_KEY_A)).resolves.toEqual(newerLocal);
    await expect(queue.listAll()).resolves.toEqual([
      {
        pageKey: PAGE_KEY_A,
        revisionId: newerLocal.revisionId,
        attemptCount: 0,
        nextAttemptAt: NOW,
      },
    ]);
  });

  it('does not complete a newer queue revision that arrives during an old upload', async () => {
    const original = note(PAGE_KEY_A, { revisionId: 'revision-original' });
    const newerLocal = note(PAGE_KEY_A, {
      savedAt: '2026-07-25T10:01:00.000Z',
      revisionId: 'revision-newer',
    });
    const test = harness([original]);
    await test.queue.enqueue(original.pageKey, original.revisionId);
    test.remote.beforePut = async () => {
      await test.local.put(newerLocal);
      await test.queue.enqueue(newerLocal.pageKey, newerLocal.revisionId);
    };

    const result = await test.engine.sync();

    expect(result).toMatchObject({
      status: 'pending',
      uploaded: 1,
      pending: 1,
    });
    await expect(test.queue.listAll()).resolves.toEqual([
      {
        pageKey: PAGE_KEY_A,
        revisionId: newerLocal.revisionId,
        attemptCount: 0,
        nextAttemptAt: NOW,
      },
    ]);
  });

  it('returns only stable non-sensitive per-page failure details', async () => {
    const sensitive = note(PAGE_KEY_A, {
      title: 'Sensitive title',
      canonicalUrl: 'https://example.com/private-path',
      representativeUrl: 'https://example.com/private-path?token=visible',
    });
    const test = harness([sensitive]);
    test.remote.putFailureKeys.add(PAGE_KEY_A);

    const result = await test.engine.sync();
    const serialized = JSON.stringify(result);

    expect(serialized).toContain(PAGE_KEY_A);
    expect(serialized).not.toMatch(
      /Sensitive title|private-path|token=visible|OAuth|secret/iu,
    );
  });

  it('rejects duplicate or invalid repository lists without any writes', async () => {
    const duplicate = note(PAGE_KEY_A);
    const test = harness();
    test.local.listedRecords = [duplicate, duplicate];

    await expect(test.engine.sync()).rejects.toMatchObject({
      name: 'SyncEngineError',
      code: 'repository-integrity',
    });
    expect(test.remote.putCalls).toEqual([]);
  });
});
