import { SETTINGS_STORAGE_KEY } from './chromeLocalSettingsRepository';
import {
  getSyncQueueStorageKey,
  SYNC_QUEUE_STORAGE_KEY_PREFIX,
} from './chromeLocalSyncQueue';
import { isPageKey } from './validation';
import type { SyncVisibilityChanges } from '../sync/syncVisibility';

type ChromeStorageChangedListener = (
  changes: Record<string, chrome.storage.StorageChange>,
  areaName: string,
) => void;

interface ChromeStorageChangedEventPort {
  addListener(listener: ChromeStorageChangedListener): void;
  removeListener(listener: ChromeStorageChangedListener): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOwnedQueueStorageKey(storageKey: string): boolean {
  if (!storageKey.startsWith(SYNC_QUEUE_STORAGE_KEY_PREFIX)) {
    return false;
  }

  const pageKey = storageKey.slice(SYNC_QUEUE_STORAGE_KEY_PREFIX.length);

  return isPageKey(pageKey) && getSyncQueueStorageKey(pageKey) === storageKey;
}

export class ChromeSyncVisibilityChanges implements SyncVisibilityChanges {
  readonly #onChanged: ChromeStorageChangedEventPort;

  constructor(
    onChanged: ChromeStorageChangedEventPort = chrome.storage.onChanged,
  ) {
    this.#onChanged = onChanged;
  }

  subscribeAll(listener: () => void): () => void {
    return this.#subscribe(
      (storageKey) =>
        storageKey === SETTINGS_STORAGE_KEY ||
        isOwnedQueueStorageKey(storageKey),
      listener,
    );
  }

  subscribePage(pageKey: string, listener: () => void): () => void {
    if (!isPageKey(pageKey)) {
      throw new Error(
        'A valid page key is required to observe sync visibility.',
      );
    }

    const queueStorageKey = getSyncQueueStorageKey(pageKey);

    return this.#subscribe(
      (storageKey) =>
        storageKey === SETTINGS_STORAGE_KEY || storageKey === queueStorageKey,
      listener,
    );
  }

  #subscribe(
    matches: (storageKey: string) => boolean,
    listener: () => void,
  ): () => void {
    let active = true;
    const chromeListener: ChromeStorageChangedListener = (
      changes,
      areaName,
    ) => {
      if (
        !active ||
        areaName !== 'local' ||
        !isRecord(changes) ||
        !Object.keys(changes).some(matches)
      ) {
        return;
      }

      try {
        listener();
      } catch {
        // One consumer cannot interrupt Chrome's global storage event.
      }
    };

    try {
      this.#onChanged.addListener(chromeListener);
    } catch (error) {
      active = false;
      throw error;
    }

    return () => {
      if (!active) {
        return;
      }

      active = false;
      this.#onChanged.removeListener(chromeListener);
    };
  }
}
