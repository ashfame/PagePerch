import { describe, expect, it, vi } from 'vitest';

import {
  NOTE_STORAGE_KEY_PREFIX,
  getNoteOriginIndexStorageKey,
} from '../repositories/chromeLocalNoteRepository';
import { ChromeRecentNoteChanges } from './chromeRecentNoteChanges';

type ChangedListener = (
  changes: Record<string, chrome.storage.StorageChange>,
  areaName: string,
) => void;

function createEventPort() {
  const listeners = new Set<ChangedListener>();
  const addListener = vi.fn((listener: ChangedListener) => {
    listeners.add(listener);
  });
  const removeListener = vi.fn((listener: ChangedListener) => {
    listeners.delete(listener);
  });

  return {
    addListener,
    listeners,
    port: { addListener, removeListener },
    removeListener,
  };
}

describe('ChromeRecentNoteChanges', () => {
  it('forwards only local exact-origin index and note-record changes', () => {
    const event = createEventPort();
    const changes = new ChromeRecentNoteChanges(event.port);
    const listener = vi.fn();
    changes.subscribe('https://example.com', listener);
    const [chromeListener] = event.listeners;

    chromeListener?.(
      {
        [getNoteOriginIndexStorageKey('https://other.example')]: {
          newValue: { origin: 'https://other.example' },
        },
      },
      'local',
    );
    chromeListener?.(
      {
        [getNoteOriginIndexStorageKey('https://example.com')]: {
          newValue: { origin: 'https://example.com' },
        },
      },
      'sync',
    );
    chromeListener?.(
      {
        unrelated: {
          newValue: { origin: 'https://example.com' },
        },
      },
      'local',
    );
    expect(listener).not.toHaveBeenCalled();

    chromeListener?.(
      {
        [getNoteOriginIndexStorageKey('https://example.com')]: {
          newValue: { origin: 'https://example.com' },
        },
      },
      'local',
    );
    chromeListener?.(
      {
        [`${NOTE_STORAGE_KEY_PREFIX}${'A'.repeat(43)}`]: {
          newValue: { origin: 'https://example.com' },
        },
      },
      'local',
    );
    chromeListener?.(
      {
        [`${NOTE_STORAGE_KEY_PREFIX}${'B'.repeat(43)}`]: {
          oldValue: { origin: 'https://example.com' },
        },
      },
      'local',
    );
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('filters malformed and other-origin note values and contains consumer failures', () => {
    const event = createEventPort();
    const changes = new ChromeRecentNoteChanges(event.port);
    const listener = vi.fn(() => {
      throw new Error('consumer failed');
    });
    changes.subscribe('https://example.com', listener);
    const [chromeListener] = event.listeners;

    expect(() => {
      chromeListener?.(
        {
          [`${NOTE_STORAGE_KEY_PREFIX}${'A'.repeat(43)}`]: {
            newValue: { origin: 'https://example.com' },
          },
        },
        'local',
      );
    }).not.toThrow();
    chromeListener?.(
      {
        [`${NOTE_STORAGE_KEY_PREFIX}${'B'.repeat(43)}`]: {
          newValue: { origin: 'https://other.example' },
          oldValue: null,
        },
        [`${NOTE_STORAGE_KEY_PREFIX}${'C'.repeat(43)}`]: {
          newValue: ['https://example.com'],
        },
      },
      'local',
    );

    expect(listener).toHaveBeenCalledOnce();
  });

  it('removes the exact listener idempotently and disables stale forwarding before a failed removal', () => {
    const event = createEventPort();
    const changes = new ChromeRecentNoteChanges(event.port);
    const listener = vi.fn();
    const unsubscribe = changes.subscribe('https://example.com', listener);
    const [chromeListener] = event.listeners;
    event.removeListener.mockImplementationOnce(() => {
      throw new Error('remove failed');
    });

    expect(unsubscribe).toThrow('remove failed');
    expect(unsubscribe).not.toThrow();
    chromeListener?.(
      {
        [getNoteOriginIndexStorageKey('https://example.com')]: {
          newValue: {},
        },
      },
      'local',
    );

    expect(listener).not.toHaveBeenCalled();
    expect(event.removeListener).toHaveBeenCalledOnce();
    expect(event.removeListener).toHaveBeenCalledWith(chromeListener);
  });

  it('propagates listener registration failure without attempting removal', () => {
    const event = createEventPort();
    const failure = new Error('add failed');
    event.addListener.mockImplementationOnce(() => {
      throw failure;
    });
    const changes = new ChromeRecentNoteChanges(event.port);

    expect(() => changes.subscribe('https://example.com', vi.fn())).toThrow(
      failure,
    );
    expect(event.removeListener).not.toHaveBeenCalled();
  });
});
