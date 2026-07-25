import {
  calculateSyncRetryDelayMs,
  SYNC_QUEUE_ENTRY_SCHEMA_VERSION,
  SYNC_RETRY_MAX_ATTEMPT_COUNT,
  SYNC_RETRY_MAX_DELAY_MS,
  SyncQueueError,
  type SyncQueue,
  type SyncQueueEntry,
} from '../sync/syncQueue';
import {
  enqueueStorageOperation,
  resolveChromeLocalStorageArea,
  storageGet,
  storageRemove,
  storageSet,
  type PromiseChromeStorageArea,
} from './chromeStorage';
import { isPageKey, isRevisionId, isUtcIsoTimestamp } from './validation';

export const SYNC_QUEUE_STORAGE_KEY_PREFIX = 'pageperch:v1:sync-queue:';

interface StoredSyncQueueEntryV1 {
  readonly schemaVersion: typeof SYNC_QUEUE_ENTRY_SCHEMA_VERSION;
  readonly entry: SyncQueueEntry;
}

export interface ChromeLocalSyncQueueDependencies {
  readonly storageArea?: PromiseChromeStorageArea;
  readonly clock: () => Date;
  readonly random: () => number;
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

function isSyncQueueEntry(value: unknown): value is SyncQueueEntry {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'pageKey',
      'revisionId',
      'attemptCount',
      'nextAttemptAt',
    ]) &&
    isPageKey(value.pageKey) &&
    isRevisionId(value.revisionId) &&
    Number.isInteger(value.attemptCount) &&
    (value.attemptCount as number) >= 0 &&
    (value.attemptCount as number) <= SYNC_RETRY_MAX_ATTEMPT_COUNT &&
    isUtcIsoTimestamp(value.nextAttemptAt)
  );
}

function freezeEntry(entry: SyncQueueEntry): SyncQueueEntry {
  return Object.freeze({ ...entry });
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}

export function getSyncQueueStorageKey(pageKey: string): string {
  return `${SYNC_QUEUE_STORAGE_KEY_PREFIX}${pageKey}`;
}

function storedQueueError(storageKey: string, value: unknown): SyncQueueError {
  const futureSchema =
    isRecord(value) &&
    typeof value.schemaVersion === 'number' &&
    value.schemaVersion > SYNC_QUEUE_ENTRY_SCHEMA_VERSION;

  return new SyncQueueError(
    futureSchema ? 'stored-future-schema' : 'stored-malformed',
    futureSchema
      ? 'A queued PagePerch sync entry uses an unsupported schema and was left untouched.'
      : 'A queued PagePerch sync entry is malformed and was left untouched.',
    storageKey,
  );
}

function parseStoredEntry(storageKey: string, value: unknown): SyncQueueEntry {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['schemaVersion', 'entry']) ||
    value.schemaVersion !== SYNC_QUEUE_ENTRY_SCHEMA_VERSION ||
    !isSyncQueueEntry(value.entry) ||
    getSyncQueueStorageKey(value.entry.pageKey) !== storageKey
  ) {
    throw storedQueueError(storageKey, value);
  }

  return freezeEntry(value.entry);
}

function storedEntry(entry: SyncQueueEntry): StoredSyncQueueEntryV1 {
  return {
    schemaVersion: SYNC_QUEUE_ENTRY_SCHEMA_VERSION,
    entry: { ...entry },
  };
}

function assertEntryIdentity(pageKey: string, revisionId: string): void {
  if (!isPageKey(pageKey) || !isRevisionId(revisionId)) {
    throw new SyncQueueError(
      'invalid-entry',
      'A sync queue entry requires a valid page key and revision identifier.',
    );
  }
}

export class ChromeLocalSyncQueue implements SyncQueue {
  readonly #clock: () => Date;
  readonly #random: () => number;
  readonly #storageArea: PromiseChromeStorageArea;

  constructor(dependencies: ChromeLocalSyncQueueDependencies) {
    if (
      typeof dependencies !== 'object' ||
      dependencies === null ||
      typeof dependencies.clock !== 'function' ||
      typeof dependencies.random !== 'function'
    ) {
      throw new SyncQueueError(
        'configuration',
        'Sync queue dependencies are invalid.',
      );
    }

    try {
      this.#storageArea = resolveChromeLocalStorageArea(
        dependencies.storageArea,
      );
    } catch {
      throw new SyncQueueError(
        'configuration',
        'Durable extension storage is unavailable for the sync queue.',
      );
    }

    this.#clock = dependencies.clock;
    this.#random = dependencies.random;
  }

  async enqueue(pageKey: string, revisionId: string): Promise<SyncQueueEntry> {
    assertEntryIdentity(pageKey, revisionId);

    return this.#run(async () => {
      const storageKey = getSyncQueueStorageKey(pageKey);
      const existing = await this.#loadOne(storageKey, 'put');

      if (existing?.revisionId === revisionId) {
        return existing;
      }

      const entry = freezeEntry({
        pageKey,
        revisionId,
        attemptCount: 0,
        nextAttemptAt: this.#readClock().toISOString(),
      });
      await storageSet(
        this.#storageArea,
        { [storageKey]: storedEntry(entry) },
        'put',
      );

      return entry;
    });
  }

  async complete(pageKey: string, revisionId: string): Promise<boolean> {
    assertEntryIdentity(pageKey, revisionId);

    return this.#run(async () => {
      const storageKey = getSyncQueueStorageKey(pageKey);
      const existing = await this.#loadOne(storageKey, 'delete');

      if (existing === undefined || existing.revisionId !== revisionId) {
        return false;
      }

      await storageRemove(this.#storageArea, storageKey);
      return true;
    });
  }

  async fail(
    pageKey: string,
    revisionId: string,
  ): Promise<SyncQueueEntry | undefined> {
    assertEntryIdentity(pageKey, revisionId);

    return this.#run(async () => {
      const storageKey = getSyncQueueStorageKey(pageKey);
      const existing = await this.#loadOne(storageKey, 'put');

      if (existing !== undefined && existing.revisionId !== revisionId) {
        return undefined;
      }

      const randomValue = this.#readRandom();
      const attemptCount = Math.min(
        (existing?.attemptCount ?? 0) + 1,
        SYNC_RETRY_MAX_ATTEMPT_COUNT,
      );
      const retryAt =
        this.#readClock().getTime() +
        calculateSyncRetryDelayMs(attemptCount, randomValue);

      const entry = freezeEntry({
        pageKey,
        revisionId,
        attemptCount,
        nextAttemptAt: new Date(retryAt).toISOString(),
      });
      await storageSet(
        this.#storageArea,
        { [storageKey]: storedEntry(entry) },
        'put',
      );

      return entry;
    });
  }

  count(): Promise<number> {
    return this.#run(async () => (await this.#loadAll()).length);
  }

  listAll(): Promise<readonly SyncQueueEntry[]> {
    return this.#run(() => this.#loadAll());
  }

  listDue(): Promise<readonly SyncQueueEntry[]> {
    return this.#run(async () => {
      const now = this.#readClock().getTime();
      const entries = await this.#loadAll();

      return Object.freeze(
        entries.filter(
          (entry) => new Date(entry.nextAttemptAt).getTime() <= now,
        ),
      );
    });
  }

  async #loadOne(
    storageKey: string,
    operation: 'delete' | 'put',
  ): Promise<SyncQueueEntry | undefined> {
    const stored = await storageGet(this.#storageArea, storageKey, operation);
    const value = stored[storageKey];

    return value === undefined
      ? undefined
      : parseStoredEntry(storageKey, value);
  }

  async #loadAll(): Promise<readonly SyncQueueEntry[]> {
    const stored = await storageGet(this.#storageArea, null, 'list');
    const entries = Object.entries(stored)
      .filter(([storageKey]) =>
        storageKey.startsWith(SYNC_QUEUE_STORAGE_KEY_PREFIX),
      )
      .sort(([leftKey], [rightKey]) => compareCodeUnits(leftKey, rightKey))
      .map(([storageKey, value]) => parseStoredEntry(storageKey, value));

    return Object.freeze(entries);
  }

  #readClock(): Date {
    let value: Date;

    try {
      value = this.#clock();
    } catch {
      throw new SyncQueueError(
        'clock-failure',
        'The sync queue clock could not be read.',
      );
    }

    if (
      !(value instanceof Date) ||
      !Number.isFinite(value.getTime()) ||
      value.getTime() > 8_640_000_000_000_000 - SYNC_RETRY_MAX_DELAY_MS
    ) {
      throw new SyncQueueError(
        'clock-failure',
        'The sync queue clock returned an invalid time.',
      );
    }

    return value;
  }

  #readRandom(): number {
    let value: number;

    try {
      value = this.#random();
    } catch {
      throw new SyncQueueError(
        'random-failure',
        'The sync queue retry source could not be read.',
      );
    }

    if (!Number.isFinite(value) || value < 0 || value >= 1) {
      throw new SyncQueueError(
        'random-failure',
        'The sync queue retry source returned an invalid value.',
      );
    }

    return value;
  }

  async #run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await enqueueStorageOperation(this.#storageArea, operation);
    } catch (error) {
      if (error instanceof SyncQueueError) {
        throw error;
      }

      throw new SyncQueueError(
        'storage-failure',
        'The durable sync queue could not access extension storage.',
      );
    }
  }
}
