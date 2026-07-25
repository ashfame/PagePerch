import { describe, expect, it, vi } from 'vitest';

import { InMemoryChromeStorage } from '../../test/inMemoryChromeStorage';
import {
  SYNC_QUEUE_ENTRY_SCHEMA_VERSION,
  SYNC_RETRY_BASE_DELAY_MS,
  SYNC_RETRY_MAX_ATTEMPT_COUNT,
  SYNC_RETRY_MAX_DELAY_MS,
  SyncQueueError,
} from '../sync/syncQueue';
import {
  ChromeLocalSyncQueue,
  getSyncQueueStorageKey,
  SYNC_QUEUE_STORAGE_KEY_PREFIX,
} from './chromeLocalSyncQueue';

const PAGE_KEY_A = 'A'.repeat(43);
const PAGE_KEY_B = `${'B'.repeat(42)}E`;
const NOW = '2026-07-25T12:00:00.000Z';

function stored(
  pageKey: string,
  revisionId = 'revision-1',
  attemptCount = 0,
  nextAttemptAt = NOW,
) {
  return {
    schemaVersion: SYNC_QUEUE_ENTRY_SCHEMA_VERSION,
    entry: {
      pageKey,
      revisionId,
      attemptCount,
      nextAttemptAt,
    },
  };
}

function harness(
  storage = new InMemoryChromeStorage(),
  now = new Date(NOW),
  randomValue = 0,
) {
  let currentTime = now;
  let currentRandom = randomValue;
  const clock = vi.fn(() => new Date(currentTime));
  const random = vi.fn(() => currentRandom);
  const queue = new ChromeLocalSyncQueue({
    storageArea: storage,
    clock,
    random,
  });

  return {
    clock,
    queue,
    random,
    setNow(value: Date) {
      currentTime = value;
    },
    setRandom(value: number) {
      currentRandom = value;
    },
    storage,
  };
}

describe('ChromeLocalSyncQueue', () => {
  it('stores only a versioned minimal entry and returns immutable snapshots', async () => {
    const test = harness();

    const entry = await test.queue.enqueue(PAGE_KEY_A, 'revision-1');

    expect(entry).toEqual({
      pageKey: PAGE_KEY_A,
      revisionId: 'revision-1',
      attemptCount: 0,
      nextAttemptAt: NOW,
    });
    expect(Object.isFrozen(entry)).toBe(true);
    expect(test.storage.snapshot()).toEqual({
      [getSyncQueueStorageKey(PAGE_KEY_A)]: stored(PAGE_KEY_A),
    });
    const serialized = JSON.stringify(test.storage.snapshot());
    expect(serialized).not.toMatch(
      /contentHtml|canonicalUrl|representativeUrl|title|oauth|secret|bucket/iu,
    );
  });

  it('coalesces the same revision without resetting retry state and resets a different revision', async () => {
    const test = harness();
    await test.queue.enqueue(PAGE_KEY_A, 'revision-1');
    const failed = await test.queue.fail(PAGE_KEY_A, 'revision-1');
    test.storage.resetCalls();
    test.setNow(new Date('2026-07-25T13:00:00.000Z'));

    await expect(test.queue.enqueue(PAGE_KEY_A, 'revision-1')).resolves.toEqual(
      failed,
    );
    expect(test.storage.setCalls).toEqual([]);

    await expect(test.queue.enqueue(PAGE_KEY_A, 'revision-2')).resolves.toEqual(
      {
        pageKey: PAGE_KEY_A,
        revisionId: 'revision-2',
        attemptCount: 0,
        nextAttemptAt: '2026-07-25T13:00:00.000Z',
      },
    );
  });

  it('uses revision CAS for completion and failure so stale work cannot alter a newer save', async () => {
    const test = harness();
    await test.queue.enqueue(PAGE_KEY_A, 'revision-old');
    await test.queue.enqueue(PAGE_KEY_A, 'revision-new');
    test.storage.resetCalls();

    await expect(test.queue.complete(PAGE_KEY_A, 'revision-old')).resolves.toBe(
      false,
    );
    await expect(
      test.queue.fail(PAGE_KEY_A, 'revision-old'),
    ).resolves.toBeUndefined();
    await expect(test.queue.listAll()).resolves.toEqual([
      {
        pageKey: PAGE_KEY_A,
        revisionId: 'revision-new',
        attemptCount: 0,
        nextAttemptAt: NOW,
      },
    ]);
    expect(test.storage.setCalls).toEqual([]);
    expect(test.storage.removeCalls).toEqual([]);
  });

  it('creates a missing failed entry and reconstructs it after restart', async () => {
    const test = harness();

    await expect(test.queue.fail(PAGE_KEY_A, 'revision-1')).resolves.toEqual({
      pageKey: PAGE_KEY_A,
      revisionId: 'revision-1',
      attemptCount: 1,
      nextAttemptAt: new Date(
        new Date(NOW).getTime() + SYNC_RETRY_BASE_DELAY_MS,
      ).toISOString(),
    });

    const restarted = new ChromeLocalSyncQueue({
      storageArea: test.storage,
      clock: () => new Date(NOW),
      random: () => 0,
    });
    await expect(restarted.count()).resolves.toBe(1);
    await expect(restarted.listAll()).resolves.toEqual(
      await test.queue.listAll(),
    );
  });

  it('lists deterministically, filters due entries at the injected clock, and freezes arrays', async () => {
    const storage = new InMemoryChromeStorage({
      [getSyncQueueStorageKey(PAGE_KEY_B)]: stored(
        PAGE_KEY_B,
        'revision-b',
        3,
        '2026-07-25T12:00:00.001Z',
      ),
      [getSyncQueueStorageKey(PAGE_KEY_A)]: stored(
        PAGE_KEY_A,
        'revision-a',
        2,
        '2026-07-25T11:59:59.999Z',
      ),
    });
    const test = harness(storage);

    const all = await test.queue.listAll();
    const due = await test.queue.listDue();

    expect(all.map((entry) => entry.pageKey)).toEqual([PAGE_KEY_A, PAGE_KEY_B]);
    expect(due.map((entry) => entry.pageKey)).toEqual([PAGE_KEY_A]);
    expect(Object.isFrozen(all)).toBe(true);
    expect(Object.isFrozen(due)).toBe(true);
    expect(all.every(Object.isFrozen)).toBe(true);
    await expect(test.queue.count()).resolves.toBe(2);
  });

  it('reads one exact page entry without scanning unrelated storage', async () => {
    const unrelated = { 'another-extension:data': { private: true } };
    const storage = new InMemoryChromeStorage({
      ...unrelated,
      [getSyncQueueStorageKey(PAGE_KEY_A)]: stored(PAGE_KEY_A, 'revision-a'),
      [getSyncQueueStorageKey(PAGE_KEY_B)]: stored(PAGE_KEY_B, 'revision-b'),
    });
    const test = harness(storage);

    const entry = await test.queue.get(PAGE_KEY_A);

    expect(entry).toEqual({
      pageKey: PAGE_KEY_A,
      revisionId: 'revision-a',
      attemptCount: 0,
      nextAttemptAt: NOW,
    });
    expect(Object.isFrozen(entry)).toBe(true);
    expect(storage.getCalls).toEqual([getSyncQueueStorageKey(PAGE_KEY_A)]);
    expect(storage.snapshot()).toMatchObject(unrelated);
    await expect(test.queue.get(`${'C'.repeat(42)}g`)).resolves.toBeUndefined();
  });

  it.each([
    [
      'malformed envelope',
      getSyncQueueStorageKey(PAGE_KEY_A),
      { schemaVersion: 1, entry: { partial: true } },
      'stored-malformed',
    ],
    [
      'future envelope',
      getSyncQueueStorageKey(PAGE_KEY_A),
      { schemaVersion: 2, entry: { future: true } },
      'stored-future-schema',
    ],
    [
      'mismatched page key',
      getSyncQueueStorageKey(PAGE_KEY_A),
      stored(PAGE_KEY_B),
      'stored-malformed',
    ],
  ])(
    'rejects an exact-page %s without mutation',
    async (_label, key, value, code) => {
      const storage = new InMemoryChromeStorage({ [key]: value });
      const test = harness(storage);

      await expect(test.queue.get(PAGE_KEY_A)).rejects.toMatchObject({
        name: 'SyncQueueError',
        code,
        storageKey: key,
      });
      expect(storage.snapshot()[key]).toEqual(value);
      expect(storage.setCalls).toEqual([]);
      expect(storage.removeCalls).toEqual([]);
    },
  );

  it('rejects an invalid exact-page lookup before storage access', async () => {
    const test = harness();

    await expect(test.queue.get('not-a-page-key')).rejects.toMatchObject({
      code: 'invalid-entry',
    });
    expect(test.storage.getCalls).toEqual([]);
  });

  it('caps both attempt metadata and exponential retry delay', async () => {
    const test = harness();
    let latest;

    for (
      let attempt = 0;
      attempt < SYNC_RETRY_MAX_ATTEMPT_COUNT + 5;
      attempt += 1
    ) {
      latest = await test.queue.fail(PAGE_KEY_A, 'revision-1');
    }

    expect(latest?.attemptCount).toBe(SYNC_RETRY_MAX_ATTEMPT_COUNT);
    expect(new Date(latest?.nextAttemptAt ?? '').getTime()).toBe(
      new Date(NOW).getTime() + SYNC_RETRY_MAX_DELAY_MS,
    );
  });

  it.each([
    [
      'malformed envelope',
      getSyncQueueStorageKey(PAGE_KEY_A),
      { schemaVersion: 1, entry: { partial: true } },
      'stored-malformed',
    ],
    [
      'future envelope',
      getSyncQueueStorageKey(PAGE_KEY_A),
      { schemaVersion: 2, entry: { future: true } },
      'stored-future-schema',
    ],
    [
      'key mismatch',
      getSyncQueueStorageKey(PAGE_KEY_A),
      stored(PAGE_KEY_B),
      'stored-malformed',
    ],
    [
      'untrimmed revision',
      getSyncQueueStorageKey(PAGE_KEY_A),
      stored(PAGE_KEY_A, ' revision-1 '),
      'stored-malformed',
    ],
    [
      'invalid owned suffix',
      `${SYNC_QUEUE_STORAGE_KEY_PREFIX}not-a-page-key`,
      stored(PAGE_KEY_A),
      'stored-malformed',
    ],
  ])('preserves and surfaces a %s', async (_label, key, value, code) => {
    const storage = new InMemoryChromeStorage({ [key]: value });
    const test = harness(storage);

    await expect(test.queue.listAll()).rejects.toMatchObject({
      name: 'SyncQueueError',
      code,
      storageKey: key,
    });
    expect(storage.snapshot()[key]).toEqual(value);
    expect(storage.setCalls).toEqual([]);
    expect(storage.removeCalls).toEqual([]);
  });

  it('refuses to overwrite malformed owned data during enqueue', async () => {
    const key = getSyncQueueStorageKey(PAGE_KEY_A);
    const malformed = { schemaVersion: 1, entry: { partial: true } };
    const storage = new InMemoryChromeStorage({ [key]: malformed });
    const test = harness(storage);

    await expect(
      test.queue.enqueue(PAGE_KEY_A, 'revision-1'),
    ).rejects.toMatchObject({ code: 'stored-malformed' });
    expect(storage.snapshot()[key]).toEqual(malformed);
  });

  it('isolates unrelated extension storage', async () => {
    const unrelated = {
      'another-extension:data': { private: true },
      'pageperch:v1:sync-queue-lookalike': stored(PAGE_KEY_A),
    };
    const storage = new InMemoryChromeStorage(unrelated);
    const test = harness(storage);
    await test.queue.enqueue(PAGE_KEY_A, 'revision-1');
    await test.queue.complete(PAGE_KEY_A, 'revision-1');

    expect(storage.snapshot()).toEqual(unrelated);
  });

  it('serializes concurrent queue mutations across repository instances', async () => {
    const storage = new InMemoryChromeStorage();
    const first = harness(storage).queue;
    const second = harness(storage).queue;

    await Promise.all([
      first.enqueue(PAGE_KEY_A, 'revision-a'),
      second.enqueue(PAGE_KEY_B, 'revision-b'),
    ]);

    await expect(first.listAll()).resolves.toEqual([
      {
        pageKey: PAGE_KEY_A,
        revisionId: 'revision-a',
        attemptCount: 0,
        nextAttemptAt: NOW,
      },
      {
        pageKey: PAGE_KEY_B,
        revisionId: 'revision-b',
        attemptCount: 0,
        nextAttemptAt: NOW,
      },
    ]);
  });

  it('uses the shared Web Lock and chrome.storage.local default', async () => {
    const local = new InMemoryChromeStorage();
    const request = vi.fn(
      (
        _name: string,
        _options: LockOptions,
        callback: () => Promise<unknown>,
      ) => callback(),
    );
    vi.stubGlobal('chrome', { storage: { local } });
    vi.stubGlobal('navigator', { locks: { request } });
    const queue = new ChromeLocalSyncQueue({
      clock: () => new Date(NOW),
      random: () => 0,
    });

    await queue.enqueue(PAGE_KEY_A, 'revision-1');

    expect(request).toHaveBeenCalledWith(
      'pageperch:v1:chrome-storage-repository-operations',
      { mode: 'exclusive' },
      expect.any(Function),
    );
    expect(local.snapshot()).toHaveProperty(getSyncQueueStorageKey(PAGE_KEY_A));
  });

  it.each([
    ['invalid page key', 'not-a-key', 'revision-1'],
    ['empty revision', PAGE_KEY_A, ''],
    ['untrimmed revision', PAGE_KEY_A, ' revision-1 '],
  ])(
    'rejects %s before storage access',
    async (_label, pageKey, revisionId) => {
      const test = harness();

      await expect(
        test.queue.enqueue(pageKey, revisionId),
      ).rejects.toBeInstanceOf(SyncQueueError);
      expect(test.storage.getCalls).toEqual([]);
    },
  );

  it.each([
    [
      'clock throw',
      () => {
        throw new Error('url title secret');
      },
      () => 0,
      'clock-failure',
    ],
    ['clock value', () => new Date(Number.NaN), () => 0, 'clock-failure'],
    [
      'random throw',
      () => new Date(NOW),
      () => {
        throw new Error('oauth secret');
      },
      'random-failure',
    ],
    ['random value', () => new Date(NOW), () => 1, 'random-failure'],
  ])('redacts an invalid %s', async (_label, clock, random, code) => {
    const queue = new ChromeLocalSyncQueue({
      storageArea: new InMemoryChromeStorage(),
      clock,
      random,
    });

    const operation =
      code === 'clock-failure'
        ? queue.enqueue(PAGE_KEY_A, 'revision-1')
        : queue.fail(PAGE_KEY_A, 'revision-1');
    const error = await operation.catch((failure: unknown) => failure);

    expect(error).toMatchObject({ name: 'SyncQueueError', code });
    expect(String(error)).not.toMatch(/url|title|oauth|secret/iu);
  });

  it('maps storage failures to a stable redacted error', async () => {
    const storage = new InMemoryChromeStorage();
    storage.failNextGet(new Error('oauth-token title https://secret.example'));
    const test = harness(storage);

    const error = await test.queue
      .listAll()
      .catch((failure: unknown) => failure);

    expect(error).toMatchObject({
      name: 'SyncQueueError',
      code: 'storage-failure',
      message: 'The durable sync queue could not access extension storage.',
    });
    expect(error).not.toHaveProperty('cause');
  });
});
