import {
  NOTE_STORAGE_KEY_PREFIX,
  getNoteOriginIndexStorageKey,
} from '../repositories/chromeLocalNoteRepository';
import type { RootRecentNoteChanges } from './rootRecentNotes';

type ChromeStorageChangedListener = (
  changes: Record<string, chrome.storage.StorageChange>,
  areaName: string,
) => void;

interface ChromeStorageChangedEventPort {
  addListener(listener: ChromeStorageChangedListener): void;
  removeListener(listener: ChromeStorageChangedListener): void;
}

function belongsToOrigin(value: unknown, origin: string): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).origin === origin
  );
}

export class ChromeRecentNoteChanges implements RootRecentNoteChanges {
  readonly #onChanged: ChromeStorageChangedEventPort;

  constructor(
    onChanged: ChromeStorageChangedEventPort = chrome.storage.onChanged,
  ) {
    this.#onChanged = onChanged;
  }

  subscribe(origin: string, listener: () => void): () => void {
    const originIndexKey = getNoteOriginIndexStorageKey(origin);
    let active = true;
    const chromeListener: ChromeStorageChangedListener = (
      changes,
      areaName,
    ) => {
      if (areaName !== 'local' || !active) {
        return;
      }

      const relevant = Object.entries(changes).some(
        ([storageKey, change]) =>
          storageKey === originIndexKey ||
          (storageKey.startsWith(NOTE_STORAGE_KEY_PREFIX) &&
            (belongsToOrigin(change.oldValue, origin) ||
              belongsToOrigin(change.newValue, origin))),
      );

      if (!relevant) {
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
