import { describe, expect, it, vi } from 'vitest';

import { SETTINGS_STORAGE_KEY } from './chromeLocalSettingsRepository';
import {
  getSyncQueueStorageKey,
  SYNC_QUEUE_STORAGE_KEY_PREFIX,
} from './chromeLocalSyncQueue';
import { ChromeSyncVisibilityChanges } from './chromeSyncVisibilityChanges';

const PAGE_KEY_A = 'A'.repeat(43);
const PAGE_KEY_B = `${'B'.repeat(42)}E`;

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

describe('ChromeSyncVisibilityChanges', () => {
  it('filters aggregate notifications to local validated queue and settings keys', () => {
    const event = createEventPort();
    const changes = new ChromeSyncVisibilityChanges(event.port);
    const listener = vi.fn();
    changes.subscribeAll(listener);
    const [chromeListener] = event.listeners;

    chromeListener?.(
      { [getSyncQueueStorageKey(PAGE_KEY_A)]: { newValue: {} } },
      'sync',
    );
    chromeListener?.({ unrelated: { newValue: {} } }, 'local');
    chromeListener?.(
      {
        [`${SYNC_QUEUE_STORAGE_KEY_PREFIX}not-a-page-key`]: {
          newValue: {},
        },
      },
      'local',
    );
    chromeListener?.(
      {
        'pageperch:v1:sync-queue-lookalike': {
          newValue: {},
        },
      },
      'local',
    );
    expect(listener).not.toHaveBeenCalled();

    chromeListener?.(
      { [getSyncQueueStorageKey(PAGE_KEY_A)]: { newValue: {} } },
      'local',
    );
    chromeListener?.({ [SETTINGS_STORAGE_KEY]: { newValue: {} } }, 'local');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('notifies an exact page only for its queue entry or settings changes', () => {
    const event = createEventPort();
    const changes = new ChromeSyncVisibilityChanges(event.port);
    const listener = vi.fn();
    changes.subscribePage(PAGE_KEY_A, listener);
    const [chromeListener] = event.listeners;

    chromeListener?.(
      { [getSyncQueueStorageKey(PAGE_KEY_B)]: { newValue: {} } },
      'local',
    );
    expect(listener).not.toHaveBeenCalled();

    chromeListener?.(
      { [getSyncQueueStorageKey(PAGE_KEY_A)]: { newValue: {} } },
      'local',
    );
    chromeListener?.({ [SETTINGS_STORAGE_KEY]: { newValue: {} } }, 'local');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('contains consumer failures and rejects an invalid page before registration', () => {
    const event = createEventPort();
    const changes = new ChromeSyncVisibilityChanges(event.port);
    const listener = vi.fn(() => {
      throw new Error('consumer failed with private state');
    });
    changes.subscribeAll(listener);
    const [chromeListener] = event.listeners;

    expect(() => {
      chromeListener?.(
        { [getSyncQueueStorageKey(PAGE_KEY_A)]: { newValue: {} } },
        'local',
      );
    }).not.toThrow();
    expect(listener).toHaveBeenCalledOnce();
    expect(() => changes.subscribePage('not-a-page-key', vi.fn())).toThrow(
      'A valid page key is required',
    );
    expect(event.addListener).toHaveBeenCalledOnce();
  });

  it('removes the exact listener idempotently and disables stale forwarding before failed removal', () => {
    const event = createEventPort();
    const changes = new ChromeSyncVisibilityChanges(event.port);
    const listener = vi.fn();
    const unsubscribe = changes.subscribeAll(listener);
    const [chromeListener] = event.listeners;
    event.removeListener.mockImplementationOnce(() => {
      throw new Error('remove failed');
    });

    expect(unsubscribe).toThrow('remove failed');
    expect(unsubscribe).not.toThrow();
    chromeListener?.(
      { [getSyncQueueStorageKey(PAGE_KEY_A)]: { newValue: {} } },
      'local',
    );
    expect(listener).not.toHaveBeenCalled();
    expect(event.removeListener).toHaveBeenCalledOnce();
    expect(event.removeListener).toHaveBeenCalledWith(chromeListener);
  });

  it('propagates registration failure without attempting removal', () => {
    const event = createEventPort();
    const failure = new Error('add failed');
    event.addListener.mockImplementationOnce(() => {
      throw failure;
    });
    const changes = new ChromeSyncVisibilityChanges(event.port);

    expect(() => changes.subscribeAll(vi.fn())).toThrow(failure);
    expect(event.removeListener).not.toHaveBeenCalled();
  });
});
