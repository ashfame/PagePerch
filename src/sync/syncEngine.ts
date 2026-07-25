import type { NoteRecordV1 } from '../domain/note';
import type { NoteRepository } from '../repositories/noteRepository';
import type { RemoteReplicaRepository } from '../repositories/remoteReplicaRepository';
import {
  isNoteRecordV1,
  isPageKey,
  isRevisionId,
  isUtcIsoTimestamp,
} from '../repositories/validation';
import {
  SYNC_RETRY_MAX_ATTEMPT_COUNT,
  type SyncQueue,
  type SyncQueueEntry,
} from './syncQueue';

export type ReplicaComparison =
  'equal' | 'integrity-conflict' | 'local-wins' | 'remote-wins';

export type SyncIssueCode =
  | 'integrity-conflict'
  | 'local-state-changed'
  | 'local-write-failure'
  | 'queue-write-failure'
  | 'remote-write-failure';

export interface SyncIssue {
  readonly pageKey: string;
  readonly code: SyncIssueCode;
}

export type SyncStatus = 'partial' | 'pending' | 'synced';

export interface SyncSummary {
  readonly status: SyncStatus;
  readonly total: number;
  readonly uploaded: number;
  readonly downloaded: number;
  readonly unchanged: number;
  readonly deferred: number;
  readonly conflicts: number;
  readonly failed: number;
  readonly pending: number;
  readonly issues: readonly SyncIssue[];
}

export type SyncEngineErrorCode =
  | 'clock-failure'
  | 'configuration'
  | 'local-list-failure'
  | 'prepare-failure'
  | 'queue-state-failure'
  | 'remote-list-failure'
  | 'repository-integrity';

export class SyncEngineError extends Error {
  readonly code: SyncEngineErrorCode;

  constructor(code: SyncEngineErrorCode, message: string) {
    super(message);
    this.name = 'SyncEngineError';
    this.code = code;
  }
}

export interface SyncEngineDependencies {
  readonly localRepository: NoteRepository;
  readonly remoteRepository: RemoteReplicaRepository;
  readonly queue: SyncQueue;
  readonly prepareLocalState: () => Promise<unknown>;
  readonly clock: () => Date;
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

function recordsEqual(left: NoteRecordV1, right: NoteRecordV1): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.pageKey === right.pageKey &&
    left.canonicalUrl === right.canonicalUrl &&
    left.representativeUrl === right.representativeUrl &&
    left.origin === right.origin &&
    left.title === right.title &&
    left.contentHtml === right.contentHtml &&
    left.contentHash === right.contentHash &&
    left.savedAt === right.savedAt &&
    left.revisionId === right.revisionId &&
    left.deletedAt === right.deletedAt
  );
}

export function compareReplicaRecords(
  local: NoteRecordV1,
  remote: NoteRecordV1,
): ReplicaComparison {
  if (
    !isNoteRecordV1(local) ||
    !isNoteRecordV1(remote) ||
    local.pageKey !== remote.pageKey
  ) {
    throw new SyncEngineError(
      'repository-integrity',
      'Replica comparison received invalid note records.',
    );
  }

  const localTime = new Date(local.savedAt).getTime();
  const remoteTime = new Date(remote.savedAt).getTime();

  if (localTime > remoteTime) {
    return 'local-wins';
  }

  if (remoteTime > localTime) {
    return 'remote-wins';
  }

  const revisionComparison = compareCodeUnits(
    local.revisionId,
    remote.revisionId,
  );

  if (revisionComparison > 0) {
    return 'local-wins';
  }

  if (revisionComparison < 0) {
    return 'remote-wins';
  }

  // Same version identifiers must describe one exact record; otherwise choosing a side would be nondeterministic.
  return recordsEqual(local, remote) ? 'equal' : 'integrity-conflict';
}

function mapRecords(
  records: readonly NoteRecordV1[],
): Map<string, NoteRecordV1> {
  if (!Array.isArray(records)) {
    throw new SyncEngineError(
      'repository-integrity',
      'A replica returned an invalid note collection.',
    );
  }

  const mapped = new Map<string, NoteRecordV1>();

  for (const record of records) {
    if (!isNoteRecordV1(record) || mapped.has(record.pageKey)) {
      throw new SyncEngineError(
        'repository-integrity',
        'A replica returned an invalid note collection.',
      );
    }

    mapped.set(record.pageKey, Object.freeze({ ...record }));
  }

  return mapped;
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

function mapQueueEntries(value: unknown): Map<string, SyncQueueEntry> {
  if (!Array.isArray(value)) {
    throw new SyncEngineError(
      'queue-state-failure',
      'Pending sync state is invalid and was left untouched.',
    );
  }

  const entries: SyncQueueEntry[] = [];
  const pageKeys = new Set<string>();

  for (const entry of value) {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, [
        'pageKey',
        'revisionId',
        'attemptCount',
        'nextAttemptAt',
      ]) ||
      !isPageKey(entry.pageKey) ||
      !isRevisionId(entry.revisionId) ||
      !Number.isInteger(entry.attemptCount) ||
      (entry.attemptCount as number) < 0 ||
      (entry.attemptCount as number) > SYNC_RETRY_MAX_ATTEMPT_COUNT ||
      !isUtcIsoTimestamp(entry.nextAttemptAt) ||
      pageKeys.has(entry.pageKey)
    ) {
      throw new SyncEngineError(
        'queue-state-failure',
        'Pending sync state is invalid and was left untouched.',
      );
    }

    pageKeys.add(entry.pageKey);
    entries.push(
      Object.freeze({
        pageKey: entry.pageKey,
        revisionId: entry.revisionId,
        attemptCount: entry.attemptCount as number,
        nextAttemptAt: entry.nextAttemptAt,
      }),
    );
  }

  entries.sort((left, right) => compareCodeUnits(left.pageKey, right.pageKey));
  Object.freeze(entries);

  return new Map(entries.map((entry) => [entry.pageKey, entry] as const));
}

function freezeIssue(pageKey: string, code: SyncIssueCode): SyncIssue {
  return Object.freeze({ pageKey, code });
}

function isExactRecord(
  current: NoteRecordV1 | undefined,
  expected: NoteRecordV1 | undefined,
): boolean {
  if (current === undefined || expected === undefined) {
    return current === expected;
  }

  return recordsEqual(current, expected);
}

export class SyncEngine {
  readonly #dependencies: SyncEngineDependencies;
  #inFlight: Promise<SyncSummary> | undefined;

  constructor(dependencies: SyncEngineDependencies) {
    if (
      typeof dependencies !== 'object' ||
      dependencies === null ||
      typeof dependencies.localRepository !== 'object' ||
      dependencies.localRepository === null ||
      typeof dependencies.localRepository.get !== 'function' ||
      typeof dependencies.localRepository.put !== 'function' ||
      typeof dependencies.localRepository.putIfCurrent !== 'function' ||
      typeof dependencies.localRepository.listAll !== 'function' ||
      typeof dependencies.remoteRepository !== 'object' ||
      dependencies.remoteRepository === null ||
      typeof dependencies.remoteRepository.put !== 'function' ||
      typeof dependencies.remoteRepository.listAll !== 'function' ||
      typeof dependencies.queue !== 'object' ||
      dependencies.queue === null ||
      typeof dependencies.queue.complete !== 'function' ||
      typeof dependencies.queue.count !== 'function' ||
      typeof dependencies.queue.fail !== 'function' ||
      typeof dependencies.queue.listAll !== 'function' ||
      typeof dependencies.prepareLocalState !== 'function' ||
      typeof dependencies.clock !== 'function'
    ) {
      throw new SyncEngineError(
        'configuration',
        'Sync engine dependencies are invalid.',
      );
    }

    this.#dependencies = dependencies;
  }

  sync(): Promise<SyncSummary> {
    if (this.#inFlight !== undefined) {
      return this.#inFlight;
    }

    const operation = this.#run();
    this.#inFlight = operation;
    const clearInFlight = (): void => {
      if (this.#inFlight === operation) {
        this.#inFlight = undefined;
      }
    };
    void operation.then(clearInFlight, clearInFlight);

    return operation;
  }

  async #run(): Promise<SyncSummary> {
    try {
      await this.#dependencies.prepareLocalState();
    } catch {
      throw new SyncEngineError(
        'prepare-failure',
        'Local PagePerch data could not be prepared for synchronization.',
      );
    }

    const now = this.#readClock();
    const [localResult, remoteResult, queueResult] = await Promise.allSettled([
      Promise.resolve().then(() =>
        this.#dependencies.localRepository.listAll(),
      ),
      Promise.resolve().then(() =>
        this.#dependencies.remoteRepository.listAll(),
      ),
      Promise.resolve().then(() => this.#dependencies.queue.listAll()),
    ]);

    if (localResult.status === 'rejected') {
      throw new SyncEngineError(
        'local-list-failure',
        'Local notes could not be read for synchronization.',
      );
    }

    if (remoteResult.status === 'rejected') {
      throw new SyncEngineError(
        'remote-list-failure',
        'Remote notes could not be read for synchronization.',
      );
    }

    if (queueResult.status === 'rejected') {
      throw new SyncEngineError(
        'queue-state-failure',
        'Pending sync state could not be read safely.',
      );
    }

    const localRecords = mapRecords(localResult.value);
    const remoteRecords = mapRecords(remoteResult.value);
    const queuedByPageKey = mapQueueEntries(queueResult.value);
    const pageKeys = [
      ...new Set([
        ...localRecords.keys(),
        ...remoteRecords.keys(),
        ...queuedByPageKey.keys(),
      ]),
    ].sort(compareCodeUnits);
    const issues: SyncIssue[] = [];
    let uploaded = 0;
    let downloaded = 0;
    let unchanged = 0;
    let deferred = 0;
    let conflicts = 0;
    let failed = 0;

    for (const pageKey of pageKeys) {
      const local = localRecords.get(pageKey);
      const remote = remoteRecords.get(pageKey);

      if (local === undefined) {
        if (remote === undefined) {
          const queued = queuedByPageKey.get(pageKey);

          if (queued !== undefined) {
            unchanged += 1;
            await this.#completeQueue(
              pageKey,
              queued.revisionId,
              queued,
              issues,
            );
          }

          continue;
        }

        const outcome = await this.#download(
          pageKey,
          undefined,
          remote,
          queuedByPageKey.get(pageKey),
          issues,
        );
        downloaded += outcome === 'downloaded' ? 1 : 0;
        failed += outcome === 'failed' ? 1 : 0;
        continue;
      }

      if (remote === undefined) {
        const outcome = await this.#upload(
          local,
          queuedByPageKey.get(pageKey),
          now,
          issues,
        );
        uploaded += outcome === 'uploaded' ? 1 : 0;
        deferred += outcome === 'deferred' ? 1 : 0;
        failed += outcome === 'failed' ? 1 : 0;
        continue;
      }

      const comparison = compareReplicaRecords(local, remote);

      if (comparison === 'equal') {
        unchanged += 1;
        await this.#completeQueue(
          pageKey,
          local.revisionId,
          queuedByPageKey.get(pageKey),
          issues,
        );
        continue;
      }

      if (comparison === 'integrity-conflict') {
        conflicts += 1;
        issues.push(freezeIssue(pageKey, 'integrity-conflict'));
        continue;
      }

      if (comparison === 'local-wins') {
        const outcome = await this.#upload(
          local,
          queuedByPageKey.get(pageKey),
          now,
          issues,
        );
        uploaded += outcome === 'uploaded' ? 1 : 0;
        deferred += outcome === 'deferred' ? 1 : 0;
        failed += outcome === 'failed' ? 1 : 0;
        continue;
      }

      const outcome = await this.#download(
        pageKey,
        local,
        remote,
        queuedByPageKey.get(pageKey),
        issues,
      );
      downloaded += outcome === 'downloaded' ? 1 : 0;
      failed += outcome === 'failed' ? 1 : 0;
    }

    let pending: number;

    try {
      pending = await this.#dependencies.queue.count();
    } catch {
      throw new SyncEngineError(
        'queue-state-failure',
        'Pending sync state could not be read safely.',
      );
    }

    const status: SyncStatus =
      issues.length > 0
        ? 'partial'
        : pending > 0 || deferred > 0
          ? 'pending'
          : 'synced';

    return Object.freeze({
      status,
      total: pageKeys.length,
      uploaded,
      downloaded,
      unchanged,
      deferred,
      conflicts,
      failed,
      pending,
      issues: Object.freeze(issues),
    });
  }

  async #upload(
    local: NoteRecordV1,
    queued: SyncQueueEntry | undefined,
    now: number,
    issues: SyncIssue[],
  ): Promise<'deferred' | 'failed' | 'uploaded'> {
    if (
      queued?.revisionId === local.revisionId &&
      new Date(queued.nextAttemptAt).getTime() > now
    ) {
      return 'deferred';
    }

    let currentLocal: NoteRecordV1 | undefined;

    try {
      currentLocal = await this.#dependencies.localRepository.get(
        local.pageKey,
      );
    } catch {
      issues.push(freezeIssue(local.pageKey, 'local-state-changed'));
      return 'failed';
    }

    if (!isExactRecord(currentLocal, local)) {
      issues.push(freezeIssue(local.pageKey, 'local-state-changed'));
      return 'failed';
    }

    try {
      await this.#dependencies.remoteRepository.put(local);
    } catch {
      await this.#recordUploadFailure(local, queued, issues);
      issues.push(freezeIssue(local.pageKey, 'remote-write-failure'));
      return 'failed';
    }

    await this.#completeQueue(local.pageKey, local.revisionId, queued, issues);
    return 'uploaded';
  }

  async #download(
    pageKey: string,
    expectedLocal: NoteRecordV1 | undefined,
    remote: NoteRecordV1,
    queued: SyncQueueEntry | undefined,
    issues: SyncIssue[],
  ): Promise<'downloaded' | 'failed'> {
    try {
      const result = await this.#dependencies.localRepository.putIfCurrent(
        expectedLocal,
        remote,
      );

      if (result === 'mismatch') {
        issues.push(freezeIssue(pageKey, 'local-state-changed'));
        return 'failed';
      }

      if (result !== 'applied') {
        throw new Error('Invalid conditional note result.');
      }
    } catch {
      issues.push(freezeIssue(pageKey, 'local-write-failure'));
      return 'failed';
    }

    await this.#completeQueue(pageKey, remote.revisionId, queued, issues);
    return 'downloaded';
  }

  async #recordUploadFailure(
    local: NoteRecordV1,
    queued: SyncQueueEntry | undefined,
    issues: SyncIssue[],
  ): Promise<void> {
    try {
      if (queued !== undefined && queued.revisionId !== local.revisionId) {
        await this.#dependencies.queue.complete(
          local.pageKey,
          queued.revisionId,
        );
      }

      await this.#dependencies.queue.fail(local.pageKey, local.revisionId);
    } catch {
      issues.push(freezeIssue(local.pageKey, 'queue-write-failure'));
    }
  }

  async #completeQueue(
    pageKey: string,
    syncedRevisionId: string,
    queued: SyncQueueEntry | undefined,
    issues: SyncIssue[],
  ): Promise<void> {
    try {
      await this.#dependencies.queue.complete(pageKey, syncedRevisionId);

      if (queued !== undefined && queued.revisionId !== syncedRevisionId) {
        await this.#dependencies.queue.complete(pageKey, queued.revisionId);
      }
    } catch {
      issues.push(freezeIssue(pageKey, 'queue-write-failure'));
    }
  }

  #readClock(): number {
    let value: Date;

    try {
      value = this.#dependencies.clock();
    } catch {
      throw new SyncEngineError(
        'clock-failure',
        'The synchronization clock could not be read.',
      );
    }

    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new SyncEngineError(
        'clock-failure',
        'The synchronization clock returned an invalid time.',
      );
    }

    return value.getTime();
  }
}
