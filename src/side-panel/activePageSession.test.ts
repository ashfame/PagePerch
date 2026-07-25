import { describe, expect, it, vi } from 'vitest';

import type {
  PageIdentityExclusionRule,
  PageIdentityResult,
} from '../domain/pageIdentity';
import {
  createPageIdentityKey,
  DefaultPageIdentityService,
  derivePageIdentity,
} from '../services/pageIdentity';
import {
  ActivePageSessionController,
  type ActivePageIdentity,
  type ActivePageSessionState,
  type ActivePageSettings,
  type ActivePageTab,
  type ActivePageTabActivatedInfo,
  type ActivePageTabActivatedListener,
  type ActivePageTabChangeInfo,
  type ActivePageTabUpdatedListener,
  type ActivePageTabs,
} from './activePageSession';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((reason: Error) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  return {
    promise,
    resolve: (value) => {
      resolvePromise?.(value);
    },
    reject: (reason) => {
      rejectPromise?.(reason);
    },
  };
}

function cloneTab(tab: ActivePageTab | undefined): ActivePageTab | undefined {
  return tab === undefined ? undefined : { ...tab };
}

class FakeTabs implements ActivePageTabs {
  activeTab: ActivePageTab | undefined;
  readonly tabs = new Map<number, ActivePageTab>();
  queryImplementation: () => Promise<ActivePageTab | undefined> = () =>
    Promise.resolve(cloneTab(this.activeTab));
  readonly queryCurrentWindowActiveTab = vi.fn(() =>
    this.queryImplementation(),
  );
  readonly activatedListeners = new Set<ActivePageTabActivatedListener>();
  readonly updatedListeners = new Set<ActivePageTabUpdatedListener>();
  activatedUnsubscribeCalls = 0;
  updatedUnsubscribeCalls = 0;

  subscribeActivated(listener: ActivePageTabActivatedListener): () => void {
    this.activatedListeners.add(listener);
    let subscribed = true;

    return () => {
      if (subscribed) {
        subscribed = false;
        this.activatedUnsubscribeCalls += 1;
        this.activatedListeners.delete(listener);
      }
    };
  }

  subscribeUpdated(listener: ActivePageTabUpdatedListener): () => void {
    this.updatedListeners.add(listener);
    let subscribed = true;

    return () => {
      if (subscribed) {
        subscribed = false;
        this.updatedUnsubscribeCalls += 1;
        this.updatedListeners.delete(listener);
      }
    };
  }

  activate(
    info: ActivePageTabActivatedInfo,
    options: { readonly currentWindow?: boolean } = {},
  ): void {
    if (options.currentWindow !== false) {
      this.activeTab = cloneTab(this.tabs.get(info.tabId));
    }

    for (const listener of this.activatedListeners) {
      listener({ ...info });
    }
  }

  update(
    tabId: number,
    changeInfo: ActivePageTabChangeInfo,
    tab: ActivePageTab,
  ): void {
    for (const listener of this.updatedListeners) {
      listener(tabId, { ...changeInfo }, { ...tab });
    }
  }
}

class FakeSettings implements ActivePageSettings {
  exclusions: readonly PageIdentityExclusionRule[] = [];
  failure: Error | undefined;
  readonly getPageIdentityExclusions = vi.fn(() => {
    if (this.failure !== undefined) {
      return Promise.reject(this.failure);
    }

    return Promise.resolve(
      this.exclusions.map((rule) => ({
        origin: rule.origin,
        parameterNames: [...rule.parameterNames],
      })),
    );
  });
}

class FakeIdentity implements ActivePageIdentity {
  readonly service = new DefaultPageIdentityService();
  implementation: (
    rawUrl: string,
    exclusions: readonly PageIdentityExclusionRule[],
  ) => Promise<unknown> = (rawUrl, exclusions) =>
    this.service.identify(rawUrl, exclusions);
  readonly identify = vi.fn(
    (rawUrl: string, exclusions: readonly PageIdentityExclusionRule[] = []) =>
      this.implementation(rawUrl, exclusions),
  );
}

interface ControllerHarness {
  readonly controller: ActivePageSessionController;
  readonly states: ActivePageSessionState[];
  readonly flushPendingSave: ReturnType<typeof vi.fn<() => Promise<void>>>;
}

function createHarness(
  tabs: FakeTabs,
  options: {
    readonly settings?: ActivePageSettings;
    readonly identity?: ActivePageIdentity;
    readonly flushPendingSave?: () => Promise<void>;
    readonly emitState?: (state: ActivePageSessionState) => void;
  } = {},
): ControllerHarness {
  const states: ActivePageSessionState[] = [];
  const flushPendingSave = vi.fn(
    options.flushPendingSave ?? (() => Promise.resolve()),
  );
  const controller = new ActivePageSessionController({
    tabs,
    settings: options.settings ?? new FakeSettings(),
    identity: options.identity ?? new FakeIdentity(),
    flushPendingSave,
    emitState:
      options.emitState ??
      ((state) => {
        states.push(state);
      }),
  });

  return { controller, states, flushPendingSave };
}

function lastState(states: readonly ActivePageSessionState[]) {
  const state = states.at(-1);

  if (state === undefined) {
    throw new Error('Expected at least one emitted session state.');
  }

  return state;
}

async function waitForState(
  states: readonly ActivePageSessionState[],
  predicate: (state: ActivePageSessionState) => boolean,
): Promise<void> {
  await vi.waitFor(() => {
    expect(states.some(predicate)).toBe(true);
  });
}

describe('ActivePageSessionController initial sessions', () => {
  it('publishes loading then the queried active page with current exclusions', async () => {
    const tabs = new FakeTabs();
    tabs.activeTab = {
      id: 7,
      url: 'https://example.com/path?session=one&view=full',
      title: 'Example title',
    };
    const settings = new FakeSettings();
    settings.exclusions = [
      {
        origin: 'https://example.com',
        parameterNames: ['session'],
      },
    ];
    const identity = new FakeIdentity();
    const { controller, states, flushPendingSave } = createHarness(tabs, {
      settings,
      identity,
    });

    controller.start();
    await waitForState(states, ({ status }) => status === 'supported');

    expect(states[0]).toEqual({ status: 'loading' });
    expect(lastState(states)).toMatchObject({
      status: 'supported',
      tabId: 7,
      representativeUrl: 'https://example.com/path?session=one&view=full',
      title: 'Example title',
      identity: {
        canonicalUrl: 'https://example.com/path?view=full',
      },
    });
    expect(tabs.queryCurrentWindowActiveTab).toHaveBeenCalledOnce();
    expect(identity.identify).toHaveBeenCalledWith(
      'https://example.com/path?session=one&view=full',
      settings.exclusions,
    );
    expect(flushPendingSave).not.toHaveBeenCalled();
  });

  it.each([
    ['https://example.com/path#section', 'https://example.com/path'],
    [
      'https://user:password@example.com/private',
      'https://example.com/private',
    ],
    [
      'https://example.com/path?utm_source=one&gclid=two',
      'https://example.com/path',
    ],
    [
      'https://example.com/path?tag=z&tag=a&tag=a',
      'https://example.com/path?tag=a&tag=a&tag=z',
    ],
  ] as const)(
    'accepts shared PP-002 normalization for %s',
    async (rawUrl, canonicalUrl) => {
      const tabs = new FakeTabs();
      tabs.activeTab = { id: 1, url: rawUrl, title: 'Normalized page' };
      const { controller, states } = createHarness(tabs);

      controller.start();
      await waitForState(states, ({ status }) => status === 'supported');

      expect(lastState(states)).toMatchObject({
        status: 'supported',
        representativeUrl: rawUrl,
        identity: { canonicalUrl },
      });
    },
  );

  it.each([
    [undefined, 'no-active-tab'],
    [
      { url: 'https://example.com/path', title: 'Missing id' },
      'missing-tab-id',
    ],
    [{ id: 1, title: 'Missing URL' }, 'missing-url'],
    [{ id: 1, url: '', title: 'Empty URL' }, 'missing-url'],
  ] as const)(
    'handles incomplete active tab %j as %s',
    async (activeTab, reason) => {
      const tabs = new FakeTabs();
      tabs.activeTab = activeTab;
      const { controller, states } = createHarness(tabs);

      controller.start();
      await waitForState(states, (state) => state.status === 'unsupported');

      expect(lastState(states)).toMatchObject({
        status: 'unsupported',
        reason,
      });
    },
  );

  it('accepts a missing tab title as an empty safe title', async () => {
    const tabs = new FakeTabs();
    tabs.activeTab = { id: 1, url: 'https://example.com/path' };
    const { controller, states } = createHarness(tabs);

    controller.start();
    await waitForState(states, ({ status }) => status === 'supported');

    expect(lastState(states)).toMatchObject({
      status: 'supported',
      title: '',
    });
  });

  it.each([
    [
      'file:///tmp/page.html',
      {
        reason: 'unsupported-scheme',
        protocol: 'file:',
      },
    ],
    [
      'not a URL',
      {
        reason: 'invalid-url',
      },
    ],
  ])('publishes an unsupported state for %s', async (url, expected) => {
    const tabs = new FakeTabs();
    tabs.activeTab = { id: 1, url, title: 'Unsupported' };
    const { controller, states } = createHarness(tabs);

    controller.start();
    await waitForState(states, (state) => state.status === 'unsupported');

    expect(lastState(states)).toMatchObject({
      status: 'unsupported',
      representativeUrl: url,
      title: 'Unsupported',
      ...expected,
    });
  });

  it('publishes an actionable query error without an initial flush', async () => {
    const tabs = new FakeTabs();
    tabs.queryImplementation = () =>
      Promise.reject(new Error('tabs.query failed'));
    const { controller, states, flushPendingSave } = createHarness(tabs);

    controller.start();
    await waitForState(states, ({ status }) => status === 'error');

    const state = lastState(states);
    expect(state).toMatchObject({
      status: 'error',
      reason: 'active-tab-query-failed',
    });
    expect(state.status === 'error' ? state.message : '').toContain('Reopen');
    expect(flushPendingSave).not.toHaveBeenCalled();
  });

  it('reports listener registration failure and removes a partially registered listener', () => {
    const tabs = new FakeTabs();
    const originalSubscribeUpdated = tabs.subscribeUpdated.bind(tabs);
    tabs.subscribeUpdated = () => {
      throw new Error('listener registration failed');
    };
    const { controller, states } = createHarness(tabs);

    controller.start();

    expect(lastState(states)).toMatchObject({
      status: 'error',
      reason: 'listener-registration-failed',
    });
    expect(tabs.activatedUnsubscribeCalls).toBe(1);
    expect(tabs.activatedListeners.size).toBe(0);
    expect(tabs.queryCurrentWindowActiveTab).not.toHaveBeenCalled();
    tabs.subscribeUpdated = originalSubscribeUpdated;
  });
});

describe('ActivePageSessionController navigation', () => {
  it('loads an activated tab and flushes before publishing its different document', async () => {
    const tabs = new FakeTabs();
    tabs.activeTab = {
      id: 1,
      url: 'https://example.com/first',
      title: 'First',
    };
    tabs.tabs.set(2, {
      id: 2,
      url: 'https://example.com/second',
      title: 'Second',
    });
    const actions: string[] = [];
    const states: ActivePageSessionState[] = [];
    const { controller, flushPendingSave } = createHarness(tabs, {
      flushPendingSave: () => {
        actions.push('flush');

        return Promise.resolve();
      },
      emitState: (state) => {
        states.push(state);
        actions.push(
          state.status === 'supported'
            ? `emit:${state.identity.canonicalUrl}`
            : `emit:${state.status}`,
        );
      },
    });

    controller.start();
    await waitForState(
      states,
      (state) =>
        state.status === 'supported' &&
        state.identity.canonicalUrl.endsWith('/first'),
    );
    actions.length = 0;

    tabs.activate({ tabId: 2 });
    await waitForState(
      states,
      (state) =>
        state.status === 'supported' &&
        state.identity.canonicalUrl.endsWith('/second'),
    );

    expect(tabs.queryCurrentWindowActiveTab.mock.calls.length).toBeGreaterThan(
      1,
    );
    expect(actions).toEqual(['flush', 'emit:https://example.com/second']);
    expect(flushPendingSave).toHaveBeenCalledOnce();
  });

  it('updates same-page representative URL and title without a flush or page-key change', async () => {
    const tabs = new FakeTabs();
    tabs.activeTab = {
      id: 1,
      url: 'https://example.com/path?utm_source=first',
      title: 'First title',
    };
    const { controller, states, flushPendingSave } = createHarness(tabs);

    controller.start();
    await waitForState(states, ({ status }) => status === 'supported');
    const initial = lastState(states);

    if (initial.status !== 'supported') {
      throw new Error('Expected the initial supported state.');
    }

    tabs.update(
      1,
      {
        url: 'https://example.com/path?utm_source=second#section',
        title: 'Updated title',
      },
      {
        id: 1,
        url: 'https://example.com/path?utm_source=second#section',
        title: 'Updated title',
      },
    );
    await waitForState(
      states,
      (state) =>
        state.status === 'supported' && state.title === 'Updated title',
    );
    const updated = lastState(states);

    expect(updated).toMatchObject({
      status: 'supported',
      representativeUrl: 'https://example.com/path?utm_source=second#section',
      title: 'Updated title',
      identity: {
        canonicalUrl: 'https://example.com/path',
        pageKey: initial.identity.pageKey,
      },
    });
    expect(flushPendingSave).not.toHaveBeenCalled();
  });

  it('uses the previous active URL for a title-only update', async () => {
    const tabs = new FakeTabs();
    tabs.activeTab = {
      id: 1,
      url: 'https://example.com/path',
      title: 'Original',
    };
    const { controller, states, flushPendingSave } = createHarness(tabs);

    controller.start();
    await waitForState(states, ({ status }) => status === 'supported');

    tabs.update(1, { title: 'Renamed' }, { id: 1, title: 'Renamed' });
    await waitForState(
      states,
      (state) => state.status === 'supported' && state.title === 'Renamed',
    );

    expect(lastState(states)).toMatchObject({
      status: 'supported',
      representativeUrl: 'https://example.com/path',
      title: 'Renamed',
    });
    expect(flushPendingSave).not.toHaveBeenCalled();
  });

  it('ignores inactive-tab and irrelevant status updates', async () => {
    const tabs = new FakeTabs();
    tabs.activeTab = {
      id: 1,
      url: 'https://example.com/path',
      title: 'Active',
    };
    const settings = new FakeSettings();
    const { controller, states } = createHarness(tabs, { settings });

    controller.start();
    await waitForState(states, ({ status }) => status === 'supported');
    const stateCount = states.length;
    const settingsCalls = settings.getPageIdentityExclusions.mock.calls.length;

    tabs.update(
      2,
      { url: 'https://example.com/unrelated' },
      { id: 2, url: 'https://example.com/unrelated', title: 'Unrelated' },
    );
    tabs.update(1, {}, tabs.activeTab);
    await Promise.resolve();

    expect(states).toHaveLength(stateCount);
    expect(settings.getPageIdentityExclusions).toHaveBeenCalledTimes(
      settingsCalls,
    );
  });

  it('flushes before transitioning from a supported page to unsupported', async () => {
    const tabs = new FakeTabs();
    tabs.activeTab = {
      id: 1,
      url: 'https://example.com/path',
      title: 'Supported',
    };
    tabs.tabs.set(2, {
      id: 2,
      url: 'chrome://settings/',
      title: 'Chrome settings',
    });
    const actions: string[] = [];
    const states: ActivePageSessionState[] = [];
    const { controller } = createHarness(tabs, {
      flushPendingSave: () => {
        actions.push('flush');

        return Promise.resolve();
      },
      emitState: (state) => {
        states.push(state);
        actions.push(`emit:${state.status}`);
      },
    });

    controller.start();
    await waitForState(states, ({ status }) => status === 'supported');
    actions.length = 0;

    tabs.activate({ tabId: 2 });
    await waitForState(states, ({ status }) => status === 'unsupported');

    expect(actions).toEqual(['flush', 'emit:unsupported']);
    expect(lastState(states)).toMatchObject({
      status: 'unsupported',
      reason: 'unsupported-scheme',
      protocol: 'chrome:',
    });
  });

  it('coalesces rapid navigation to the latest document and flushes once', async () => {
    const tabs = new FakeTabs();
    tabs.activeTab = {
      id: 1,
      url: 'https://example.com/start',
      title: 'Start',
    };
    const { controller, states, flushPendingSave } = createHarness(tabs);

    controller.start();
    await waitForState(states, ({ status }) => status === 'supported');
    const supportedBefore = states.filter(
      ({ status }) => status === 'supported',
    ).length;

    for (const path of ['middle-one', 'middle-two', 'latest']) {
      const url = `https://example.com/${path}`;
      tabs.update(1, { url, title: path }, { id: 1, url, title: path });
    }

    await waitForState(
      states,
      (state) =>
        state.status === 'supported' &&
        state.identity.canonicalUrl.endsWith('/latest'),
    );
    const laterSupported = states
      .filter(({ status }) => status === 'supported')
      .slice(supportedBefore);

    expect(laterSupported).toHaveLength(1);
    expect(laterSupported[0]).toMatchObject({
      representativeUrl: 'https://example.com/latest',
      title: 'latest',
    });
    expect(flushPendingSave).toHaveBeenCalledOnce();
  });

  it('reuses one successful in-flight flush when a newer navigation supersedes its target', async () => {
    const tabs = new FakeTabs();
    tabs.activeTab = {
      id: 1,
      url: 'https://example.com/start',
      title: 'Start',
    };
    const pendingFlush = deferred<void>();
    const { controller, states, flushPendingSave } = createHarness(tabs, {
      flushPendingSave: () => pendingFlush.promise,
    });

    controller.start();
    await waitForState(states, ({ status }) => status === 'supported');

    tabs.update(
      1,
      { url: 'https://example.com/stale-target' },
      {
        id: 1,
        url: 'https://example.com/stale-target',
        title: 'Stale target',
      },
    );
    await vi.waitFor(() => {
      expect(flushPendingSave).toHaveBeenCalledOnce();
    });
    tabs.update(
      1,
      { url: 'https://example.com/latest-target' },
      {
        id: 1,
        url: 'https://example.com/latest-target',
        title: 'Latest target',
      },
    );
    pendingFlush.resolve();
    await waitForState(
      states,
      (state) =>
        state.status === 'supported' &&
        state.representativeUrl.endsWith('/latest-target'),
    );

    expect(flushPendingSave).toHaveBeenCalledOnce();
    expect(
      states.some(
        (state) =>
          state.status === 'supported' &&
          state.representativeUrl.endsWith('/stale-target'),
      ),
    ).toBe(false);
  });

  it('invalidates a stale flush after returning to the current document so a later switch flushes again', async () => {
    const tabs = new FakeTabs();
    tabs.activeTab = {
      id: 1,
      url: 'https://example.com/a',
      title: 'A',
    };
    const firstFlush = deferred<void>();
    const secondFlush = deferred<void>();
    let flushCount = 0;
    const { controller, states, flushPendingSave } = createHarness(tabs, {
      flushPendingSave: () => {
        flushCount += 1;

        return flushCount === 1 ? firstFlush.promise : secondFlush.promise;
      },
    });

    controller.start();
    await waitForState(states, ({ status }) => status === 'supported');
    tabs.update(
      1,
      { url: 'https://example.com/b', title: 'B' },
      { id: 1, url: 'https://example.com/b', title: 'B' },
    );
    await vi.waitFor(() => {
      expect(flushPendingSave).toHaveBeenCalledOnce();
    });

    tabs.update(
      1,
      { url: 'https://example.com/a', title: 'Returned to A' },
      {
        id: 1,
        url: 'https://example.com/a',
        title: 'Returned to A',
      },
    );
    firstFlush.resolve();
    await waitForState(
      states,
      (state) =>
        state.status === 'supported' && state.title === 'Returned to A',
    );
    expect(flushPendingSave).toHaveBeenCalledOnce();

    tabs.update(
      1,
      { title: 'Edited again on A' },
      {
        id: 1,
        url: 'https://example.com/a',
        title: 'Edited again on A',
      },
    );
    await waitForState(
      states,
      (state) =>
        state.status === 'supported' && state.title === 'Edited again on A',
    );
    tabs.update(
      1,
      { url: 'https://example.com/c', title: 'C' },
      { id: 1, url: 'https://example.com/c', title: 'C' },
    );
    await vi.waitFor(() => {
      expect(flushPendingSave).toHaveBeenCalledTimes(2);
    });
    secondFlush.resolve();
    await waitForState(
      states,
      (state) =>
        state.status === 'supported' && state.representativeUrl.endsWith('/c'),
    );

    expect(flushPendingSave).toHaveBeenCalledTimes(2);
    expect(
      states.some(
        (state) =>
          state.status === 'supported' &&
          state.representativeUrl.endsWith('/b'),
      ),
    ).toBe(false);
  });

  it('uses a fresh defensive exclusions snapshot for every page resolution', async () => {
    const tabs = new FakeTabs();
    tabs.activeTab = {
      id: 1,
      url: 'https://example.com/path?session=one&view=full',
      title: 'First',
    };
    let currentExclusions: PageIdentityExclusionRule[] = [
      {
        origin: 'https://example.com',
        parameterNames: ['session'],
      },
    ];
    const settings: ActivePageSettings = {
      getPageIdentityExclusions: vi.fn(() =>
        Promise.resolve(currentExclusions),
      ),
    };
    const identity = new FakeIdentity();
    const { controller, states, flushPendingSave } = createHarness(tabs, {
      settings,
      identity,
    });

    controller.start();
    await waitForState(
      states,
      (state) =>
        state.status === 'supported' &&
        state.identity.canonicalUrl.endsWith('?view=full'),
    );
    const firstSnapshot = identity.identify.mock.calls[0]?.[1];

    (currentExclusions[0]?.parameterNames as string[] | undefined)?.push(
      'mutated-after-read',
    );
    expect(firstSnapshot).toEqual([
      {
        origin: 'https://example.com',
        parameterNames: ['session'],
      },
    ]);

    currentExclusions = [
      {
        origin: 'https://example.com',
        parameterNames: ['view'],
      },
    ];
    tabs.update(
      1,
      { title: 'Second' },
      {
        id: 1,
        url: 'https://example.com/path?session=one&view=full',
        title: 'Second',
      },
    );
    await waitForState(
      states,
      (state) =>
        state.status === 'supported' &&
        state.identity.canonicalUrl.endsWith('?session=one'),
    );
    const secondSnapshot = identity.identify.mock.calls.at(-1)?.[1];

    (currentExclusions[0]?.parameterNames as string[] | undefined)?.push(
      'mutated-again',
    );
    expect(secondSnapshot).toEqual([
      {
        origin: 'https://example.com',
        parameterNames: ['view'],
      },
    ]);
    expect(secondSnapshot).not.toBe(firstSnapshot);
    expect(flushPendingSave).toHaveBeenCalledOnce();
  });
});

describe('ActivePageSessionController errors and stale work', () => {
  it('publishes a current active-tab update that arrives before the initial query completes', async () => {
    const tabs = new FakeTabs();
    const slowInitialQuery = deferred<ActivePageTab | undefined>();
    let queryCount = 0;
    tabs.activeTab = {
      id: 1,
      url: 'https://example.com/initial',
      title: 'Initial',
    };
    tabs.queryImplementation = () => {
      queryCount += 1;

      return queryCount === 1
        ? slowInitialQuery.promise
        : Promise.resolve(cloneTab(tabs.activeTab));
    };
    const { controller, states, flushPendingSave } = createHarness(tabs);

    controller.start();
    tabs.activeTab = {
      id: 1,
      url: 'https://example.com/updated-before-query',
      title: 'Updated before query',
    };
    tabs.update(
      1,
      {
        url: 'https://example.com/updated-before-query',
        title: 'Updated before query',
      },
      tabs.activeTab,
    );
    await waitForState(
      states,
      (state) =>
        state.status === 'supported' &&
        state.representativeUrl.endsWith('/updated-before-query'),
    );

    slowInitialQuery.resolve({
      id: 1,
      url: 'https://example.com/stale-initial',
      title: 'Stale initial',
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(lastState(states)).toMatchObject({
      status: 'supported',
      representativeUrl: 'https://example.com/updated-before-query',
      title: 'Updated before query',
    });
    expect(
      states.some(
        (state) =>
          state.status === 'supported' &&
          state.representativeUrl.endsWith('/stale-initial'),
      ),
    ).toBe(false);
    expect(flushPendingSave).not.toHaveBeenCalled();
  });

  it('publishes authoritative current state when a relevant startup update is followed by another-tab update', async () => {
    const tabs = new FakeTabs();
    const slowInitialQuery = deferred<ActivePageTab | undefined>();
    let queryCount = 0;
    tabs.activeTab = {
      id: 1,
      url: 'https://example.com/current',
      title: 'Current',
    };
    tabs.queryImplementation = () => {
      queryCount += 1;

      return queryCount === 1
        ? slowInitialQuery.promise
        : Promise.resolve(cloneTab(tabs.activeTab));
    };
    const { controller, states } = createHarness(tabs);

    controller.start();
    tabs.activeTab = {
      id: 1,
      url: 'https://example.com/current-updated',
      title: 'Current updated',
    };
    tabs.update(
      1,
      {
        url: 'https://example.com/current-updated',
        title: 'Current updated',
      },
      tabs.activeTab,
    );
    tabs.update(
      9,
      { title: 'Other window update' },
      {
        id: 9,
        url: 'https://other.example/page',
        title: 'Other window update',
      },
    );
    await waitForState(
      states,
      (state) =>
        state.status === 'supported' &&
        state.representativeUrl.endsWith('/current-updated'),
    );

    slowInitialQuery.resolve({
      id: 1,
      url: 'https://example.com/stale',
      title: 'Stale',
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(lastState(states)).toMatchObject({
      status: 'supported',
      representativeUrl: 'https://example.com/current-updated',
      title: 'Current updated',
    });
  });

  it('publishes no-active-tab when the latest unconfirmed startup update has no authoritative tab', async () => {
    const tabs = new FakeTabs();
    const slowInitialQuery = deferred<ActivePageTab | undefined>();
    let queryCount = 0;
    tabs.activeTab = {
      id: 1,
      url: 'https://example.com/stale',
      title: 'Stale',
    };
    tabs.queryImplementation = () => {
      queryCount += 1;

      return queryCount === 1
        ? slowInitialQuery.promise
        : Promise.resolve(cloneTab(tabs.activeTab));
    };
    const { controller, states } = createHarness(tabs);

    controller.start();
    tabs.activeTab = undefined;
    tabs.update(
      9,
      { title: 'No longer active' },
      {
        id: 9,
        url: 'https://other.example/page',
        title: 'No longer active',
      },
    );
    await waitForState(
      states,
      (state) =>
        state.status === 'unsupported' && state.reason === 'no-active-tab',
    );

    slowInitialQuery.resolve({
      id: 1,
      url: 'https://example.com/stale',
      title: 'Stale',
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(lastState(states)).toEqual({
      status: 'unsupported',
      reason: 'no-active-tab',
      title: '',
    });
    expect(states.some(({ status }) => status === 'supported')).toBe(false);
  });

  it('lets a newer activation publish before a slow initial query and ignores its stale completion', async () => {
    const tabs = new FakeTabs();
    const slowQuery = deferred<ActivePageTab | undefined>();
    let queryCount = 0;
    tabs.queryImplementation = () => {
      queryCount += 1;

      return queryCount === 1
        ? slowQuery.promise
        : Promise.resolve(cloneTab(tabs.activeTab));
    };
    tabs.tabs.set(2, {
      id: 2,
      url: 'https://example.com/newer',
      title: 'Newer',
    });
    const { controller, states, flushPendingSave } = createHarness(tabs);

    controller.start();
    tabs.activate({ tabId: 2 });
    await waitForState(
      states,
      (state) =>
        state.status === 'supported' &&
        state.identity.canonicalUrl.endsWith('/newer'),
    );

    slowQuery.resolve({
      id: 1,
      url: 'https://example.com/stale',
      title: 'Stale',
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(lastState(states)).toMatchObject({
      status: 'supported',
      representativeUrl: 'https://example.com/newer',
    });
    expect(
      states.some(
        (state) =>
          state.status === 'supported' &&
          state.representativeUrl.endsWith('/stale'),
      ),
    ).toBe(false);
    expect(flushPendingSave).not.toHaveBeenCalled();
  });

  it('lets an update for a newly activated tab supersede the activation query snapshot', async () => {
    const tabs = new FakeTabs();
    tabs.activeTab = {
      id: 1,
      url: 'https://example.com/first',
      title: 'First',
    };
    const { controller, states, flushPendingSave } = createHarness(tabs);

    controller.start();
    await waitForState(states, ({ status }) => status === 'supported');

    const oldActivatedTab = {
      id: 2,
      url: 'https://example.com/activated-old',
      title: 'Activated old',
    };
    const updatedActivatedTab = {
      id: 2,
      url: 'https://example.com/activated-new',
      title: 'Activated new',
    };
    const activationQuery = deferred<ActivePageTab | undefined>();
    let activationQueryCount = 0;
    tabs.tabs.set(2, oldActivatedTab);
    tabs.queryImplementation = () => {
      activationQueryCount += 1;

      return activationQueryCount === 1
        ? activationQuery.promise
        : Promise.resolve(cloneTab(tabs.activeTab));
    };

    tabs.activate({ tabId: 2 });
    tabs.activeTab = updatedActivatedTab;
    tabs.update(
      2,
      {
        url: updatedActivatedTab.url,
        title: updatedActivatedTab.title,
      },
      updatedActivatedTab,
    );
    await waitForState(
      states,
      (state) =>
        state.status === 'supported' &&
        state.representativeUrl === updatedActivatedTab.url,
    );

    activationQuery.resolve(oldActivatedTab);
    await Promise.resolve();
    await Promise.resolve();

    expect(lastState(states)).toMatchObject({
      status: 'supported',
      representativeUrl: updatedActivatedTab.url,
      title: updatedActivatedTab.title,
    });
    expect(
      states.some(
        (state) =>
          state.status === 'supported' &&
          state.representativeUrl === oldActivatedTab.url,
      ),
    ).toBe(false);
    expect(flushPendingSave).toHaveBeenCalledOnce();
  });

  it('ignores a Chrome-wide activation whose tab is not active in the current window', async () => {
    const tabs = new FakeTabs();
    tabs.activeTab = {
      id: 1,
      url: 'https://example.com/current-window',
      title: 'Current window',
    };
    tabs.tabs.set(2, {
      id: 2,
      url: 'https://example.com/other-window',
      title: 'Other window',
    });
    const { controller, states, flushPendingSave } = createHarness(tabs);

    controller.start();
    await waitForState(states, ({ status }) => status === 'supported');
    const stateCount = states.length;
    tabs.activate({ tabId: 2 }, { currentWindow: false });
    await vi.waitFor(() => {
      expect(
        tabs.queryCurrentWindowActiveTab.mock.calls.length,
      ).toBeGreaterThan(1);
      expect(states.length).toBeGreaterThan(stateCount);
    });

    expect(lastState(states)).toMatchObject({
      status: 'supported',
      representativeUrl: 'https://example.com/current-window',
    });
    expect(flushPendingSave).not.toHaveBeenCalled();
  });

  it('ignores a slow stale identity result after a newer URL is published', async () => {
    const tabs = new FakeTabs();
    tabs.activeTab = {
      id: 1,
      url: 'https://example.com/start',
      title: 'Start',
    };
    const identity = new FakeIdentity();
    const slowIdentity = deferred<PageIdentityResult>();
    const defaultIdentity = new DefaultPageIdentityService();
    identity.implementation = (rawUrl, exclusions) =>
      rawUrl.endsWith('/slow')
        ? slowIdentity.promise
        : defaultIdentity.identify(rawUrl, exclusions);
    const { controller, states, flushPendingSave } = createHarness(tabs, {
      identity,
    });

    controller.start();
    await waitForState(states, ({ status }) => status === 'supported');

    tabs.update(
      1,
      { url: 'https://example.com/slow' },
      { id: 1, url: 'https://example.com/slow', title: 'Slow' },
    );
    await vi.waitFor(() => {
      expect(identity.identify).toHaveBeenCalledWith(
        'https://example.com/slow',
        [],
      );
    });
    tabs.update(
      1,
      { url: 'https://example.com/latest' },
      { id: 1, url: 'https://example.com/latest', title: 'Latest' },
    );
    await waitForState(
      states,
      (state) =>
        state.status === 'supported' &&
        state.representativeUrl.endsWith('/latest'),
    );
    slowIdentity.resolve(
      await defaultIdentity.identify('https://example.com/slow'),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(lastState(states)).toMatchObject({
      status: 'supported',
      representativeUrl: 'https://example.com/latest',
    });
    expect(flushPendingSave).toHaveBeenCalledOnce();
  });

  it('waits for flush completion before publishing a different document', async () => {
    const tabs = new FakeTabs();
    tabs.activeTab = {
      id: 1,
      url: 'https://example.com/first',
      title: 'First',
    };
    const pendingFlush = deferred<void>();
    const { controller, states, flushPendingSave } = createHarness(tabs, {
      flushPendingSave: () => pendingFlush.promise,
    });

    controller.start();
    await waitForState(states, ({ status }) => status === 'supported');
    const stateCount = states.length;
    tabs.update(
      1,
      { url: 'https://example.com/second' },
      { id: 1, url: 'https://example.com/second', title: 'Second' },
    );
    await vi.waitFor(() => {
      expect(flushPendingSave).toHaveBeenCalledOnce();
    });

    expect(states).toHaveLength(stateCount);
    pendingFlush.resolve();
    await waitForState(
      states,
      (state) =>
        state.status === 'supported' &&
        state.representativeUrl.endsWith('/second'),
    );
  });

  it('publishes an actionable error and withholds the target when flush rejects', async () => {
    const tabs = new FakeTabs();
    tabs.activeTab = {
      id: 1,
      url: 'https://example.com/first',
      title: 'First',
    };
    const flushFailure = new Error('local write failed');
    const { controller, states } = createHarness(tabs, {
      flushPendingSave: () => Promise.reject(flushFailure),
    });

    controller.start();
    await waitForState(states, ({ status }) => status === 'supported');
    tabs.update(
      1,
      { url: 'https://example.com/second' },
      { id: 1, url: 'https://example.com/second', title: 'Second' },
    );
    await waitForState(
      states,
      (state) =>
        state.status === 'error' &&
        state.reason === 'pending-save-flush-failed',
    );

    const state = lastState(states);
    expect(state).toMatchObject({
      status: 'error',
      reason: 'pending-save-flush-failed',
    });
    expect(state.status === 'error' ? state.message : '').toContain('save');
    expect(
      states.some(
        (state) =>
          state.status === 'supported' &&
          state.representativeUrl.endsWith('/second'),
      ),
    ).toBe(false);
  });

  it('uses an authoritative no-active-tab result for a malformed activation event', async () => {
    const tabs = new FakeTabs();
    tabs.activeTab = {
      id: 1,
      url: 'https://example.com/first',
      title: 'First',
    };
    const { controller, states, flushPendingSave } = createHarness(tabs);

    controller.start();
    await waitForState(states, ({ status }) => status === 'supported');
    tabs.activate({ tabId: 99 });
    await waitForState(
      states,
      (state) =>
        state.status === 'unsupported' && state.reason === 'no-active-tab',
    );

    expect(lastState(states)).toMatchObject({
      status: 'unsupported',
      reason: 'no-active-tab',
    });
    expect(flushPendingSave).toHaveBeenCalledOnce();
  });

  it('routes an activation from the authoritative current tab and ignores old inactive updates', async () => {
    const tabs = new FakeTabs();
    tabs.activeTab = {
      id: 1,
      url: 'https://example.com/first',
      title: 'First',
    };
    tabs.tabs.set(2, {
      id: 2,
      url: 'https://example.com/actual-current',
      title: 'Actual current',
    });
    const settings = new FakeSettings();
    const { controller, states, flushPendingSave } = createHarness(tabs, {
      settings,
    });

    controller.start();
    await waitForState(states, ({ status }) => status === 'supported');
    tabs.activate({ tabId: Number.NaN });
    tabs.activeTab = cloneTab(tabs.tabs.get(2));
    tabs.activate({ tabId: 2 }, { currentWindow: false });
    await waitForState(
      states,
      (state) =>
        state.status === 'supported' &&
        state.representativeUrl.endsWith('/actual-current'),
    );
    const stateCount = states.length;
    const settingsCalls = settings.getPageIdentityExclusions.mock.calls.length;

    tabs.update(
      1,
      { title: 'Inactive old tab' },
      {
        id: 1,
        url: 'https://example.com/first',
        title: 'Inactive old tab',
      },
    );
    await Promise.resolve();

    expect(lastState(states)).toMatchObject({
      status: 'supported',
      representativeUrl: 'https://example.com/actual-current',
    });
    expect(states).toHaveLength(stateCount);
    expect(settings.getPageIdentityExclusions).toHaveBeenCalledTimes(
      settingsCalls,
    );
    expect(flushPendingSave).toHaveBeenCalledOnce();
  });

  it.each(['wrong digest', 'unrelated identity'] as const)(
    'rejects a supported runtime identity with a %s',
    async (failureKind) => {
      const tabs = new FakeTabs();
      const rawUrl = 'https://example.com/requested';
      tabs.activeTab = {
        id: 1,
        url: rawUrl,
        title: 'Requested',
      };
      const identity = new FakeIdentity();
      const defaultIdentity = new DefaultPageIdentityService();
      const supported =
        failureKind === 'wrong digest'
          ? await defaultIdentity.identify(rawUrl)
          : await defaultIdentity.identify('https://other.example/unrelated');

      if (supported.status !== 'supported') {
        throw new Error('Expected a supported identity fixture.');
      }

      identity.implementation = () =>
        Promise.resolve({
          status: 'supported',
          identity:
            failureKind === 'wrong digest'
              ? {
                  ...supported.identity,
                  pageKey: 'A'.repeat(43),
                }
              : supported.identity,
        });
      const unhandledRejection = vi.fn();
      process.on('unhandledRejection', unhandledRejection);

      try {
        const { controller, states, flushPendingSave } = createHarness(tabs, {
          identity,
        });

        controller.start();
        await waitForState(
          states,
          (state) =>
            state.status === 'error' && state.reason === 'identity-failed',
        );
        await Promise.resolve();
        await Promise.resolve();

        expect(states.some(({ status }) => status === 'supported')).toBe(false);
        expect(flushPendingSave).not.toHaveBeenCalled();
        expect(unhandledRejection).not.toHaveBeenCalled();
      } finally {
        process.off('unhandledRejection', unhandledRejection);
      }
    },
  );

  it('rejects a valid identity for a different meaningful query on the same origin and path', async () => {
    const tabs = new FakeTabs();
    const rawUrl = 'https://example.com/path?view=one';
    tabs.activeTab = { id: 1, url: rawUrl, title: 'Requested query' };
    const identity = new FakeIdentity();
    const otherQueryIdentity = await derivePageIdentity(
      'https://example.com/path?view=two',
    );
    identity.implementation = () => Promise.resolve(otherQueryIdentity);
    const { controller, states, flushPendingSave } = createHarness(tabs, {
      identity,
    });

    controller.start();
    await waitForState(
      states,
      (state) => state.status === 'error' && state.reason === 'identity-failed',
    );

    expect(states.some(({ status }) => status === 'supported')).toBe(false);
    expect(flushPendingSave).not.toHaveBeenCalled();
  });

  it('keeps verification exclusions stable if the injected identity mutates its input', async () => {
    const tabs = new FakeTabs();
    const rawUrl = 'https://example.com/path?session=one&view=full';
    tabs.activeTab = { id: 1, url: rawUrl, title: 'Requested exclusions' };
    const settings = new FakeSettings();
    settings.exclusions = [
      {
        origin: 'https://example.com',
        parameterNames: ['session'],
      },
    ];
    const identity = new FakeIdentity();
    identity.implementation = (url, exclusions) => {
      const firstRule = exclusions[0];

      if (firstRule !== undefined) {
        (firstRule.parameterNames as string[]).push('view');
      }

      return derivePageIdentity(url, exclusions);
    };
    const { controller, states } = createHarness(tabs, {
      identity,
      settings,
    });

    controller.start();
    await waitForState(
      states,
      (state) => state.status === 'error' && state.reason === 'identity-failed',
    );

    expect(settings.exclusions).toEqual([
      {
        origin: 'https://example.com',
        parameterNames: ['session'],
      },
    ]);
    expect(states.some(({ status }) => status === 'supported')).toBe(false);
  });

  it('rejects an unsorted canonical query even when its digest is correct', async () => {
    const tabs = new FakeTabs();
    const rawUrl = 'https://example.com/path?b=2&a=1';
    tabs.activeTab = { id: 1, url: rawUrl, title: 'Unsorted query' };
    const identity = new FakeIdentity();
    const unsortedPageKey = await createPageIdentityKey(rawUrl);
    identity.implementation = () =>
      Promise.resolve({
        status: 'supported',
        identity: {
          canonicalUrl: rawUrl,
          isRoot: false,
          origin: 'https://example.com',
          pageKey: unsortedPageKey,
          pathname: '/path',
        },
      });
    const { controller, states, flushPendingSave } = createHarness(tabs, {
      identity,
    });

    controller.start();
    await waitForState(
      states,
      (state) => state.status === 'error' && state.reason === 'identity-failed',
    );

    expect(states.some(({ status }) => status === 'supported')).toBe(false);
    expect(flushPendingSave).not.toHaveBeenCalled();
  });

  it('converts crypto rejection during identity verification into a handled error', async () => {
    const tabs = new FakeTabs();
    const rawUrl = 'https://example.com/verification';
    tabs.activeTab = { id: 1, url: rawUrl, title: 'Verification' };
    const identity = new FakeIdentity();
    const validResult = await derivePageIdentity(rawUrl);
    identity.implementation = () => Promise.resolve(validResult);
    const digest = vi
      .spyOn(crypto.subtle, 'digest')
      .mockRejectedValueOnce(new Error('crypto unavailable'));
    const unhandledRejection = vi.fn();
    process.on('unhandledRejection', unhandledRejection);

    try {
      const { controller, states, flushPendingSave } = createHarness(tabs, {
        identity,
      });

      controller.start();
      await waitForState(
        states,
        (state) =>
          state.status === 'error' && state.reason === 'identity-failed',
      );
      await Promise.resolve();
      await Promise.resolve();

      expect(states.some(({ status }) => status === 'supported')).toBe(false);
      expect(flushPendingSave).not.toHaveBeenCalled();
      expect(unhandledRejection).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandledRejection);
      digest.mockRestore();
    }
  });

  it.each([
    ['undefined', () => undefined],
    ['null', () => null],
    ['unknown status', () => ({ status: 'mystery' })],
    [
      'malformed unsupported result',
      () => ({ status: 'unsupported', reason: 'unsupported-scheme' }),
    ],
    [
      'unknown unsupported reason',
      () => ({ status: 'unsupported', reason: 'mystery' }),
    ],
    ['missing supported identity', () => ({ status: 'supported' })],
    [
      'malformed supported identity',
      () => ({
        status: 'supported',
        identity: {
          canonicalUrl: 'https://example.com/path',
          isRoot: false,
          origin: 'https://example.com',
          pageKey: 'not-a-page-key',
          pathname: '/path',
        },
      }),
    ],
    [
      'throwing result getter',
      () =>
        Object.defineProperty({}, 'status', {
          get() {
            throw new Error('malformed result getter');
          },
        }),
    ],
  ] as readonly (readonly [string, () => unknown])[])(
    'converts identity runtime boundary value %s into an error state',
    async (_description, createValue) => {
      const tabs = new FakeTabs();
      tabs.activeTab = {
        id: 1,
        url: 'https://example.com/runtime-boundary',
        title: 'Runtime boundary',
      };
      const identity = new FakeIdentity();
      identity.implementation = () => Promise.resolve(createValue());
      const unhandledRejection = vi.fn();
      process.on('unhandledRejection', unhandledRejection);

      try {
        const { controller, states } = createHarness(tabs, { identity });

        controller.start();
        await waitForState(
          states,
          (state) =>
            state.status === 'error' && state.reason === 'identity-failed',
        );
        await Promise.resolve();
        await Promise.resolve();

        expect(lastState(states)).toMatchObject({
          status: 'error',
          reason: 'identity-failed',
          tabId: 1,
        });
        expect(unhandledRejection).not.toHaveBeenCalled();
      } finally {
        process.off('unhandledRejection', unhandledRejection);
      }
    },
  );

  it.each(['settings', 'identity'] as const)(
    'flushes before a page-resolution %s error',
    async (failureSource) => {
      const tabs = new FakeTabs();
      tabs.activeTab = {
        id: 1,
        url: 'https://example.com/first',
        title: 'First',
      };
      const settings = new FakeSettings();
      const identity = new FakeIdentity();
      const { controller, states, flushPendingSave } = createHarness(tabs, {
        settings,
        identity,
      });

      controller.start();
      await waitForState(states, ({ status }) => status === 'supported');

      if (failureSource === 'settings') {
        settings.failure = new Error('settings failed');
      } else {
        identity.implementation = () =>
          Promise.reject(new Error('identity failed'));
      }

      tabs.update(
        1,
        { url: 'https://example.com/second' },
        { id: 1, url: 'https://example.com/second', title: 'Second' },
      );
      await waitForState(
        states,
        (state) =>
          state.status === 'error' &&
          state.reason ===
            `${failureSource}-load-failed`.replace('identity-load', 'identity'),
      );

      expect(flushPendingSave).toHaveBeenCalledOnce();
      expect(lastState(states)).toMatchObject({
        status: 'error',
        reason:
          failureSource === 'settings'
            ? 'settings-load-failed'
            : 'identity-failed',
      });
    },
  );
});

describe('ActivePageSessionController lifecycle and ownership', () => {
  it('cleans up idempotently and suppresses in-flight or later event emissions', async () => {
    const tabs = new FakeTabs();
    const pendingQuery = deferred<ActivePageTab | undefined>();
    tabs.queryImplementation = () => pendingQuery.promise;
    tabs.tabs.set(2, {
      id: 2,
      url: 'https://example.com/later',
      title: 'Later',
    });
    const { controller, states } = createHarness(tabs);

    const cleanup = controller.start();
    controller.start();
    cleanup();
    controller.stop();
    tabs.activate({ tabId: 2 });
    pendingQuery.resolve({
      id: 1,
      url: 'https://example.com/stale',
      title: 'Stale',
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(states).toEqual([{ status: 'loading' }]);
    expect(tabs.queryCurrentWindowActiveTab).toHaveBeenCalledOnce();
    expect(tabs.activatedUnsubscribeCalls).toBe(1);
    expect(tabs.updatedUnsubscribeCalls).toBe(1);
    expect(tabs.activatedListeners.size).toBe(0);
    expect(tabs.updatedListeners.size).toBe(0);
  });

  it('keeps emitted and returned state data defensive', async () => {
    const tabs = new FakeTabs();
    tabs.activeTab = {
      id: 1,
      url: 'https://example.com/path',
      title: 'Original title',
    };
    const emitted: ActivePageSessionState[] = [];
    const harness = createHarness(tabs, {
      emitState: (state) => {
        emitted.push(state);

        if (state.status === 'supported') {
          (state as { title: string }).title = 'Mutated callback title';
          (state.identity as { canonicalUrl: string }).canonicalUrl =
            'https://mutated.example/';
        }
      },
    });
    const controller = harness.controller;

    controller.start();
    await vi.waitFor(() => {
      expect(controller.getState().status).toBe('supported');
    });
    const firstRead = controller.getState();

    expect(firstRead).toMatchObject({
      status: 'supported',
      title: 'Original title',
      identity: { canonicalUrl: 'https://example.com/path' },
    });

    if (firstRead.status !== 'supported') {
      throw new Error('Expected a supported defensive state.');
    }

    (firstRead as { title: string }).title = 'Mutated returned title';
    (firstRead.identity as { canonicalUrl: string }).canonicalUrl =
      'https://returned-mutation.example/';
    expect(controller.getState()).toMatchObject({
      status: 'supported',
      title: 'Original title',
      identity: { canonicalUrl: 'https://example.com/path' },
    });
    expect(emitted).toHaveLength(2);
  });
});
