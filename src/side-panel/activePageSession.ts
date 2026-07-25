import type {
  PageIdentity,
  PageIdentityExclusionRule,
  PageIdentityResult,
} from '../domain/pageIdentity';
import { derivePageIdentity } from '../services/pageIdentity';

export interface ActivePageTab {
  readonly id?: number;
  readonly url?: string;
  readonly title?: string;
}

export interface ActivePageTabActivatedInfo {
  readonly tabId: number;
}

export interface ActivePageTabChangeInfo {
  readonly url?: string;
  readonly title?: string;
}

export type ActivePageTabActivatedListener = (
  info: ActivePageTabActivatedInfo,
) => void;

export type ActivePageTabUpdatedListener = (
  tabId: number,
  changeInfo: ActivePageTabChangeInfo,
  tab: ActivePageTab,
) => void;

export interface ActivePageTabs {
  /** Must resolve only the active tab in the side panel's current browser window. */
  queryCurrentWindowActiveTab(): Promise<ActivePageTab | undefined>;
  /** Receives Chrome-wide activation events; event data is only a refresh signal and never a routing authority. */
  subscribeActivated(listener: ActivePageTabActivatedListener): () => void;
  /** Receives Chrome-wide updates; the controller filters by its confirmed current active tab. */
  subscribeUpdated(listener: ActivePageTabUpdatedListener): () => void;
}

export interface ActivePageIdentity {
  identify(
    rawUrl: string,
    customExclusions?: readonly PageIdentityExclusionRule[],
  ): Promise<unknown>;
}

export interface ActivePageSettings {
  getPageIdentityExclusions(): Promise<readonly PageIdentityExclusionRule[]>;
}

export interface LoadingActivePageSessionState {
  readonly status: 'loading';
}

export interface SupportedActivePageSessionState {
  readonly status: 'supported';
  readonly tabId: number;
  readonly representativeUrl: string;
  readonly title: string;
  readonly identity: PageIdentity;
}

export type UnsupportedActivePageReason =
  | 'no-active-tab'
  | 'missing-tab-id'
  | 'missing-url'
  | 'invalid-url'
  | 'unsupported-scheme';

export interface UnsupportedActivePageSessionState {
  readonly status: 'unsupported';
  readonly reason: UnsupportedActivePageReason;
  readonly tabId?: number;
  readonly representativeUrl?: string;
  readonly title: string;
  readonly protocol?: string;
}

export type ActivePageSessionErrorReason =
  | 'listener-registration-failed'
  | 'active-tab-query-failed'
  | 'settings-load-failed'
  | 'identity-failed'
  | 'pending-save-flush-failed';

export interface ErrorActivePageSessionState {
  readonly status: 'error';
  readonly reason: ActivePageSessionErrorReason;
  readonly message: string;
  readonly tabId?: number;
}

export type ActivePageSessionState =
  | LoadingActivePageSessionState
  | SupportedActivePageSessionState
  | UnsupportedActivePageSessionState
  | ErrorActivePageSessionState;

export interface ActivePageSessionControllerDependencies {
  readonly tabs: ActivePageTabs;
  readonly settings: ActivePageSettings;
  readonly identity: ActivePageIdentity;
  readonly flushPendingSave: () => Promise<void>;
  readonly emitState: (state: ActivePageSessionState) => void;
}

type ResolvedActivePageSessionState = Exclude<
  ActivePageSessionState,
  LoadingActivePageSessionState
>;

const ERROR_MESSAGES: Readonly<Record<ActivePageSessionErrorReason, string>> =
  Object.freeze({
    'listener-registration-failed':
      'PagePerch could not watch the active tab. Reopen the side panel to retry.',
    'active-tab-query-failed':
      'PagePerch could not read the active tab. Reopen the side panel to retry.',
    'settings-load-failed':
      'PagePerch could not load page identity settings. Open settings or retry.',
    'identity-failed':
      'PagePerch could not identify this page. Reload the page or reopen the side panel to retry.',
    'pending-save-flush-failed':
      'PagePerch could not save the previous note before switching pages. Retry after resolving the save error.',
  });

function isTabId(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === 'number' && value >= 0;
}

function cloneIdentity(identity: PageIdentity): PageIdentity {
  return { ...identity };
}

function cloneState(state: ActivePageSessionState): ActivePageSessionState {
  if (state.status === 'supported') {
    return {
      ...state,
      identity: cloneIdentity(state.identity),
    };
  }

  return { ...state };
}

function cloneTab(tab: ActivePageTab): ActivePageTab {
  return { ...tab };
}

function cloneExclusions(
  exclusions: readonly PageIdentityExclusionRule[],
): readonly PageIdentityExclusionRule[] {
  return exclusions.map((rule) => ({
    origin: rule.origin,
    parameterNames: [...rule.parameterNames],
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCanonicalPageKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u.test(value)
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const expected = new Set(keys);

  return (
    Object.keys(value).length === expected.size &&
    Object.keys(value).every((key) => expected.has(key))
  );
}

function readIdentityMetadata(value: unknown): PageIdentity | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'canonicalUrl',
      'isRoot',
      'origin',
      'pageKey',
      'pathname',
    ]) ||
    typeof value.canonicalUrl !== 'string' ||
    typeof value.origin !== 'string' ||
    typeof value.pathname !== 'string' ||
    typeof value.isRoot !== 'boolean' ||
    !isCanonicalPageKey(value.pageKey)
  ) {
    return undefined;
  }

  try {
    const parsed = new URL(value.canonicalUrl);

    if (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.hash === '' &&
      !value.canonicalUrl.includes('#') &&
      !(parsed.search === '' && value.canonicalUrl.includes('?')) &&
      parsed.href === value.canonicalUrl &&
      parsed.origin === value.origin &&
      parsed.pathname === value.pathname &&
      value.isRoot === (parsed.pathname === '/' && parsed.search === '')
    ) {
      return {
        canonicalUrl: value.canonicalUrl,
        isRoot: value.isRoot,
        origin: value.origin,
        pageKey: value.pageKey,
        pathname: value.pathname,
      };
    }

    return undefined;
  } catch {
    return undefined;
  }
}

function readIdentityResult(value: unknown): PageIdentityResult | undefined {
  try {
    if (!isRecord(value) || typeof value.status !== 'string') {
      return undefined;
    }

    if (value.status === 'supported') {
      if (!hasExactKeys(value, ['status', 'identity'])) {
        return undefined;
      }

      const identity = readIdentityMetadata(value.identity);

      if (identity === undefined) {
        return undefined;
      }

      return {
        status: 'supported',
        identity,
      };
    }

    if (value.status !== 'unsupported') {
      return undefined;
    }

    if (value.reason === 'invalid-url') {
      if (!hasExactKeys(value, ['status', 'reason'])) {
        return undefined;
      }

      return {
        status: 'unsupported',
        reason: 'invalid-url',
      };
    }

    if (
      value.reason === 'unsupported-scheme' &&
      typeof value.protocol === 'string' &&
      value.protocol.length > 0 &&
      hasExactKeys(value, ['status', 'reason', 'protocol'])
    ) {
      return {
        status: 'unsupported',
        reason: 'unsupported-scheme',
        protocol: value.protocol,
      };
    }

    return undefined;
  } catch {
    return undefined;
  }
}

function areIdentityResultsEqual(
  actual: PageIdentityResult,
  expected: PageIdentityResult,
): boolean {
  if (actual.status !== expected.status) {
    return false;
  }

  if (actual.status === 'unsupported') {
    return (
      expected.status === 'unsupported' &&
      actual.reason === expected.reason &&
      (actual.reason === 'invalid-url' ||
        (expected.reason === 'unsupported-scheme' &&
          actual.protocol === expected.protocol))
    );
  }

  if (expected.status !== 'supported') {
    return false;
  }

  return (
    actual.identity.canonicalUrl === expected.identity.canonicalUrl &&
    actual.identity.isRoot === expected.identity.isRoot &&
    actual.identity.origin === expected.identity.origin &&
    actual.identity.pageKey === expected.identity.pageKey &&
    actual.identity.pathname === expected.identity.pathname
  );
}

function errorState(
  reason: ActivePageSessionErrorReason,
  tabId?: number,
): ErrorActivePageSessionState {
  return {
    status: 'error',
    reason,
    message: ERROR_MESSAGES[reason],
    ...(tabId === undefined ? {} : { tabId }),
  };
}

function unsupportedState(
  reason: UnsupportedActivePageReason,
  tab?: ActivePageTab,
  protocol?: string,
): UnsupportedActivePageSessionState {
  const tabId = isTabId(tab?.id) ? tab.id : undefined;
  const representativeUrl = typeof tab?.url === 'string' ? tab.url : undefined;

  return {
    status: 'unsupported',
    reason,
    title: typeof tab?.title === 'string' ? tab.title : '',
    ...(tabId === undefined ? {} : { tabId }),
    ...(representativeUrl === undefined ? {} : { representativeUrl }),
    ...(protocol === undefined ? {} : { protocol }),
  };
}

export class ActivePageSessionController {
  readonly #tabs: ActivePageTabs;
  readonly #settings: ActivePageSettings;
  readonly #identity: ActivePageIdentity;
  readonly #flushPendingSave: () => Promise<void>;
  readonly #emitState: (state: ActivePageSessionState) => void;
  #state: ActivePageSessionState = { status: 'loading' };
  #lifecycle: 'new' | 'started' | 'stopped' = 'new';
  #generation = 0;
  #activeTabId: number | undefined;
  #activeTabSnapshot: ActivePageTab | undefined;
  #currentDocumentPageKey: string | undefined;
  #currentDocumentFlushed = false;
  #commitTail: Promise<void> = Promise.resolve();
  #unsubscribeActivated: (() => void) | undefined;
  #unsubscribeUpdated: (() => void) | undefined;

  constructor({
    tabs,
    settings,
    identity,
    flushPendingSave,
    emitState,
  }: ActivePageSessionControllerDependencies) {
    this.#tabs = tabs;
    this.#settings = settings;
    this.#identity = identity;
    this.#flushPendingSave = flushPendingSave;
    this.#emitState = emitState;
  }

  getState(): ActivePageSessionState {
    return cloneState(this.#state);
  }

  start(): () => void {
    if (this.#lifecycle !== 'new') {
      return () => {
        this.stop();
      };
    }

    this.#lifecycle = 'started';
    this.#publish({ status: 'loading' });

    try {
      this.#unsubscribeActivated = this.#tabs.subscribeActivated(() => {
        this.#handleActivated();
      });
      this.#unsubscribeUpdated = this.#tabs.subscribeUpdated(
        (tabId, changeInfo, tab) => {
          this.#handleUpdated(tabId, changeInfo, tab);
        },
      );
    } catch {
      this.#removeTabListeners();
      this.#publish(errorState('listener-registration-failed'));

      return () => {
        this.stop();
      };
    }

    this.#requestQueryActiveTab();

    return () => {
      this.stop();
    };
  }

  stop(): void {
    if (this.#lifecycle === 'stopped') {
      return;
    }

    this.#lifecycle = 'stopped';
    this.#generation += 1;
    this.#removeTabListeners();
  }

  #isCurrent(generation: number): boolean {
    return this.#lifecycle === 'started' && generation === this.#generation;
  }

  #requestQueryActiveTab(): void {
    const generation = this.#nextGeneration();

    void this.#resolveActiveQuery(generation)
      .then((candidate) => {
        this.#queueCandidate(generation, candidate);
      })
      .catch(() => {
        this.#queueCandidate(generation, errorState('active-tab-query-failed'));
      });
  }

  #requestUpdatedTab(tab: ActivePageTab): void {
    const generation = this.#nextGeneration();
    const tabSnapshot = cloneTab(tab);

    void this.#resolveTab(generation, tabSnapshot)
      .then((candidate) => {
        this.#queueCandidate(generation, candidate);
      })
      .catch(() => {
        this.#queueCandidate(
          generation,
          errorState(
            'identity-failed',
            isTabId(tabSnapshot.id) ? tabSnapshot.id : undefined,
          ),
        );
      });
  }

  #requestUnconfirmedUpdatedTab(tab: ActivePageTab): void {
    const generation = this.#nextGeneration();
    const tabSnapshot = cloneTab(tab);

    void this.#resolveUnconfirmedUpdatedTab(generation, tabSnapshot)
      .then((candidate) => {
        this.#queueCandidate(generation, candidate);
      })
      .catch(() => {
        this.#queueCandidate(generation, errorState('active-tab-query-failed'));
      });
  }

  #nextGeneration(): number {
    this.#generation += 1;

    return this.#generation;
  }

  async #resolveActiveQuery(
    generation: number,
  ): Promise<ResolvedActivePageSessionState | undefined> {
    let tab: ActivePageTab | undefined;

    try {
      tab = await this.#tabs.queryCurrentWindowActiveTab();
    } catch {
      return errorState('active-tab-query-failed');
    }

    if (!this.#isCurrent(generation)) {
      return undefined;
    }

    if (tab === undefined) {
      this.#activeTabId = undefined;
      this.#activeTabSnapshot = undefined;

      return unsupportedState('no-active-tab');
    }

    const tabSnapshot = cloneTab(tab);
    this.#activeTabId = isTabId(tabSnapshot.id) ? tabSnapshot.id : undefined;
    this.#activeTabSnapshot = tabSnapshot;

    return this.#resolveTab(generation, tabSnapshot);
  }

  async #resolveUnconfirmedUpdatedTab(
    generation: number,
    updatedTab: ActivePageTab,
  ): Promise<ResolvedActivePageSessionState | undefined> {
    if (!isTabId(updatedTab.id)) {
      return errorState('active-tab-query-failed');
    }

    let currentActiveTab: ActivePageTab | undefined;

    try {
      currentActiveTab = await this.#tabs.queryCurrentWindowActiveTab();
    } catch {
      return errorState('active-tab-query-failed');
    }

    if (!this.#isCurrent(generation)) {
      return undefined;
    }

    if (currentActiveTab === undefined) {
      this.#activeTabId = undefined;
      this.#activeTabSnapshot = undefined;

      return unsupportedState('no-active-tab');
    }

    if (!isTabId(currentActiveTab.id)) {
      this.#activeTabId = undefined;
      this.#activeTabSnapshot = cloneTab(currentActiveTab);

      return unsupportedState('missing-tab-id', currentActiveTab);
    }

    const tabSnapshot: ActivePageTab =
      currentActiveTab.id === updatedTab.id
        ? {
            ...currentActiveTab,
            ...updatedTab,
            id: currentActiveTab.id,
          }
        : cloneTab(currentActiveTab);
    this.#activeTabId = currentActiveTab.id;
    this.#activeTabSnapshot = tabSnapshot;

    return this.#resolveTab(generation, tabSnapshot);
  }

  async #resolveTab(
    generation: number,
    tab: ActivePageTab,
  ): Promise<ResolvedActivePageSessionState | undefined> {
    if (!isTabId(tab.id)) {
      return unsupportedState('missing-tab-id', tab);
    }

    if (typeof tab.url !== 'string' || tab.url.trim() === '') {
      return unsupportedState('missing-url', tab);
    }

    let exclusions: readonly PageIdentityExclusionRule[];

    try {
      exclusions = cloneExclusions(
        await this.#settings.getPageIdentityExclusions(),
      );
    } catch {
      return errorState('settings-load-failed', tab.id);
    }

    if (!this.#isCurrent(generation)) {
      return undefined;
    }

    let rawResult: unknown;

    try {
      rawResult = await this.#identity.identify(
        tab.url,
        cloneExclusions(exclusions),
      );
    } catch {
      return errorState('identity-failed', tab.id);
    }

    if (!this.#isCurrent(generation)) {
      return undefined;
    }

    const result = readIdentityResult(rawResult);

    if (result === undefined) {
      return errorState('identity-failed', tab.id);
    }

    let expectedResult: PageIdentityResult;

    try {
      expectedResult = await derivePageIdentity(tab.url, exclusions);
    } catch {
      return errorState('identity-failed', tab.id);
    }

    if (!this.#isCurrent(generation)) {
      return undefined;
    }

    if (!areIdentityResultsEqual(result, expectedResult)) {
      return errorState('identity-failed', tab.id);
    }

    if (result.status === 'unsupported') {
      return unsupportedState(
        result.reason,
        tab,
        result.reason === 'unsupported-scheme' ? result.protocol : undefined,
      );
    }

    return {
      status: 'supported',
      tabId: tab.id,
      representativeUrl: tab.url,
      title: typeof tab.title === 'string' ? tab.title : '',
      identity: cloneIdentity(result.identity),
    };
  }

  #queueCandidate(
    generation: number,
    candidate: ResolvedActivePageSessionState | undefined,
  ): void {
    if (candidate === undefined || !this.#isCurrent(generation)) {
      return;
    }

    const commit = this.#commitTail.then(() =>
      this.#commitCandidate(generation, candidate),
    );
    this.#commitTail = commit.catch(() => undefined);
  }

  async #commitCandidate(
    generation: number,
    candidate: ResolvedActivePageSessionState,
  ): Promise<void> {
    if (!this.#isCurrent(generation)) {
      return;
    }

    const nextPageKey =
      candidate.status === 'supported' ? candidate.identity.pageKey : undefined;
    const changesDocument =
      this.#currentDocumentPageKey !== undefined &&
      nextPageKey !== this.#currentDocumentPageKey;

    if (changesDocument && !this.#currentDocumentFlushed) {
      try {
        await this.#flushPendingSave();
      } catch {
        if (this.#isCurrent(generation)) {
          this.#publish(
            errorState('pending-save-flush-failed', candidate.tabId),
          );
        }

        return;
      }

      this.#currentDocumentFlushed = true;
    }

    if (!this.#isCurrent(generation)) {
      return;
    }

    this.#publish(candidate);

    if (candidate.status === 'supported') {
      if (candidate.identity.pageKey !== this.#currentDocumentPageKey) {
        this.#currentDocumentPageKey = candidate.identity.pageKey;
        this.#currentDocumentFlushed = false;
      } else if (this.#currentDocumentFlushed) {
        // A newer same-document publication can include edits made after a stale navigation flush completed.
        this.#currentDocumentFlushed = false;
      }
    } else {
      this.#currentDocumentPageKey = undefined;
      this.#currentDocumentFlushed = false;
    }
  }

  #handleActivated(): void {
    if (this.#lifecycle !== 'started') {
      return;
    }

    this.#activeTabId = undefined;
    this.#activeTabSnapshot = undefined;
    this.#requestQueryActiveTab();
  }

  #handleUpdated(
    tabId: number,
    changeInfo: ActivePageTabChangeInfo,
    tab: ActivePageTab,
  ): void {
    if (
      this.#lifecycle !== 'started' ||
      (this.#activeTabId !== undefined && tabId !== this.#activeTabId) ||
      (typeof changeInfo.url !== 'string' &&
        typeof changeInfo.title !== 'string')
    ) {
      return;
    }

    const previous =
      this.#activeTabSnapshot?.id === tabId
        ? this.#activeTabSnapshot
        : undefined;
    const updated: ActivePageTab = {
      id: tabId,
      url: changeInfo.url ?? tab.url ?? previous?.url,
      title: changeInfo.title ?? tab.title ?? previous?.title,
    };
    this.#activeTabSnapshot = cloneTab(updated);

    if (this.#activeTabId === undefined) {
      this.#requestUnconfirmedUpdatedTab(updated);
    } else {
      this.#requestUpdatedTab(updated);
    }
  }

  #publish(state: ActivePageSessionState): void {
    if (this.#lifecycle !== 'started') {
      return;
    }

    this.#state = cloneState(state);

    try {
      this.#emitState(cloneState(state));
    } catch {
      // A presentation callback cannot break navigation/session ordering.
    }
  }

  #removeTabListeners(): void {
    const unsubscribeActivated = this.#unsubscribeActivated;
    const unsubscribeUpdated = this.#unsubscribeUpdated;
    this.#unsubscribeActivated = undefined;
    this.#unsubscribeUpdated = undefined;

    try {
      unsubscribeActivated?.();
    } catch {
      // Listener cleanup is best-effort and remains idempotent.
    }

    try {
      unsubscribeUpdated?.();
    } catch {
      // Listener cleanup is best-effort and remains idempotent.
    }
  }
}
