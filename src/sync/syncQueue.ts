export const SYNC_QUEUE_ENTRY_SCHEMA_VERSION = 1 as const;
export const SYNC_RETRY_BASE_DELAY_MS = 5_000;
export const SYNC_RETRY_MAX_DELAY_MS = 15 * 60_000;
export const SYNC_RETRY_MAX_ATTEMPT_COUNT = 31;

export interface SyncQueueEntry {
  readonly pageKey: string;
  readonly revisionId: string;
  readonly attemptCount: number;
  readonly nextAttemptAt: string;
}

export interface SyncQueue {
  enqueue(pageKey: string, revisionId: string): Promise<SyncQueueEntry>;
  complete(pageKey: string, revisionId: string): Promise<boolean>;
  get(pageKey: string): Promise<SyncQueueEntry | undefined>;
  /**
   * Records a failed attempt only when the queued revision still matches.
   * A missing entry is created so reconciliation failures remain durable.
   */
  fail(
    pageKey: string,
    revisionId: string,
  ): Promise<SyncQueueEntry | undefined>;
  count(): Promise<number>;
  listAll(): Promise<readonly SyncQueueEntry[]>;
  listDue(): Promise<readonly SyncQueueEntry[]>;
}

export type SyncQueueErrorCode =
  | 'clock-failure'
  | 'configuration'
  | 'invalid-entry'
  | 'invalid-schedule'
  | 'random-failure'
  | 'storage-failure'
  | 'stored-future-schema'
  | 'stored-malformed';

export class SyncQueueError extends Error {
  readonly code: SyncQueueErrorCode;
  readonly storageKey?: string;

  constructor(code: SyncQueueErrorCode, message: string, storageKey?: string) {
    super(message);
    this.name = 'SyncQueueError';
    this.code = code;
    this.storageKey = storageKey;
  }
}

export function calculateSyncRetryDelayMs(
  attemptCount: number,
  randomValue: number,
): number {
  if (
    !Number.isInteger(attemptCount) ||
    attemptCount < 1 ||
    attemptCount > SYNC_RETRY_MAX_ATTEMPT_COUNT ||
    !Number.isFinite(randomValue) ||
    randomValue < 0 ||
    randomValue >= 1
  ) {
    throw new SyncQueueError(
      'invalid-schedule',
      'Sync retry scheduling input is invalid.',
    );
  }

  const exponent = Math.min(
    attemptCount - 1,
    Math.ceil(Math.log2(SYNC_RETRY_MAX_DELAY_MS / SYNC_RETRY_BASE_DELAY_MS)),
  );
  const exponentialDelay = Math.min(
    SYNC_RETRY_MAX_DELAY_MS,
    SYNC_RETRY_BASE_DELAY_MS * 2 ** exponent,
  );

  // Bounded positive jitter spreads simultaneous extension wakeups without sleeps.
  return Math.floor(
    Math.min(SYNC_RETRY_MAX_DELAY_MS, exponentialDelay * (1 + randomValue)),
  );
}
