import { describe, expect, it, vi } from 'vitest';

import type { SupportedActivePageSessionState } from './activePageSession';
import type { PageNoteDraftState } from './pageNoteDraft';
import {
  DefaultPageNoteOwnership,
  type PageNoteDraftRuntime,
  type PageNoteOwnershipConnection,
  type PageNoteOwnershipView,
} from './pageNoteOwnership';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

function supportedSession(pageKey: string): SupportedActivePageSessionState {
  return {
    status: 'supported',
    tabId: 1,
    representativeUrl: `https://example.com/${pageKey}`,
    title: `Page ${pageKey}`,
    identity: {
      canonicalUrl: `https://example.com/${pageKey}`,
      isRoot: false,
      origin: 'https://example.com',
      pageKey,
      pathname: `/${pageKey}`,
    },
  };
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 16; turn += 1) {
    await Promise.resolve();
  }
}

class ControlledDraftRuntime implements PageNoteDraftRuntime {
  readonly getState = vi.fn((): PageNoteDraftState => ({ status: 'loading' }));
  readonly retry = vi.fn(() => Promise.resolve());
  readonly contentChanged = vi.fn();
  readonly updatePageContext = vi.fn();
  readonly flushPendingSave = vi.fn(() => Promise.resolve());
  readonly stop = vi.fn(() => Promise.resolve());
  readonly start: ReturnType<typeof vi.fn<() => Promise<void>>>;

  constructor(start: () => Promise<void>) {
    this.start = vi.fn(start);
  }
}

function createHarness(
  startFirst: () => Promise<void>,
  configureRuntime?: (runtime: ControlledDraftRuntime, index: number) => void,
) {
  const runtimes: ControlledDraftRuntime[] = [];
  const unregisters: ReturnType<typeof vi.fn>[] = [];
  const views: Array<PageNoteOwnershipView | undefined> = [];
  let currentHandler: (() => Promise<void>) | undefined;
  const createDraftRuntime = vi.fn(() => {
    const index = runtimes.length;
    const runtime = new ControlledDraftRuntime(
      index === 0 ? startFirst : () => Promise.resolve(),
    );
    configureRuntime?.(runtime, index);
    runtimes.push(runtime);

    return runtime;
  });
  const registerPendingSave = vi.fn((handler: () => Promise<void>) => {
    currentHandler = handler;
    const unregister = vi.fn(() => {
      if (currentHandler === handler) {
        currentHandler = undefined;
      }
    });
    unregisters.push(unregister);

    return unregister;
  });
  const ownership = new DefaultPageNoteOwnership(
    createDraftRuntime,
    registerPendingSave,
  );
  const connect = (): PageNoteOwnershipConnection =>
    ownership.connect((view) => {
      views.push(view);
    });

  return {
    ownership,
    connect,
    createDraftRuntime,
    registerPendingSave,
    runtimes,
    unregisters,
    views,
    currentHandler: () => currentHandler,
    currentPendingHandler: () => currentHandler,
  };
}

type RuntimeFailureKind = 'getState' | 'updatePageContext';
type TransitionKind = 'disconnect' | 'replacement' | 'unsupported';

async function induceRuntimeFailure(
  kind: RuntimeFailureKind,
  harness: ReturnType<typeof createHarness>,
  connection: PageNoteOwnershipConnection,
): Promise<void> {
  connection.setSession(supportedSession('page-a'));
  await settle();

  if (kind === 'updatePageContext') {
    harness.runtimes[0]?.updatePageContext.mockImplementationOnce(() => {
      throw new Error('context update failed');
    });
    connection.setSession({
      ...supportedSession('page-a'),
      title: 'Updated page A',
    });
    await settle();
  }
}

describe('DefaultPageNoteOwnership pending startup interruption', () => {
  it('stops and unregisters a pending runtime before creating the replacement page, then contains a late rejection', async () => {
    const firstStart = deferred<void>();
    const harness = createHarness(() => firstStart.promise);
    const connection = harness.connect();

    connection.setSession(supportedSession('page-a'));
    await settle();
    expect(harness.runtimes[0]?.start).toHaveBeenCalledOnce();

    connection.setSession(supportedSession('page-b'));
    await settle();

    expect(harness.runtimes[0]?.stop).toHaveBeenCalledOnce();
    expect(harness.unregisters[0]).toHaveBeenCalledOnce();
    expect(harness.runtimes).toHaveLength(2);
    expect(harness.runtimes[1]?.start).toHaveBeenCalledOnce();
    expect(harness.runtimes[0]?.stop.mock.invocationCallOrder[0]).toBeLessThan(
      harness.unregisters[0]?.mock.invocationCallOrder[0] ?? 0,
    );

    firstStart.reject(new Error('late startup failure'));
    await settle();

    expect(harness.views.at(-1)).toMatchObject({
      pageKey: 'page-b',
      status: 'state',
    });
  });

  it('stops and unregisters promptly when the active page becomes unsupported, then contains a late fulfillment', async () => {
    const firstStart = deferred<void>();
    const harness = createHarness(() => firstStart.promise);
    const connection = harness.connect();

    connection.setSession(supportedSession('page-a'));
    await settle();
    connection.setSession(undefined);
    await settle();

    expect(harness.runtimes[0]?.stop).toHaveBeenCalledOnce();
    expect(harness.unregisters[0]).toHaveBeenCalledOnce();
    expect(harness.runtimes).toHaveLength(1);
    expect(harness.currentHandler()).toBeUndefined();

    firstStart.resolve();
    await settle();

    expect(harness.views.at(-1)).toBeUndefined();
  });

  it('stops and unregisters promptly on disconnect without awaiting startup, then contains a late rejection', async () => {
    const firstStart = deferred<void>();
    const harness = createHarness(() => firstStart.promise);
    const connection = harness.connect();

    connection.setSession(supportedSession('page-a'));
    await settle();
    connection.disconnect();
    await settle();

    expect(harness.runtimes[0]?.stop).toHaveBeenCalledOnce();
    expect(harness.unregisters[0]).toHaveBeenCalledOnce();
    expect(harness.currentHandler()).toBeUndefined();

    firstStart.reject(new Error('late startup failure'));
    await settle();

    expect(harness.runtimes).toHaveLength(1);
  });
});

describe.each<RuntimeFailureKind>(['getState', 'updatePageContext'])(
  'DefaultPageNoteOwnership %s failure transitions',
  (failureKind) => {
    it.each<TransitionKind>(['replacement', 'unsupported', 'disconnect'])(
      'tears down the retained owner exactly once on %s without an ownership retry',
      async (transition) => {
        const harness = createHarness(
          () => Promise.resolve(),
          (runtime, index) => {
            if (failureKind === 'getState' && index === 0) {
              runtime.getState.mockImplementationOnce(() => {
                throw new Error('state publication failed');
              });
            }
          },
        );
        const connection = harness.connect();
        await induceRuntimeFailure(failureKind, harness, connection);
        const firstHandler = harness.currentPendingHandler();

        expect(firstHandler).toBeDefined();
        expect(harness.views.at(-1)).toMatchObject({
          pageKey: 'page-a',
          status: 'runtime-error',
        });

        if (transition === 'replacement') {
          connection.setSession(supportedSession('page-b'));
        } else if (transition === 'unsupported') {
          connection.setSession(undefined);
        } else {
          connection.disconnect();
        }
        await settle();

        expect(harness.runtimes[0]?.stop).toHaveBeenCalledOnce();
        expect(harness.unregisters[0]).toHaveBeenCalledOnce();
        expect(harness.currentPendingHandler()).not.toBe(firstHandler);
        expect(
          harness.runtimes[0]?.stop.mock.invocationCallOrder[0],
        ).toBeLessThan(
          harness.unregisters[0]?.mock.invocationCallOrder[0] ?? 0,
        );

        if (transition === 'replacement') {
          expect(harness.runtimes).toHaveLength(2);
          expect(harness.currentPendingHandler()).toBeDefined();
          expect(
            harness.unregisters[0]?.mock.invocationCallOrder[0],
          ).toBeLessThan(
            harness.createDraftRuntime.mock.invocationCallOrder[1] ?? 0,
          );
          expect(harness.views.at(-1)).toMatchObject({
            pageKey: 'page-b',
            status: 'state',
          });
        } else {
          expect(harness.runtimes).toHaveLength(1);
          expect(harness.currentPendingHandler()).toBeUndefined();
        }
      },
    );
  },
);

describe('DefaultPageNoteOwnership remount durability', () => {
  it('keeps a failed teardown flushable and blocks the remounted page until an explicit successful retry', async () => {
    const harness = createHarness(() => Promise.resolve());
    const firstConnection = harness.connect();
    firstConnection.setSession(supportedSession('page-a'));
    await settle();
    const firstHandler = harness.currentHandler();
    const firstStop = deferred<void>();
    harness.runtimes[0]?.stop.mockImplementationOnce(() => firstStop.promise);

    firstConnection.disconnect();
    await settle();
    expect(harness.runtimes[0]?.stop).toHaveBeenCalledOnce();

    const remountedViews: Array<PageNoteOwnershipView | undefined> = [];
    const secondConnection = harness.ownership.connect((view) => {
      remountedViews.push(view);
    });
    secondConnection.setSession(supportedSession('page-b'));
    await settle();

    expect(harness.runtimes).toHaveLength(1);
    expect(harness.currentHandler()).toBe(firstHandler);
    await harness.currentHandler()?.();
    expect(harness.runtimes[0]?.flushPendingSave).toHaveBeenCalledOnce();

    firstStop.reject(new Error('save failed'));
    await settle();

    expect(harness.runtimes[0]?.stop).toHaveBeenCalledOnce();
    expect(harness.unregisters[0]).not.toHaveBeenCalled();
    expect(remountedViews.at(-1)).toMatchObject({
      pageKey: 'page-b',
      status: 'runtime-error',
    });

    secondConnection.retry();
    await settle();

    expect(harness.runtimes[0]?.stop).toHaveBeenCalledTimes(2);
    expect(harness.unregisters[0]).toHaveBeenCalledOnce();
    expect(harness.runtimes).toHaveLength(2);
    expect(harness.currentHandler()).not.toBe(firstHandler);
    await harness.currentHandler()?.();
    expect(harness.runtimes[1]?.flushPendingSave).toHaveBeenCalledOnce();
    expect(remountedViews.at(-1)).toMatchObject({
      pageKey: 'page-b',
      status: 'state',
    });
  });
});
