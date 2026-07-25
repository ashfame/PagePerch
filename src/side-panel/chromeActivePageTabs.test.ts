import { describe, expect, it, vi } from 'vitest';

import {
  ChromeActivePageTabs,
  type ChromeTabsPort,
} from './chromeActivePageTabs';

type ActivatedListener = (activeInfo: chrome.tabs.OnActivatedInfo) => void;
type UpdatedListener = (
  tabId: number,
  changeInfo: chrome.tabs.OnUpdatedInfo,
  tab: chrome.tabs.Tab,
) => void;

function eventPort<Listener>() {
  const listeners = new Set<Listener>();

  return {
    listeners,
    addListener: vi.fn((listener: Listener) => {
      listeners.add(listener);
    }),
    removeListener: vi.fn((listener: Listener) => {
      listeners.delete(listener);
    }),
  };
}

function chromeTab(overrides: Partial<chrome.tabs.Tab> = {}): chrome.tabs.Tab {
  return {
    active: true,
    autoDiscardable: true,
    discarded: false,
    frozen: false,
    groupId: -1,
    highlighted: true,
    incognito: false,
    index: 0,
    pinned: false,
    selected: true,
    windowId: 4,
    ...overrides,
  };
}

function createTabsPort() {
  const onActivated = eventPort<ActivatedListener>();
  const onUpdated = eventPort<UpdatedListener>();
  const query = vi.fn<ChromeTabsPort['query']>(() => Promise.resolve([]));
  const port: ChromeTabsPort = {
    query,
    onActivated,
    onUpdated,
  };

  return { onActivated, onUpdated, port, query };
}

describe('ChromeActivePageTabs', () => {
  it('queries only the current window active tab and returns a safe snapshot', async () => {
    const { port, query } = createTabsPort();
    const source = chromeTab({
      id: 12,
      title: 'Current page',
      url: 'https://example.com/path',
    });
    query.mockResolvedValueOnce([source]);
    const tabs = new ChromeActivePageTabs(port);
    const snapshot = await tabs.queryCurrentWindowActiveTab();

    expect(query).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledWith({
      active: true,
      currentWindow: true,
    });
    expect(snapshot).toEqual({
      id: 12,
      title: 'Current page',
      url: 'https://example.com/path',
    });
    expect(snapshot).not.toBe(source);

    source.title = 'Mutated source';
    expect(snapshot?.title).toBe('Current page');
  });

  it('returns undefined for an empty query and propagates query failures', async () => {
    const { port, query } = createTabsPort();
    const tabs = new ChromeActivePageTabs(port);

    await expect(tabs.queryCurrentWindowActiveTab()).resolves.toBeUndefined();

    const failure = new Error('tabs query failed');
    query.mockRejectedValueOnce(failure);
    await expect(tabs.queryCurrentWindowActiveTab()).rejects.toBe(failure);
  });

  it('omits absent or invalid optional tab fields from query snapshots', async () => {
    const { port, query } = createTabsPort();
    query.mockResolvedValueOnce([chromeTab()]).mockResolvedValueOnce([
      {
        ...chromeTab(),
        id: 'invalid-id',
        title: null,
        url: 42,
      } as unknown as chrome.tabs.Tab,
    ]);
    const tabs = new ChromeActivePageTabs(port);

    await expect(tabs.queryCurrentWindowActiveTab()).resolves.toEqual({});
    await expect(tabs.queryCurrentWindowActiveTab()).resolves.toEqual({});
  });

  it('forwards activation signals and removes the exact Chrome listener once', () => {
    const { onActivated, port } = createTabsPort();
    const tabs = new ChromeActivePageTabs(port);
    const listener = vi.fn();
    const unsubscribe = tabs.subscribeActivated(listener);
    const [chromeListener] = onActivated.listeners;

    expect(onActivated.addListener).toHaveBeenCalledOnce();
    expect(chromeListener).toBeDefined();
    chromeListener?.({ tabId: 8, windowId: 99 });
    expect(listener).toHaveBeenCalledWith({ tabId: 8 });

    unsubscribe();
    unsubscribe();
    expect(onActivated.removeListener).toHaveBeenCalledOnce();
    expect(onActivated.removeListener).toHaveBeenCalledWith(chromeListener);
    expect(onActivated.listeners).toHaveLength(0);
  });

  it('forwards safe update snapshots and removes the exact Chrome listener once', () => {
    const { onUpdated, port } = createTabsPort();
    const tabs = new ChromeActivePageTabs(port);
    const listener = vi.fn();
    const unsubscribe = tabs.subscribeUpdated(listener);
    const [chromeListener] = onUpdated.listeners;
    const source = chromeTab({
      id: 5,
      title: 'Updated title',
      url: 'https://example.com/updated',
    });

    expect(onUpdated.addListener).toHaveBeenCalledOnce();
    chromeListener?.(
      5,
      {
        status: 'complete',
        title: 'Updated title',
        url: 'https://example.com/updated',
      },
      source,
    );
    expect(listener).toHaveBeenCalledWith(
      5,
      {
        title: 'Updated title',
        url: 'https://example.com/updated',
      },
      {
        id: 5,
        title: 'Updated title',
        url: 'https://example.com/updated',
      },
    );

    source.url = 'https://mutated.example/';
    expect(listener.mock.calls[0]?.[2]).toEqual({
      id: 5,
      title: 'Updated title',
      url: 'https://example.com/updated',
    });

    chromeListener?.(
      5,
      {
        title: null,
        url: 42,
      } as unknown as chrome.tabs.OnUpdatedInfo,
      {
        ...chromeTab(),
        id: 'invalid-id',
        title: null,
        url: 42,
      } as unknown as chrome.tabs.Tab,
    );
    expect(listener).toHaveBeenLastCalledWith(5, {}, {});

    unsubscribe();
    unsubscribe();
    expect(onUpdated.removeListener).toHaveBeenCalledOnce();
    expect(onUpdated.removeListener).toHaveBeenCalledWith(chromeListener);
  });

  it('propagates Chrome listener registration and removal failures', () => {
    const { onActivated, port } = createTabsPort();
    const registrationFailure = new Error('registration failed');
    onActivated.addListener.mockImplementationOnce(() => {
      throw registrationFailure;
    });
    const tabs = new ChromeActivePageTabs(port);

    expect(() => tabs.subscribeActivated(vi.fn())).toThrow(registrationFailure);

    const unsubscribe = tabs.subscribeActivated(vi.fn());
    const removalFailure = new Error('removal failed');
    onActivated.removeListener.mockImplementationOnce(() => {
      throw removalFailure;
    });
    expect(unsubscribe).toThrow(removalFailure);
    expect(unsubscribe).not.toThrow();
    expect(onActivated.removeListener).toHaveBeenCalledOnce();
  });

  it('propagates updated-listener add and remove failures without duplicate cleanup', () => {
    const { onUpdated, port } = createTabsPort();
    const registrationFailure = new Error('updated registration failed');
    onUpdated.addListener.mockImplementationOnce(() => {
      throw registrationFailure;
    });
    const tabs = new ChromeActivePageTabs(port);

    expect(() => tabs.subscribeUpdated(vi.fn())).toThrow(registrationFailure);
    expect(onUpdated.removeListener).not.toHaveBeenCalled();

    const unsubscribe = tabs.subscribeUpdated(vi.fn());
    const removalFailure = new Error('updated removal failed');
    onUpdated.removeListener.mockImplementationOnce(() => {
      throw removalFailure;
    });

    expect(unsubscribe).toThrow(removalFailure);
    expect(unsubscribe).not.toThrow();
    expect(onUpdated.removeListener).toHaveBeenCalledOnce();
  });
});
