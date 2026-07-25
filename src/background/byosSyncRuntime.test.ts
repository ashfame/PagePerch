import { describe, expect, it, vi } from 'vitest';

import type { SettingsRecordV1 } from '../domain/settings';
import { ChromeLocalSyncQueue } from '../repositories/chromeLocalSyncQueue';
import type { SyncSummary } from '../sync/syncEngine';
import {
  SYNC_RETRY_BASE_DELAY_MS,
  SYNC_RETRY_MAX_DELAY_MS,
  type SyncQueueEntry,
} from '../sync/syncQueue';
import { InMemoryChromeStorage } from '../../test/inMemoryChromeStorage';
import {
  BYOS_S3_ENDPOINT,
  BYOS_S3_REGION,
  BYOS_SYNC_PERIODIC_ALARM,
  BYOS_SYNC_PERIOD_MINUTES,
  BYOS_SYNC_RETRY_ALARM,
  ByosSyncRuntime,
  createByosS3ReplicaCredentialProvider,
  type ByosSyncRuntimeDependencies,
} from './byosSyncRuntime';

const NOW = '2026-07-25T12:00:00.000Z';
const PAGE_KEY = 'A'.repeat(43);

function connectedSettings(
  overrides: Partial<SettingsRecordV1> = {},
): SettingsRecordV1 {
  return {
    schemaVersion: 1,
    editorMode: 'text-focused-blocks',
    showRecentNotesOnOrigin: false,
    pageIdentityExclusions: [],
    byosConnection: {
      accessToken: 'oauth-token',
      connectedAt: '2026-07-25T10:00:00.000Z',
      expiresAt: '2026-07-25T13:00:00.000Z',
    },
    ...overrides,
  };
}

function summary(
  status: SyncSummary['status'] = 'synced',
  overrides: Partial<SyncSummary> = {},
): SyncSummary {
  return {
    status,
    total: 1,
    uploaded: 1,
    downloaded: 0,
    unchanged: 0,
    deferred: 0,
    conflicts: 0,
    failed: 0,
    pending: status === 'pending' ? 1 : 0,
    issues: [],
    ...overrides,
  };
}

function queueEntry(
  nextAttemptAt = '2026-07-25T12:05:00.000Z',
): SyncQueueEntry {
  return {
    pageKey: PAGE_KEY,
    revisionId: 'revision-a',
    attemptCount: 1,
    nextAttemptAt,
  };
}

interface RuntimeHarnessOverrides extends Omit<
  Partial<ByosSyncRuntimeDependencies>,
  'queue'
> {
  readonly queue?: Partial<ByosSyncRuntimeDependencies['queue']>;
}

function harness(overrides: RuntimeHarnessOverrides = {}) {
  const get = vi.fn(() => Promise.resolve(connectedSettings()));
  const updateLastSuccessfulSyncAtIfCurrent = vi.fn(() =>
    Promise.resolve<'applied' | 'mismatch'>('applied'),
  );
  const sync = vi.fn(() => Promise.resolve(summary()));
  const listAll = vi.fn(() => Promise.resolve<readonly SyncQueueEntry[]>([]));
  const listDue = vi.fn(() => Promise.resolve<readonly SyncQueueEntry[]>([]));
  const fail = vi.fn(() =>
    Promise.resolve<SyncQueueEntry | undefined>(undefined),
  );
  const releaseCredentials = vi.fn();
  const bind = vi.fn(() => releaseCredentials);
  const invalidate = vi.fn();
  const create = vi.fn(() => Promise.resolve());
  const clear = vi.fn(() => Promise.resolve(true));
  const clock = vi.fn(() => new Date(NOW));
  const { queue: queueOverrides, ...dependencyOverrides } = overrides;
  const dependencies: ByosSyncRuntimeDependencies = {
    config: { clientId: 'public-client', enabled: true },
    settings: { get, updateLastSuccessfulSyncAtIfCurrent },
    engine: { sync },
    queue: { fail, listAll, listDue, ...queueOverrides },
    credentials: { bind, invalidate },
    alarms: { create, clear },
    clock,
    ...dependencyOverrides,
  };
  const runtime = new ByosSyncRuntime(dependencies);

  return {
    clear,
    clock,
    create,
    dependencies,
    bind,
    fail,
    get,
    invalidate,
    listAll,
    listDue,
    releaseCredentials,
    runtime,
    sync,
    updateLastSuccessfulSyncAtIfCurrent,
  };
}

describe('ByosSyncRuntime preflight and outcomes', () => {
  it.each([
    ['unavailable', { clientId: undefined, enabled: false }],
    ['unavailable', { clientId: '   ', enabled: true }],
  ] as const)(
    'returns %s before settings, engine, or network-capable work for invalid build config',
    async (status, config) => {
      const test = harness({ config });

      await expect(test.runtime.trigger()).resolves.toMatchObject({ status });
      expect(test.get).not.toHaveBeenCalled();
      expect(test.sync).not.toHaveBeenCalled();
      expect(test.listAll).not.toHaveBeenCalled();
      expect(test.clear).toHaveBeenCalledWith(BYOS_SYNC_RETRY_ALARM);
    },
  );

  it('returns disconnected without engine or credential-capable work', async () => {
    const test = harness({
      settings: {
        get: () =>
          Promise.resolve({
            schemaVersion: 1,
            editorMode: 'text-focused-blocks',
            showRecentNotesOnOrigin: false,
            pageIdentityExclusions: [],
          }),
        updateLastSuccessfulSyncAtIfCurrent:
          vi.fn<
            ByosSyncRuntimeDependencies['settings']['updateLastSuccessfulSyncAtIfCurrent']
          >(),
      },
    });

    await expect(test.runtime.trigger()).resolves.toMatchObject({
      status: 'disconnected',
    });
    expect(test.sync).not.toHaveBeenCalled();
    expect(test.listAll).not.toHaveBeenCalled();
  });

  it.each([
    ['expired', () => new Date(NOW), '2026-07-25T12:00:00.000Z'],
    ['invalid clock', () => new Date(Number.NaN), '2026-07-25T13:00:00.000Z'],
  ])(
    'returns reconnect-required for an %s preflight with no engine work',
    async (_label, clock, expiresAt) => {
      const test = harness({
        settings: {
          get: () =>
            Promise.resolve(
              connectedSettings({
                byosConnection: {
                  accessToken: 'oauth-token',
                  connectedAt: '2026-07-25T10:00:00.000Z',
                  expiresAt,
                },
              }),
            ),
          updateLastSuccessfulSyncAtIfCurrent:
            vi.fn<
              ByosSyncRuntimeDependencies['settings']['updateLastSuccessfulSyncAtIfCurrent']
            >(),
        },
        clock,
      });

      await expect(test.runtime.trigger()).resolves.toMatchObject({
        status: 'reconnect-required',
      });
      expect(test.sync).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['pending', summary('pending', { pending: 2 }), 'pending'],
    ['partial', summary('partial', { failed: 1 }), 'partial'],
  ] as const)(
    'returns a sanitized %s summary without updating last-success metadata',
    async (_label, engineSummary, status) => {
      const test = harness({
        engine: { sync: () => Promise.resolve(engineSummary) },
      });

      const outcome = await test.runtime.trigger();

      expect(outcome).toMatchObject({
        status,
        uploaded: engineSummary.uploaded,
        failed: engineSummary.failed,
        pending: engineSummary.pending,
      });
      expect(test.updateLastSuccessfulSyncAtIfCurrent).not.toHaveBeenCalled();
      expect(Object.isFrozen(outcome)).toBe(true);
    },
  );

  it('updates last-success only after a fully synced result', async () => {
    const settings = connectedSettings();
    const test = harness({
      settings: {
        get: () => Promise.resolve(settings),
        updateLastSuccessfulSyncAtIfCurrent: vi.fn(() =>
          Promise.resolve<'applied'>('applied'),
        ),
      },
    });

    await expect(test.runtime.trigger()).resolves.toMatchObject({
      status: 'synced',
      uploaded: 1,
    });
    expect(
      test.dependencies.settings.updateLastSuccessfulSyncAtIfCurrent,
    ).toHaveBeenCalledWith(settings.byosConnection, NOW);
  });

  it('does not overwrite a replaced OAuth connection when the metadata CAS mismatches', async () => {
    const updateLastSuccessfulSyncAtIfCurrent = vi.fn(() =>
      Promise.resolve<'mismatch'>('mismatch'),
    );
    const test = harness({
      settings: {
        get: () => Promise.resolve(connectedSettings()),
        updateLastSuccessfulSyncAtIfCurrent,
      },
    });

    await expect(test.runtime.trigger()).resolves.toMatchObject({
      status: 'synced',
    });
    expect(updateLastSuccessfulSyncAtIfCurrent).toHaveBeenCalledOnce();
  });

  it('rejects malformed engine counters at the runtime boundary', async () => {
    const test = harness({
      engine: {
        sync: () =>
          Promise.resolve({
            ...summary(),
            uploaded: -1,
          }),
      },
    });

    await expect(test.runtime.trigger()).resolves.toEqual(
      expect.objectContaining({ status: 'failed', uploaded: 0, failed: 1 }),
    );
    expect(test.updateLastSuccessfulSyncAtIfCurrent).not.toHaveBeenCalled();
  });

  it('contains settings-read failures before engine work', async () => {
    const test = harness({
      settings: {
        get: () =>
          Promise.reject(
            new Error('oauth-token https://private.example note body'),
          ),
        updateLastSuccessfulSyncAtIfCurrent: vi.fn(),
      },
    });

    const outcome = await test.runtime.trigger();

    expect(outcome).toMatchObject({ status: 'failed' });
    expect(test.sync).not.toHaveBeenCalled();
    expect(JSON.stringify(outcome)).not.toMatch(
      /oauth-token|private\.example|note body/iu,
    );
  });

  it('treats metadata persistence failure and engine failure as stable redacted failures', async () => {
    const metadata = harness({
      settings: {
        get: () => Promise.resolve(connectedSettings()),
        updateLastSuccessfulSyncAtIfCurrent: () =>
          Promise.reject(
            new Error('oauth-token https://private.example note body'),
          ),
      },
    });
    const engine = harness({
      engine: {
        sync: () =>
          Promise.reject(
            new Error('secret access key title https://private.example'),
          ),
      },
    });

    const outcomes = await Promise.all([
      metadata.runtime.trigger(),
      engine.runtime.trigger(),
    ]);

    expect(outcomes).toEqual([
      expect.objectContaining({ status: 'failed' }),
      expect.objectContaining({ status: 'failed' }),
    ]);
    expect(JSON.stringify(outcomes)).not.toMatch(
      /oauth-token|private\.example|note body|secret access key|title/iu,
    );
  });

  it('coalesces the complete runtime preflight and engine operation', async () => {
    let release = (): void => undefined;
    const gate = new Promise<SyncSummary>((resolve) => {
      release = () => {
        resolve(summary());
      };
    });
    const test = harness({ engine: { sync: () => gate } });

    const first = test.runtime.trigger();
    const second = test.runtime.trigger();

    expect(first).toBe(second);
    await vi.waitFor(() => {
      expect(test.get).toHaveBeenCalledOnce();
    });
    release();
    await expect(first).resolves.toMatchObject({ status: 'synced' });
    await test.runtime.trigger();
    expect(test.get).toHaveBeenCalledTimes(2);
  });

  it('coalesces one fresh run after credential invalidation during an active run', async () => {
    const firstConnection = connectedSettings();
    const replacementConnection = connectedSettings({
      byosConnection: {
        accessToken: 'oauth-token-replacement',
        connectedAt: '2026-07-25T11:30:00.000Z',
        expiresAt: '2026-07-25T14:00:00.000Z',
      },
    });
    const get = vi
      .fn<() => Promise<SettingsRecordV1>>()
      .mockResolvedValueOnce(firstConnection)
      .mockResolvedValue(replacementConnection);
    let releaseFirst = (): void => undefined;
    const firstGate = new Promise<SyncSummary>((resolve) => {
      releaseFirst = () => {
        resolve(summary());
      };
    });
    const sync = vi
      .fn<() => Promise<SyncSummary>>()
      .mockReturnValueOnce(firstGate)
      .mockResolvedValue(summary());
    const updateLastSuccessfulSyncAtIfCurrent = vi.fn(() =>
      Promise.resolve<'applied'>('applied'),
    );
    const test = harness({
      settings: { get, updateLastSuccessfulSyncAtIfCurrent },
      engine: { sync },
    });

    const stale = test.runtime.trigger();
    await vi.waitFor(() => {
      expect(sync).toHaveBeenCalledOnce();
    });
    test.runtime.invalidateCredentials();
    const fresh = test.runtime.trigger();
    const coalescedFresh = test.runtime.trigger();

    expect(fresh).toBe(coalescedFresh);
    releaseFirst();
    await expect(stale).resolves.toMatchObject({ status: 'failed' });
    await expect(fresh).resolves.toMatchObject({ status: 'synced' });
    expect(sync).toHaveBeenCalledTimes(2);
    expect(test.invalidate).toHaveBeenCalledOnce();
    expect(updateLastSuccessfulSyncAtIfCurrent).toHaveBeenCalledOnce();
    expect(updateLastSuccessfulSyncAtIfCurrent).toHaveBeenCalledWith(
      replacementConnection.byosConnection,
      NOW,
    );
  });
});

describe('ByosSyncRuntime alarms and reconstruction', () => {
  it('creates the exact periodic alarm and routes only owned alarm names', async () => {
    const test = harness();

    await test.runtime.start();
    await vi.waitFor(() => {
      expect(test.create).toHaveBeenCalledWith(BYOS_SYNC_PERIODIC_ALARM, {
        periodInMinutes: BYOS_SYNC_PERIOD_MINUTES,
      });
    });
    await expect(
      test.runtime.handleAlarm('another-extension:alarm'),
    ).resolves.toBeUndefined();
    expect(test.sync).toHaveBeenCalledOnce();
    await test.runtime.handleAlarm(BYOS_SYNC_PERIODIC_ALARM);
    await test.runtime.handleAlarm(BYOS_SYNC_RETRY_ALARM);
    expect(test.sync).toHaveBeenCalledTimes(3);
  });

  it('schedules one retry alarm at the earliest durable queue time and clears it when drained', async () => {
    const listAll = vi
      .fn<() => Promise<readonly SyncQueueEntry[]>>()
      .mockResolvedValueOnce([
        queueEntry('2026-07-25T12:10:00.000Z'),
        {
          ...queueEntry('2026-07-25T12:05:00.000Z'),
          pageKey: `${'B'.repeat(42)}E`,
        },
      ])
      .mockResolvedValueOnce([]);
    const test = harness({
      engine: { sync: () => Promise.resolve(summary('pending')) },
      queue: { listAll },
    });

    await test.runtime.trigger();
    expect(test.create).toHaveBeenCalledWith(BYOS_SYNC_RETRY_ALARM, {
      when: new Date('2026-07-25T12:05:00.000Z').valueOf(),
    });

    await test.runtime.trigger();
    expect(test.clear).toHaveBeenCalledWith(BYOS_SYNC_RETRY_ALARM);
  });

  it('advances a due exact revision through bounded backoff after a global engine failure', async () => {
    const queue = new ChromeLocalSyncQueue({
      storageArea: new InMemoryChromeStorage(),
      clock: () => new Date(NOW),
      random: () => 0,
    });
    await queue.enqueue(PAGE_KEY, 'revision-a');
    const test = harness({
      engine: {
        sync: () => Promise.reject(new Error('global remote list failure')),
      },
      queue: {
        fail: (pageKey, revisionId) => queue.fail(pageKey, revisionId),
        listAll: () => queue.listAll(),
        listDue: () => queue.listDue(),
      },
    });

    await expect(test.runtime.trigger()).resolves.toMatchObject({
      status: 'failed',
    });
    const [entry] = await queue.listAll();
    const retryAt = new Date(entry?.nextAttemptAt ?? '').valueOf();

    expect(entry).toMatchObject({
      pageKey: PAGE_KEY,
      revisionId: 'revision-a',
      attemptCount: 1,
    });
    expect(retryAt).toBe(new Date(NOW).valueOf() + SYNC_RETRY_BASE_DELAY_MS);
    expect(retryAt).toBeGreaterThan(new Date(NOW).valueOf());
    expect(retryAt).toBeLessThanOrEqual(
      new Date(NOW).valueOf() + SYNC_RETRY_MAX_DELAY_MS,
    );
    expect(test.create).toHaveBeenCalledWith(BYOS_SYNC_RETRY_ALARM, {
      when: retryAt,
    });
  });

  it('recreates future retry intent after settings fail on a consumed one-shot alarm', async () => {
    const queue = new ChromeLocalSyncQueue({
      storageArea: new InMemoryChromeStorage(),
      clock: () => new Date(NOW),
      random: () => 0,
    });
    await queue.enqueue(PAGE_KEY, 'revision-a');
    const test = harness({
      settings: {
        get: () => Promise.reject(new Error('settings read failed')),
        updateLastSuccessfulSyncAtIfCurrent: vi.fn(),
      },
      queue: {
        fail: (pageKey, revisionId) => queue.fail(pageKey, revisionId),
        listAll: () => queue.listAll(),
        listDue: () => queue.listDue(),
      },
    });

    await expect(
      test.runtime.handleAlarm(BYOS_SYNC_RETRY_ALARM),
    ).resolves.toMatchObject({ status: 'failed' });
    const [entry] = await queue.listAll();
    const retryAt = new Date(entry?.nextAttemptAt ?? '').valueOf();

    expect(entry?.attemptCount).toBe(1);
    expect(retryAt).toBeGreaterThan(new Date(NOW).valueOf());
    expect(test.create).toHaveBeenCalledWith(BYOS_SYNC_RETRY_ALARM, {
      when: retryAt,
    });
    expect(test.sync).not.toHaveBeenCalled();
  });

  it('does not fail a concurrently replaced revision during global backoff', async () => {
    const queue = new ChromeLocalSyncQueue({
      storageArea: new InMemoryChromeStorage(),
      clock: () => new Date(NOW),
      random: () => 0,
    });
    await queue.enqueue(PAGE_KEY, 'revision-old');
    const fail = vi.fn(async (pageKey: string, revisionId: string) => {
      await queue.enqueue(pageKey, 'revision-new');
      return queue.fail(pageKey, revisionId);
    });
    const test = harness({
      engine: {
        sync: () => Promise.reject(new Error('global remote list failure')),
      },
      queue: {
        fail,
        listAll: () => queue.listAll(),
        listDue: () => queue.listDue(),
      },
    });

    await test.runtime.trigger();
    const [entry] = await queue.listAll();

    expect(fail).toHaveBeenCalledWith(PAGE_KEY, 'revision-old');
    expect(entry).toEqual({
      pageKey: PAGE_KEY,
      revisionId: 'revision-new',
      attemptCount: 0,
      nextAttemptAt: NOW,
    });
    expect(test.create).toHaveBeenCalledWith(BYOS_SYNC_RETRY_ALARM, {
      when: new Date(NOW).valueOf() + SYNC_RETRY_BASE_DELAY_MS,
    });
  });

  it('reconstructs from injected durable queue state after runtime suspension', async () => {
    const entries = [queueEntry()];
    const sharedQueue = {
      listAll: vi.fn(() => Promise.resolve<readonly SyncQueueEntry[]>(entries)),
    };
    const first = harness({
      engine: { sync: () => Promise.resolve(summary('pending')) },
      queue: sharedQueue,
    });
    const restarted = harness({
      engine: { sync: () => Promise.resolve(summary('pending')) },
      queue: sharedQueue,
    });

    await first.runtime.trigger();
    await restarted.runtime.trigger();

    expect(sharedQueue.listAll).toHaveBeenCalledTimes(2);
    expect(restarted.create).toHaveBeenCalledWith(
      BYOS_SYNC_RETRY_ALARM,
      expect.objectContaining({
        when: new Date(entries[0]?.nextAttemptAt ?? '').valueOf(),
      }),
    );
  });

  it('keeps the established service endpoint and region in extension composition', () => {
    expect(BYOS_S3_ENDPOINT).toBe('https://byos.ashfame.com');
    expect(BYOS_S3_REGION).toBe('us-east-1');
  });

  it('projects operation-scoped BYOS credentials without retaining protocol metadata', async () => {
    const getProtocolCredentials = vi.fn(() =>
      Promise.resolve({
        accessKeyId: 'temporary-access-key',
        secretAccessKey: 'temporary-secret-key',
        bucket: 'issued-bucket-alias',
        credentialId: 'credential-id',
        expiresAt: '2026-07-25T12:10:00.000Z',
      }),
    );
    const provider = createByosS3ReplicaCredentialProvider({
      getProtocolCredentials,
    });
    const expectedConnection = connectedSettings().byosConnection;

    if (expectedConnection === undefined) {
      throw new Error('Expected a connected fixture.');
    }

    const release = provider.bind(expectedConnection);

    const credentials = await provider.get();
    release();

    expect(credentials).toEqual({
      accessKeyId: 'temporary-access-key',
      secretAccessKey: 'temporary-secret-key',
      bucket: 'issued-bucket-alias',
    });
    expect(Object.isFrozen(credentials)).toBe(true);
    expect(getProtocolCredentials).toHaveBeenCalledOnce();
  });

  it('invalidates an active connection binding before later credential operations can use a replacement', async () => {
    const original = connectedSettings().byosConnection;
    const replacement = connectedSettings({
      byosConnection: {
        accessToken: 'oauth-token-replacement',
        connectedAt: '2026-07-25T11:00:00.000Z',
        expiresAt: '2026-07-25T14:00:00.000Z',
      },
    }).byosConnection;

    if (original === undefined || replacement === undefined) {
      throw new Error('Expected connected settings fixtures.');
    }

    const getProtocolCredentials = vi.fn((expected: typeof original) =>
      Promise.resolve({
        accessKeyId: `access-for-${expected.accessToken}`,
        secretAccessKey: 'temporary-secret-key',
        bucket: `bucket-for-${expected.accessToken}`,
        credentialId: 'credential-id',
        expiresAt: '2026-07-25T12:10:00.000Z',
      }),
    );
    const invalidateProtocolCredentials = vi.fn();
    const provider = createByosS3ReplicaCredentialProvider(
      { getProtocolCredentials },
      invalidateProtocolCredentials,
    );
    const releaseOriginal = provider.bind(original);

    await expect(provider.get()).resolves.toMatchObject({
      accessKeyId: 'access-for-oauth-token',
    });
    provider.invalidate();
    await expect(provider.get()).rejects.toThrow(
      'BYOS synchronization credentials are not bound to a connection.',
    );
    releaseOriginal();
    const releaseReplacement = provider.bind(replacement);
    await expect(provider.get()).resolves.toMatchObject({
      accessKeyId: 'access-for-oauth-token-replacement',
    });
    releaseReplacement();

    expect(invalidateProtocolCredentials).toHaveBeenCalledOnce();
    expect(getProtocolCredentials).toHaveBeenNthCalledWith(1, original);
    expect(getProtocolCredentials).toHaveBeenNthCalledWith(2, replacement);
  });

  it('contains Chrome alarm and durable-queue scheduling failures', async () => {
    const test = harness({
      alarms: {
        create: () => Promise.reject(new Error('alarm unavailable')),
        clear: () => Promise.reject(new Error('alarm unavailable')),
      },
      queue: {
        listAll: () =>
          Promise.reject(new Error('queue storage temporarily unavailable')),
      },
    });

    await expect(test.runtime.start()).resolves.toMatchObject({
      status: 'synced',
    });
  });
});
