import {
  RepositoryConfigurationError,
  RepositoryStorageError,
  type RepositoryOperation,
} from './repositoryErrors';

const storageOperationQueues = new WeakMap<
  PromiseChromeStorageArea,
  Promise<unknown>
>();
const STORAGE_OPERATION_LOCK_NAME =
  'pageperch:v1:chrome-storage-repository-operations';

export interface PromiseChromeStorageArea {
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export function resolveChromeLocalStorageArea(
  injectedStorageArea?: PromiseChromeStorageArea,
): PromiseChromeStorageArea {
  if (injectedStorageArea !== undefined) {
    return injectedStorageArea;
  }

  if (
    typeof chrome === 'undefined' ||
    chrome.storage === undefined ||
    chrome.storage.local === undefined
  ) {
    throw new RepositoryConfigurationError(
      'chrome.storage.local is unavailable; inject a promise-based storage area outside the extension runtime.',
    );
  }

  return chrome.storage.local;
}

export async function storageGet(
  storageArea: PromiseChromeStorageArea,
  keys: string | string[] | null,
  operation: RepositoryOperation,
): Promise<Record<string, unknown>> {
  try {
    return await storageArea.get(keys);
  } catch (error) {
    throw new RepositoryStorageError(
      operation,
      `Unable to ${operation} PagePerch data from chrome.storage.local.`,
      { cause: error },
    );
  }
}

export async function storageSet(
  storageArea: PromiseChromeStorageArea,
  items: Record<string, unknown>,
  operation: RepositoryOperation,
): Promise<void> {
  try {
    await storageArea.set(items);
  } catch (error) {
    throw new RepositoryStorageError(
      operation,
      `Unable to ${operation} PagePerch data in chrome.storage.local.`,
      { cause: error },
    );
  }
}

export async function storageRemove(
  storageArea: PromiseChromeStorageArea,
  keys: string | string[],
): Promise<void> {
  try {
    await storageArea.remove(keys);
  } catch (error) {
    throw new RepositoryStorageError(
      'delete',
      'Unable to delete PagePerch data from chrome.storage.local.',
      { cause: error },
    );
  }
}

export function enqueueStorageOperation<T>(
  storageArea: PromiseChromeStorageArea,
  operation: () => Promise<T>,
): Promise<T> {
  const current = storageOperationQueues.get(storageArea) ?? Promise.resolve();
  const runOperation = (): Promise<T> => {
    const lockManager =
      typeof navigator === 'undefined' ? undefined : navigator.locks;

    if (lockManager === undefined) {
      return operation();
    }

    // Chrome extension documents and workers share this Web Lock, closing the cross-context read/modify/write race around origin indexes.
    return lockManager
      .request<Promise<T>>(
        STORAGE_OPERATION_LOCK_NAME,
        { mode: 'exclusive' },
        operation,
      )
      .then((result) => result);
  };
  const result = current.then(runOperation, runOperation);
  const next = result.then(
    () => undefined,
    () => undefined,
  );
  storageOperationQueues.set(storageArea, next);

  return result;
}
