import type {
  ActivePageTab,
  ActivePageTabActivatedListener,
  ActivePageTabUpdatedListener,
  ActivePageTabs,
} from './activePageSession';

type ChromeActivatedListener = (
  activeInfo: chrome.tabs.OnActivatedInfo,
) => void;
type ChromeUpdatedListener = (
  tabId: number,
  changeInfo: chrome.tabs.OnUpdatedInfo,
  tab: chrome.tabs.Tab,
) => void;

interface ChromeEventPort<Listener extends (...args: never[]) => void> {
  addListener(listener: Listener): void;
  removeListener(listener: Listener): void;
}

export interface ChromeTabsPort {
  query(queryInfo: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]>;
  readonly onActivated: ChromeEventPort<ChromeActivatedListener>;
  readonly onUpdated: ChromeEventPort<ChromeUpdatedListener>;
}

function snapshotTab(tab: chrome.tabs.Tab): ActivePageTab {
  return {
    ...(typeof tab.id === 'number' ? { id: tab.id } : {}),
    ...(typeof tab.url === 'string' ? { url: tab.url } : {}),
    ...(typeof tab.title === 'string' ? { title: tab.title } : {}),
  };
}

export class ChromeActivePageTabs implements ActivePageTabs {
  readonly #tabs: ChromeTabsPort;

  constructor(tabs: ChromeTabsPort = chrome.tabs) {
    this.#tabs = tabs;
  }

  async queryCurrentWindowActiveTab(): Promise<ActivePageTab | undefined> {
    const tabs = await this.#tabs.query({
      active: true,
      currentWindow: true,
    });
    const activeTab = tabs[0];

    return activeTab === undefined ? undefined : snapshotTab(activeTab);
  }

  subscribeActivated(listener: ActivePageTabActivatedListener): () => void {
    const chromeListener: ChromeActivatedListener = (activeInfo) => {
      listener({ tabId: activeInfo.tabId });
    };
    let subscribed = true;
    this.#tabs.onActivated.addListener(chromeListener);

    return () => {
      if (!subscribed) {
        return;
      }

      subscribed = false;
      this.#tabs.onActivated.removeListener(chromeListener);
    };
  }

  subscribeUpdated(listener: ActivePageTabUpdatedListener): () => void {
    const chromeListener: ChromeUpdatedListener = (tabId, changeInfo, tab) => {
      listener(
        tabId,
        {
          ...(typeof changeInfo.url === 'string'
            ? { url: changeInfo.url }
            : {}),
          ...(typeof changeInfo.title === 'string'
            ? { title: changeInfo.title }
            : {}),
        },
        snapshotTab(tab),
      );
    };
    let subscribed = true;
    this.#tabs.onUpdated.addListener(chromeListener);

    return () => {
      if (!subscribed) {
        return;
      }

      subscribed = false;
      this.#tabs.onUpdated.removeListener(chromeListener);
    };
  }
}
