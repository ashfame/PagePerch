import { describe, expect, it, vi } from 'vitest';

import type { ByosClientConfig } from '../background/byosClient';
import type { SettingsRecordV1 } from '../domain/settings';
import type { SyncQueueEntry } from './syncQueue';
import {
  DefaultPageSyncVisibility,
  DefaultPendingSyncCount,
  type PageSyncVisibilityState,
  type SyncVisibilityChanges,
} from './syncVisibility';

const NOW = '2026-07-25T12:00:00.000Z';
const PAGE_KEY_A = 'A'.repeat(43);
const PAGE_KEY_B = `${'B'.repeat(42)}E`;

function settings(overrides: Partial<SettingsRecordV1> = {}): SettingsRecordV1 {
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

function entry(
  revisionId = 'revision-a',
  pageKey = PAGE_KEY_A,
): SyncQueueEntry {
  return {
    pageKey,
    revisionId,
    attemptCount: 0,
    nextAttemptAt: NOW,
  };
}

function createChanges() {
  const allListeners = new Set<() => void>();
  const pageListeners = new Map<string, Set<() => void>>();
  const allUnsubscribe = vi.fn();
  const pageUnsubscribe = vi.fn();
  const subscribeAll = vi.fn((listener: () => void) => {
    allListeners.add(listener);

    return () => {
      allUnsubscribe();
      allListeners.delete(listener);
    };
  });
  const subscribePage = vi.fn((pageKey: string, listener: () => void) => {
    const listeners = pageListeners.get(pageKey) ?? new Set<() => void>();
    listeners.add(listener);
    pageListeners.set(pageKey, listeners);

    return () => {
      pageUnsubscribe();
      listeners.delete(listener);
    };
  });

  return {
    allUnsubscribe,
    changes: { subscribeAll, subscribePage } satisfies SyncVisibilityChanges,
    emitAll() {
      for (const listener of allListeners) {
        listener();
      }
    },
    emitPage(pageKey: string) {
      for (const listener of pageListeners.get(pageKey) ?? []) {
        listener();
      }
    },
    pageUnsubscribe,
    subscribeAll,
    subscribePage,
  };
}

function pageHarness(
  overrides: {
    readonly changes?: SyncVisibilityChanges;
    readonly clock?: () => Date;
    readonly config?: ByosClientConfig;
    readonly getEntry?: (
      pageKey: string,
    ) => Promise<SyncQueueEntry | undefined>;
    readonly getSettings?: () => Promise<SettingsRecordV1>;
  } = {},
) {
  const changes = createChanges();
  const getSettings = vi.fn(
    overrides.getSettings ?? (() => Promise.resolve(settings())),
  );
  const getEntry = vi.fn(
    overrides.getEntry ?? (() => Promise.resolve(undefined)),
  );
  const visibility = new DefaultPageSyncVisibility({
    changes: overrides.changes ?? changes.changes,
    clock: overrides.clock ?? (() => new Date(NOW)),
    config: overrides.config ?? {
      clientId: 'public-client',
      enabled: true,
    },
    queue: { get: getEntry },
    settings: { get: getSettings },
  });
  const states: Array<PageSyncVisibilityState | undefined> = [];
  const emitState = vi.fn((state: PageSyncVisibilityState | undefined) => {
    states.push(state);
  });
  const connection = visibility.connect(emitState);

  return {
    ...changes,
    connection,
    emitState,
    getEntry,
    getSettings,
    states,
    visibility,
  };
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 12; turn += 1) {
    await Promise.resolve();
  }
}

describe('DefaultPageSyncVisibility', () => {
  it.each([
    ['connected pending', settings(), entry(), 'waiting'],
    [
      'expired pending',
      settings({
        byosConnection: {
          accessToken: 'oauth-token',
          connectedAt: '2026-07-25T10:00:00.000Z',
          expiresAt: NOW,
        },
      }),
      entry(),
      'waiting-reconnect',
    ],
    ['connected without reconciliation', settings(), undefined, 'checking'],
    [
      'known successful reconciliation',
      settings({
        byosConnection: {
          accessToken: 'oauth-token',
          connectedAt: '2026-07-25T10:00:00.000Z',
          expiresAt: '2026-07-25T13:00:00.000Z',
          lastSuccessfulSyncAt: '2026-07-25T11:30:00.000Z',
        },
      }),
      undefined,
      'synced',
    ],
    [
      'expired without pending work',
      settings({
        byosConnection: {
          accessToken: 'oauth-token',
          connectedAt: '2026-07-25T10:00:00.000Z',
          expiresAt: NOW,
        },
      }),
      undefined,
      'reconnect-required',
    ],
    [
      'disconnected',
      settings({ byosConnection: undefined }),
      undefined,
      'local-only',
    ],
    [
      'disconnected pending',
      settings({ byosConnection: undefined }),
      entry(),
      'waiting-reconnect',
    ],
  ] as const)(
    'derives %s conservatively',
    async (_label, storedSettings, queued, mode) => {
      const test = pageHarness({
        getSettings: () => Promise.resolve(storedSettings),
        getEntry: () => Promise.resolve(queued),
      });

      test.connection.setPage(PAGE_KEY_A);
      await settle();

      expect(test.emitState).toHaveBeenLastCalledWith(
        expect.objectContaining({
          mode,
          pageKey: PAGE_KEY_A,
          status: 'ready',
        }),
      );
    },
  );

  it('reports unavailable after an exact queue read when BYOS is disabled', async () => {
    const test = pageHarness({
      config: { clientId: undefined, enabled: false },
    });

    test.connection.setPage(PAGE_KEY_A);
    await settle();

    expect(test.emitState).toHaveBeenLastCalledWith({
      mode: 'unavailable',
      pageKey: PAGE_KEY_A,
      status: 'ready',
    });
    expect(test.getSettings).not.toHaveBeenCalled();
    expect(test.getEntry).toHaveBeenCalledWith(PAGE_KEY_A);
    expect(test.subscribePage).toHaveBeenCalledWith(
      PAGE_KEY_A,
      expect.any(Function),
    );
  });

  it('keeps an exact pending entry visible when BYOS is unavailable in this build', async () => {
    const test = pageHarness({
      config: { clientId: undefined, enabled: false },
      getEntry: () => Promise.resolve(entry('revision-unavailable')),
    });

    test.connection.setPage(PAGE_KEY_A);
    await settle();

    expect(test.emitState).toHaveBeenLastCalledWith({
      mode: 'waiting-unavailable',
      pageKey: PAGE_KEY_A,
      pendingRevisionId: 'revision-unavailable',
      status: 'ready',
    });
    expect(test.getSettings).not.toHaveBeenCalled();
  });

  it('reloads exact revision replacement and removal without trusting change payloads', async () => {
    let queued: SyncQueueEntry | undefined = entry('revision-a');
    let storedSettings = settings();
    const test = pageHarness({
      getEntry: () => Promise.resolve(queued),
      getSettings: () => Promise.resolve(storedSettings),
    });
    test.connection.setPage(PAGE_KEY_A);
    await settle();

    queued = entry('revision-b');
    test.emitPage(PAGE_KEY_A);
    await settle();
    expect(test.emitState).toHaveBeenLastCalledWith({
      mode: 'waiting',
      pageKey: PAGE_KEY_A,
      pendingRevisionId: 'revision-b',
      status: 'ready',
    });

    queued = undefined;
    storedSettings = settings({
      byosConnection: {
        accessToken: 'oauth-token',
        connectedAt: '2026-07-25T10:00:00.000Z',
        expiresAt: '2026-07-25T13:00:00.000Z',
        lastSuccessfulSyncAt: '2026-07-25T12:01:00.000Z',
      },
    });
    test.emitPage(PAGE_KEY_A);
    await settle();
    expect(test.emitState).toHaveBeenLastCalledWith({
      lastSuccessfulSyncAt: '2026-07-25T12:01:00.000Z',
      mode: 'synced',
      pageKey: PAGE_KEY_A,
      status: 'ready',
    });
  });

  it('suppresses stale page loads after navigation and cleans the old subscription', async () => {
    let resolveFirst:
      | ((value: SettingsRecordV1 | PromiseLike<SettingsRecordV1>) => void)
      | undefined;
    const firstSettings = new Promise<SettingsRecordV1>((resolve) => {
      resolveFirst = resolve;
    });
    const getSettings = vi
      .fn<() => Promise<SettingsRecordV1>>()
      .mockReturnValueOnce(firstSettings)
      .mockResolvedValue(settings());
    const test = pageHarness({ getSettings });

    test.connection.setPage(PAGE_KEY_A);
    test.connection.setPage(PAGE_KEY_B);
    resolveFirst?.(
      settings({
        byosConnection: {
          accessToken: 'stale-token',
          connectedAt: '2026-07-25T10:00:00.000Z',
          expiresAt: '2026-07-25T13:00:00.000Z',
          lastSuccessfulSyncAt: '2026-07-25T11:00:00.000Z',
        },
      }),
    );
    await settle();

    expect(test.pageUnsubscribe).toHaveBeenCalledOnce();
    expect(test.emitState).toHaveBeenLastCalledWith({
      mode: 'checking',
      pageKey: PAGE_KEY_B,
      status: 'ready',
    });
    expect(
      test.emitState.mock.calls.some(
        ([state]) =>
          typeof state === 'object' &&
          state !== null &&
          'mode' in state &&
          state.pageKey === PAGE_KEY_A,
      ),
    ).toBe(false);
  });

  it('coalesces deferred same-page notification bursts into one latest reload', async () => {
    let resolveDeferred:
      ((value: SyncQueueEntry | undefined) => void) | undefined;
    const deferred = new Promise<SyncQueueEntry | undefined>((resolve) => {
      resolveDeferred = resolve;
    });
    const getEntry = vi
      .fn<(pageKey: string) => Promise<SyncQueueEntry | undefined>>()
      .mockResolvedValueOnce(undefined)
      .mockReturnValueOnce(deferred)
      .mockResolvedValue(entry('revision-latest'));
    const test = pageHarness({ getEntry });
    test.connection.setPage(PAGE_KEY_A);
    await settle();

    test.emitPage(PAGE_KEY_A);
    await Promise.resolve();
    test.emitPage(PAGE_KEY_A);
    test.emitPage(PAGE_KEY_A);
    resolveDeferred?.(entry('revision-stale'));
    await settle();

    expect(getEntry).toHaveBeenCalledTimes(3);
    expect(test.emitState).toHaveBeenLastCalledWith({
      mode: 'waiting',
      pageKey: PAGE_KEY_A,
      pendingRevisionId: 'revision-latest',
      status: 'ready',
    });
  });

  it('suppresses a late exact-page read after disconnect', async () => {
    let resolveEntry: ((value: SyncQueueEntry | undefined) => void) | undefined;
    const deferred = new Promise<SyncQueueEntry | undefined>((resolve) => {
      resolveEntry = resolve;
    });
    const test = pageHarness({ getEntry: () => deferred });
    test.connection.setPage(PAGE_KEY_A);
    await Promise.resolve();
    test.connection.disconnect();
    await settle();
    test.emitState.mockClear();

    resolveEntry?.(entry('revision-late'));
    await settle();

    expect(test.emitState).not.toHaveBeenCalled();
    expect(test.pageUnsubscribe).toHaveBeenCalledOnce();
  });

  it.each([
    [
      'synchronous settings failure',
      {
        getSettings: () => {
          throw new Error('private settings failure');
        },
      },
    ],
    [
      'rejected queue failure',
      {
        getEntry: () =>
          Promise.reject(new Error('private queue failure revision-a')),
      },
    ],
  ])('contains %s as a safe page status error', async (_label, overrides) => {
    const test = pageHarness(overrides);

    test.connection.setPage(PAGE_KEY_A);
    await settle();

    expect(test.emitState).toHaveBeenLastCalledWith({
      pageKey: PAGE_KEY_A,
      status: 'error',
    });
    expect(JSON.stringify(test.states)).not.toMatch(
      /private settings|private queue|revision-a/iu,
    );
  });

  it('contains subscription failure as an error without blocking reads', async () => {
    const changes: SyncVisibilityChanges = {
      subscribeAll: vi.fn(() => vi.fn()),
      subscribePage: vi.fn(() => {
        throw new Error('private listener failure');
      }),
    };
    const test = pageHarness({ changes });

    test.connection.setPage(PAGE_KEY_A);
    await settle();

    expect(test.getSettings).toHaveBeenCalledOnce();
    expect(test.getEntry).toHaveBeenCalledOnce();
    expect(test.emitState).toHaveBeenLastCalledWith({
      pageKey: PAGE_KEY_A,
      status: 'error',
    });
  });

  it('retains one logical subscription through a StrictMode-style reconnect and cleans once', async () => {
    const test = pageHarness();
    test.connection.setPage(PAGE_KEY_A);
    test.connection.disconnect();
    const secondStates = vi.fn();
    const second = test.visibility.connect(secondStates);
    second.setPage(PAGE_KEY_A);
    await settle();

    expect(test.subscribePage).toHaveBeenCalledOnce();
    second.disconnect();
    await settle();
    expect(test.pageUnsubscribe).toHaveBeenCalledOnce();
  });
});

describe('DefaultPendingSyncCount', () => {
  it('loads aggregate count and reacts to enqueue, replacement, and removal notifications', async () => {
    const changes = createChanges();
    let count = 1;
    const readCount = vi.fn(() => Promise.resolve(count));
    const visibility = new DefaultPendingSyncCount({
      changes: changes.changes,
      queue: { count: readCount },
    });
    const emitState = vi.fn();
    const connection = visibility.connect(emitState);
    await settle();
    expect(emitState).toHaveBeenLastCalledWith({
      count: 1,
      status: 'ready',
    });

    count = 2;
    changes.emitAll();
    await settle();
    expect(emitState).toHaveBeenLastCalledWith({
      count: 2,
      status: 'ready',
    });

    changes.emitAll();
    await settle();
    expect(emitState).toHaveBeenLastCalledWith({
      count: 2,
      status: 'ready',
    });

    count = 0;
    changes.emitAll();
    await settle();
    expect(emitState).toHaveBeenLastCalledWith({
      count: 0,
      status: 'ready',
    });
    connection.disconnect();
  });

  it('coalesces deferred aggregate notification bursts into one latest count read', async () => {
    const changes = createChanges();
    let resolveDeferred: ((value: number) => void) | undefined;
    const deferred = new Promise<number>((resolve) => {
      resolveDeferred = resolve;
    });
    const readCount = vi
      .fn<() => Promise<number>>()
      .mockResolvedValueOnce(1)
      .mockReturnValueOnce(deferred)
      .mockResolvedValue(4);
    const visibility = new DefaultPendingSyncCount({
      changes: changes.changes,
      queue: { count: readCount },
    });
    const emitState = vi.fn();
    visibility.connect(emitState);
    await settle();

    changes.emitAll();
    await Promise.resolve();
    changes.emitAll();
    changes.emitAll();
    resolveDeferred?.(2);
    await settle();

    expect(readCount).toHaveBeenCalledTimes(3);
    expect(emitState).toHaveBeenLastCalledWith({
      count: 4,
      status: 'ready',
    });
  });

  it('suppresses a late aggregate count read after disconnect', async () => {
    const changes = createChanges();
    let resolveCount: ((value: number) => void) | undefined;
    const deferred = new Promise<number>((resolve) => {
      resolveCount = resolve;
    });
    const visibility = new DefaultPendingSyncCount({
      changes: changes.changes,
      queue: { count: () => deferred },
    });
    const emitState = vi.fn();
    const connection = visibility.connect(emitState);
    await Promise.resolve();
    connection.disconnect();
    await settle();
    emitState.mockClear();

    resolveCount?.(5);
    await settle();

    expect(emitState).not.toHaveBeenCalled();
    expect(changes.allUnsubscribe).toHaveBeenCalledOnce();
  });

  it.each([
    [
      'synchronous read failure',
      () => {
        throw new Error('private count failure');
      },
    ],
    [
      'rejected read failure',
      () => Promise.reject(new Error('private count failure')),
    ],
    ['invalid count', () => Promise.resolve(-1)],
  ])(
    'contains %s and can recover on a later owned change',
    async (_label, count) => {
      const changes = createChanges();
      const readCount = vi
        .fn<() => Promise<number> | number>()
        .mockImplementationOnce(count)
        .mockResolvedValue(3);
      const visibility = new DefaultPendingSyncCount({
        changes: changes.changes,
        queue: { count: () => Promise.resolve(readCount()) },
      });
      const emitState = vi.fn();
      visibility.connect(emitState);
      await settle();
      expect(emitState).toHaveBeenLastCalledWith({ status: 'error' });

      changes.emitAll();
      await settle();
      expect(emitState).toHaveBeenLastCalledWith({
        count: 3,
        status: 'ready',
      });
    },
  );

  it('contains subscription failure and keeps cleanup/reconnect stale-safe', async () => {
    const changes = createChanges();
    changes.subscribeAll.mockImplementationOnce(() => {
      throw new Error('private subscription failure');
    });
    const visibility = new DefaultPendingSyncCount({
      changes: changes.changes,
      queue: { count: () => Promise.resolve(1) },
    });
    const firstState = vi.fn();
    const first = visibility.connect(firstState);
    await settle();
    expect(firstState).toHaveBeenLastCalledWith({ status: 'error' });

    first.disconnect();
    const secondState = vi.fn();
    const second = visibility.connect(secondState);
    await settle();
    expect(changes.subscribeAll).toHaveBeenCalledOnce();
    second.disconnect();
    await settle();
    expect(changes.allUnsubscribe).not.toHaveBeenCalled();
  });

  it('uses one logical subscription through a StrictMode-style reconnect', async () => {
    const changes = createChanges();
    const visibility = new DefaultPendingSyncCount({
      changes: changes.changes,
      queue: { count: () => Promise.resolve(1) },
    });
    const first = visibility.connect(vi.fn());
    first.disconnect();
    const second = visibility.connect(vi.fn());
    await settle();

    expect(changes.subscribeAll).toHaveBeenCalledOnce();
    second.disconnect();
    await settle();
    expect(changes.allUnsubscribe).toHaveBeenCalledOnce();
  });
});
