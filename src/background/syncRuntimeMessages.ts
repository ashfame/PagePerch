import type {
  ByosSyncRuntime,
  ByosSyncRuntimeOutcome,
  ByosSyncRuntimeStatus,
} from './byosSyncRuntime';

export const SYNC_RUNTIME_TRIGGER_MESSAGE = 'pageperch:v1:sync-runtime:trigger';
export const SYNC_RUNTIME_STATUS_MESSAGE = 'pageperch:v1:sync-runtime:status';
export const SYNC_RUNTIME_INVALIDATE_CREDENTIALS_MESSAGE =
  'pageperch:v1:sync-runtime:invalidate-credentials';
export const SYNC_RUNTIME_CREDENTIALS_INVALIDATED_MESSAGE =
  'pageperch:v1:sync-runtime:credentials-invalidated';

export type SyncRuntimeTriggerReason =
  'connection' | 'identity-migration' | 'local-mutation' | 'panel-open';

export interface SyncRuntimeTriggerMessage {
  readonly type: typeof SYNC_RUNTIME_TRIGGER_MESSAGE;
  readonly reason: SyncRuntimeTriggerReason;
}

export interface SyncRuntimeStatusMessage {
  readonly type: typeof SYNC_RUNTIME_STATUS_MESSAGE;
  readonly outcome: ByosSyncRuntimeOutcome;
}

export interface SyncRuntimeInvalidateCredentialsMessage {
  readonly type: typeof SYNC_RUNTIME_INVALIDATE_CREDENTIALS_MESSAGE;
}

export interface SyncRuntimeCredentialsInvalidatedMessage {
  readonly type: typeof SYNC_RUNTIME_CREDENTIALS_INVALIDATED_MESSAGE;
}

export type SyncRuntimeRequestMessage =
  SyncRuntimeInvalidateCredentialsMessage | SyncRuntimeTriggerMessage;

export type SyncRuntimeResponseMessage =
  SyncRuntimeCredentialsInvalidatedMessage | SyncRuntimeStatusMessage;

export interface SyncRuntimeMessageSender {
  send(message: SyncRuntimeRequestMessage): Promise<unknown>;
}

export class SyncRuntimeMessageError extends Error {
  constructor() {
    super('PagePerch synchronization could not be requested.');
    this.name = 'SyncRuntimeMessageError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function isTriggerReason(value: unknown): value is SyncRuntimeTriggerReason {
  return (
    value === 'connection' ||
    value === 'identity-migration' ||
    value === 'local-mutation' ||
    value === 'panel-open'
  );
}

function isRuntimeStatus(value: unknown): value is ByosSyncRuntimeStatus {
  return (
    value === 'disconnected' ||
    value === 'failed' ||
    value === 'partial' ||
    value === 'pending' ||
    value === 'reconnect-required' ||
    value === 'synced' ||
    value === 'unavailable'
  );
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function isSyncRuntimeTriggerMessage(
  value: unknown,
): value is SyncRuntimeTriggerMessage {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['type', 'reason']) &&
    value.type === SYNC_RUNTIME_TRIGGER_MESSAGE &&
    isTriggerReason(value.reason)
  );
}

export function isSyncRuntimeInvalidateCredentialsMessage(
  value: unknown,
): value is SyncRuntimeInvalidateCredentialsMessage {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['type']) &&
    value.type === SYNC_RUNTIME_INVALIDATE_CREDENTIALS_MESSAGE
  );
}

export function isSyncRuntimeCredentialsInvalidatedMessage(
  value: unknown,
): value is SyncRuntimeCredentialsInvalidatedMessage {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['type']) &&
    value.type === SYNC_RUNTIME_CREDENTIALS_INVALIDATED_MESSAGE
  );
}

export function isSyncRuntimeStatusMessage(
  value: unknown,
): value is SyncRuntimeStatusMessage {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['type', 'outcome']) ||
    value.type !== SYNC_RUNTIME_STATUS_MESSAGE ||
    !isRecord(value.outcome) ||
    !hasExactKeys(value.outcome, [
      'status',
      'uploaded',
      'downloaded',
      'unchanged',
      'conflicts',
      'failed',
      'pending',
    ])
  ) {
    return false;
  }

  return (
    isRuntimeStatus(value.outcome.status) &&
    isCount(value.outcome.uploaded) &&
    isCount(value.outcome.downloaded) &&
    isCount(value.outcome.unchanged) &&
    isCount(value.outcome.conflicts) &&
    isCount(value.outcome.failed) &&
    isCount(value.outcome.pending)
  );
}

function freezeOutcome(
  outcome: ByosSyncRuntimeOutcome,
): ByosSyncRuntimeOutcome {
  return Object.freeze({ ...outcome });
}

export class ChromeSyncRuntimeMessageSender implements SyncRuntimeMessageSender {
  send(message: SyncRuntimeRequestMessage): Promise<unknown> {
    return chrome.runtime.sendMessage(message);
  }
}

export class SyncRuntimeMessagePort {
  readonly #sender: SyncRuntimeMessageSender;

  constructor(
    sender: SyncRuntimeMessageSender = new ChromeSyncRuntimeMessageSender(),
  ) {
    this.#sender = sender;
  }

  async request(
    reason: SyncRuntimeTriggerReason,
  ): Promise<ByosSyncRuntimeOutcome> {
    if (!isTriggerReason(reason)) {
      throw new SyncRuntimeMessageError();
    }

    let response: unknown;

    try {
      response = await this.#sender.send({
        type: SYNC_RUNTIME_TRIGGER_MESSAGE,
        reason,
      });
    } catch {
      throw new SyncRuntimeMessageError();
    }

    if (!isSyncRuntimeStatusMessage(response)) {
      throw new SyncRuntimeMessageError();
    }

    return freezeOutcome(response.outcome);
  }

  async invalidateCredentials(): Promise<void> {
    let response: unknown;

    try {
      response = await this.#sender.send({
        type: SYNC_RUNTIME_INVALIDATE_CREDENTIALS_MESSAGE,
      });
    } catch {
      throw new SyncRuntimeMessageError();
    }

    if (!isSyncRuntimeCredentialsInvalidatedMessage(response)) {
      throw new SyncRuntimeMessageError();
    }
  }
}

export async function requestSyncFollowUp(
  messages: Pick<SyncRuntimeMessagePort, 'request'>,
  reason: SyncRuntimeTriggerReason,
): Promise<void> {
  try {
    await messages.request(reason);
  } catch {
    // Completed local actions remain successful; later startup, panel, or alarm triggers recover.
  }
}

export async function requestSyncCredentialInvalidation(
  messages: Pick<SyncRuntimeMessagePort, 'invalidateCredentials'>,
): Promise<void> {
  try {
    await messages.invalidateCredentials();
  } catch {
    // Local disconnect remains authoritative; future worker preflights reject the removed connection.
  }
}

export type SyncRuntimeMessageListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: SyncRuntimeResponseMessage) => void,
) => boolean;

export function createSyncRuntimeMessageListener(
  runtime: Pick<ByosSyncRuntime, 'invalidateCredentials' | 'trigger'>,
): SyncRuntimeMessageListener {
  return (message, _sender, sendResponse) => {
    if (isSyncRuntimeInvalidateCredentialsMessage(message)) {
      runtime.invalidateCredentials();
      sendResponse({
        type: SYNC_RUNTIME_CREDENTIALS_INVALIDATED_MESSAGE,
      });
      return false;
    }

    if (!isSyncRuntimeTriggerMessage(message)) {
      return false;
    }

    if (message.reason === 'connection') {
      runtime.invalidateCredentials();
    }

    void runtime.trigger().then(
      (outcome) => {
        sendResponse({
          type: SYNC_RUNTIME_STATUS_MESSAGE,
          outcome: freezeOutcome(outcome),
        });
      },
      () => {
        sendResponse({
          type: SYNC_RUNTIME_STATUS_MESSAGE,
          outcome: Object.freeze({
            status: 'failed',
            uploaded: 0,
            downloaded: 0,
            unchanged: 0,
            conflicts: 0,
            failed: 1,
            pending: 0,
          }),
        });
      },
    );

    return true;
  };
}
