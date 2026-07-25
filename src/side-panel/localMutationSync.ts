import type { ByosClientConfig } from '../background/byosClient';
import {
  requestSyncFollowUp,
  type SyncRuntimeMessagePort,
} from '../background/syncRuntimeMessages';
import type { SettingsRepository } from '../repositories/settingsRepository';
import type { NoteLocalMutationObserver } from '../services/note';
import type { SyncQueue } from '../sync/syncQueue';

export interface LocalMutationSyncDependencies {
  readonly config: ByosClientConfig;
  readonly settings: Pick<SettingsRepository, 'get'>;
  readonly queue: Pick<SyncQueue, 'enqueue'>;
  readonly messages: Pick<SyncRuntimeMessagePort, 'request'>;
}

function isConfigured(config: ByosClientConfig): boolean {
  return (
    config.enabled &&
    typeof config.clientId === 'string' &&
    config.clientId.trim() !== ''
  );
}

export function createLocalMutationSyncObserver(
  dependencies: LocalMutationSyncDependencies,
): NoteLocalMutationObserver {
  return async (record) => {
    if (!isConfigured(dependencies.config)) {
      return;
    }

    const settings = await dependencies.settings.get();

    // An expired token still represents an opted-in replica: retain durable intent until reconnection.
    if (settings.byosConnection === undefined) {
      return;
    }

    await dependencies.queue.enqueue(record.pageKey, record.revisionId);
    void requestSyncFollowUp(dependencies.messages, 'local-mutation');
  };
}
