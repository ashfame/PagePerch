import {
  BYOS_PKCE_SESSION_STORAGE_KEY,
  parseByosPkceSession,
  type ByosPkceSessionStore,
  type ByosPkceSessionV1,
} from '../services/byosPkceSession';
import {
  enqueueStorageOperation,
  storageGet,
  storageRemove,
  storageSet,
  type PromiseChromeStorageArea,
} from './chromeStorage';
import { RepositoryConfigurationError } from './repositoryErrors';

function resolveChromeSessionStorageArea(
  injectedStorageArea?: PromiseChromeStorageArea,
): PromiseChromeStorageArea {
  if (injectedStorageArea !== undefined) {
    return injectedStorageArea;
  }

  if (
    typeof chrome === 'undefined' ||
    chrome.storage === undefined ||
    chrome.storage.session === undefined
  ) {
    throw new RepositoryConfigurationError(
      'chrome.storage.session is unavailable; inject a promise-based session storage area outside the extension runtime.',
    );
  }

  return chrome.storage.session;
}

export class ChromeSessionByosPkceRepository implements ByosPkceSessionStore {
  readonly #storageArea: PromiseChromeStorageArea;

  constructor(storageArea?: PromiseChromeStorageArea) {
    this.#storageArea = resolveChromeSessionStorageArea(storageArea);
  }

  load(): Promise<ByosPkceSessionV1 | undefined> {
    return this.#enqueue(async () => {
      const stored = await storageGet(
        this.#storageArea,
        BYOS_PKCE_SESSION_STORAGE_KEY,
        'get',
      );
      const value = stored[BYOS_PKCE_SESSION_STORAGE_KEY];

      return value === undefined ? undefined : parseByosPkceSession(value);
    });
  }

  save(session: ByosPkceSessionV1): Promise<void> {
    return this.#enqueue(async () => {
      const parsed = parseByosPkceSession(session);
      await storageSet(
        this.#storageArea,
        { [BYOS_PKCE_SESSION_STORAGE_KEY]: parsed },
        'put',
      );
    });
  }

  clear(): Promise<void> {
    return this.#enqueue(() =>
      storageRemove(this.#storageArea, BYOS_PKCE_SESSION_STORAGE_KEY),
    );
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    return enqueueStorageOperation(this.#storageArea, operation);
  }
}
