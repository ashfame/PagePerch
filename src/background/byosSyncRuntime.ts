import type { ByosClientConfig } from './byosClient';
import { createByosClient } from './byosClient';
import type { ByosConnectionV1 } from '../domain/settings';
import { ChromeLocalNoteRepository } from '../repositories/chromeLocalNoteRepository';
import { ChromeLocalSettingsRepository } from '../repositories/chromeLocalSettingsRepository';
import { ChromeLocalSyncQueue } from '../repositories/chromeLocalSyncQueue';
import type { S3ReplicaCredentialProvider } from '../repositories/s3ReplicaRepository';
import type {
  SettingsConnectionCasResult,
  SettingsRepository,
} from '../repositories/settingsRepository';
import { S3ReplicaRepository } from '../repositories/s3ReplicaRepository';
import type { SyncEngine, SyncSummary } from '../sync/syncEngine';
import { SyncEngine as DefaultSyncEngine } from '../sync/syncEngine';
import { SYNC_RETRY_BASE_DELAY_MS, type SyncQueue } from '../sync/syncQueue';
import type { ByosCoordinator } from '../services/byosCoordinator';
import { recoverPendingIdentityMigration } from './identityMigrationRecovery';

export const BYOS_SYNC_PERIODIC_ALARM = 'pageperch:v1:byos-sync-periodic';
export const BYOS_SYNC_RETRY_ALARM = 'pageperch:v1:byos-sync-retry';
export const BYOS_SYNC_PERIOD_MINUTES = 15;
export const BYOS_S3_ENDPOINT = 'https://byos.ashfame.com';
export const BYOS_S3_REGION = 'us-east-1';

export type ByosSyncRuntimeStatus =
  | 'disconnected'
  | 'failed'
  | 'partial'
  | 'pending'
  | 'reconnect-required'
  | 'synced'
  | 'unavailable';

export interface ByosSyncRuntimeOutcome {
  readonly status: ByosSyncRuntimeStatus;
  readonly uploaded: number;
  readonly downloaded: number;
  readonly unchanged: number;
  readonly conflicts: number;
  readonly failed: number;
  readonly pending: number;
}

type SyncSettingsPort = Pick<
  SettingsRepository,
  'get' | 'updateLastSuccessfulSyncAtIfCurrent'
>;

export interface ByosSyncAlarmPort {
  create(
    name: string,
    alarmInfo: { readonly periodInMinutes: number } | { readonly when: number },
  ): Promise<void>;
  clear(name: string): Promise<boolean>;
}

export interface ByosSyncRuntimeDependencies {
  readonly config: ByosClientConfig;
  readonly settings: SyncSettingsPort;
  readonly engine: Pick<SyncEngine, 'sync'>;
  readonly queue: Pick<SyncQueue, 'fail' | 'listAll' | 'listDue'>;
  readonly credentials: ByosSyncCredentialSession;
  readonly alarms: ByosSyncAlarmPort;
  readonly clock: () => Date;
}

export interface ByosSyncCredentialSession {
  bind(connection: ByosConnectionV1): () => void;
  invalidate(): void;
}

export interface ByosS3ReplicaCredentialProvider
  extends S3ReplicaCredentialProvider, ByosSyncCredentialSession {}

function emptyOutcome(status: ByosSyncRuntimeStatus): ByosSyncRuntimeOutcome {
  return Object.freeze({
    status,
    uploaded: 0,
    downloaded: 0,
    unchanged: 0,
    conflicts: 0,
    failed: status === 'failed' ? 1 : 0,
    pending: 0,
  });
}

function summaryOutcome(summary: SyncSummary): ByosSyncRuntimeOutcome {
  return Object.freeze({
    status: summary.status,
    uploaded: summary.uploaded,
    downloaded: summary.downloaded,
    unchanged: summary.unchanged,
    conflicts: summary.conflicts,
    failed: summary.failed,
    pending: summary.pending,
  });
}

function isSafeCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isSafeSummary(summary: SyncSummary): boolean {
  return (
    (summary.status === 'partial' ||
      summary.status === 'pending' ||
      summary.status === 'synced') &&
    isSafeCount(summary.uploaded) &&
    isSafeCount(summary.downloaded) &&
    isSafeCount(summary.unchanged) &&
    isSafeCount(summary.conflicts) &&
    isSafeCount(summary.failed) &&
    isSafeCount(summary.pending)
  );
}

function readValidClock(clock: () => Date): Date | undefined {
  try {
    const value = clock();

    return value instanceof Date && Number.isFinite(value.valueOf())
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function hasUsableConfig(config: ByosClientConfig): boolean {
  return (
    config.enabled &&
    typeof config.clientId === 'string' &&
    config.clientId.trim() !== ''
  );
}

function hasUsableConnection(
  connection: ByosConnectionV1 | undefined,
  now: Date,
): connection is ByosConnectionV1 {
  return (
    connection !== undefined &&
    connection.accessToken.trim() === connection.accessToken &&
    connection.accessToken !== '' &&
    new Date(connection.expiresAt).valueOf() > now.valueOf()
  );
}

export class ByosSyncRuntime {
  readonly #dependencies: ByosSyncRuntimeDependencies;
  #inFlight: Promise<ByosSyncRuntimeOutcome> | undefined;
  #inFlightGeneration: number | undefined;
  #followUp: Promise<ByosSyncRuntimeOutcome> | undefined;
  #connectionGeneration = 0;

  constructor(dependencies: ByosSyncRuntimeDependencies) {
    this.#dependencies = dependencies;
  }

  async start(): Promise<ByosSyncRuntimeOutcome> {
    const alarm = this.#ensurePeriodicAlarm();
    const outcome = this.trigger();

    await alarm;
    return outcome;
  }

  trigger(): Promise<ByosSyncRuntimeOutcome> {
    if (this.#inFlight !== undefined) {
      if (this.#inFlightGeneration !== this.#connectionGeneration) {
        if (this.#followUp !== undefined) {
          return this.#followUp;
        }

        const inFlight = this.#inFlight;
        const runFollowUp = (): Promise<ByosSyncRuntimeOutcome> => {
          if (this.#followUp === followUp) {
            this.#followUp = undefined;
          }

          return this.trigger();
        };
        const followUp = inFlight.then(runFollowUp, runFollowUp);
        this.#followUp = followUp;

        return followUp;
      }

      return this.#inFlight;
    }

    const operation = this.#run();
    this.#inFlight = operation;
    this.#inFlightGeneration = this.#connectionGeneration;
    const clear = (): void => {
      if (this.#inFlight === operation) {
        this.#inFlight = undefined;
        this.#inFlightGeneration = undefined;
      }
    };
    void operation.then(clear, clear);

    return operation;
  }

  invalidateCredentials(): void {
    this.#connectionGeneration += 1;

    try {
      this.#dependencies.credentials.invalidate();
    } catch {
      // The generation change still prevents the active run from recording success.
    }
  }

  async handleAlarm(name: string): Promise<ByosSyncRuntimeOutcome | undefined> {
    if (name !== BYOS_SYNC_PERIODIC_ALARM && name !== BYOS_SYNC_RETRY_ALARM) {
      return undefined;
    }

    return this.trigger();
  }

  async #run(): Promise<ByosSyncRuntimeOutcome> {
    if (!hasUsableConfig(this.#dependencies.config)) {
      await this.#clearRetryAlarm();
      return emptyOutcome('unavailable');
    }

    let settings;

    try {
      settings = await this.#dependencies.settings.get();
    } catch {
      await this.#handleGlobalFailure();
      return emptyOutcome('failed');
    }

    const connection =
      settings.byosConnection === undefined
        ? undefined
        : Object.freeze({ ...settings.byosConnection });
    const now = readValidClock(this.#dependencies.clock);

    if (connection === undefined) {
      await this.#clearRetryAlarm();
      return emptyOutcome('disconnected');
    }

    if (now === undefined || !hasUsableConnection(connection, now)) {
      await this.#clearRetryAlarm();
      return emptyOutcome('reconnect-required');
    }

    let summary: SyncSummary;
    let releaseCredentials = (): void => undefined;
    const connectionGeneration = this.#connectionGeneration;

    try {
      releaseCredentials = this.#dependencies.credentials.bind(connection);
      summary = await this.#dependencies.engine.sync();
    } catch {
      await this.#handleGlobalFailure();
      return emptyOutcome('failed');
    } finally {
      try {
        releaseCredentials();
      } catch {
        this.invalidateCredentials();
      }
    }

    if (!isSafeSummary(summary)) {
      await this.#handleGlobalFailure();
      return emptyOutcome('failed');
    }

    if (connectionGeneration !== this.#connectionGeneration) {
      await this.#scheduleRetryAlarm();
      return emptyOutcome('failed');
    }

    if (summary.status === 'synced') {
      const completedAt = readValidClock(this.#dependencies.clock);

      if (completedAt === undefined) {
        await this.#scheduleRetryAlarm();
        return emptyOutcome('failed');
      }

      let metadataResult: SettingsConnectionCasResult;

      try {
        metadataResult =
          await this.#dependencies.settings.updateLastSuccessfulSyncAtIfCurrent(
            connection,
            completedAt.toISOString(),
          );
      } catch {
        await this.#scheduleRetryAlarm();
        return emptyOutcome('failed');
      }

      if (metadataResult !== 'applied' && metadataResult !== 'mismatch') {
        await this.#scheduleRetryAlarm();
        return emptyOutcome('failed');
      }
    }

    await this.#scheduleRetryAlarm();
    return summaryOutcome(summary);
  }

  async #ensurePeriodicAlarm(): Promise<void> {
    try {
      await this.#dependencies.alarms.create(BYOS_SYNC_PERIODIC_ALARM, {
        periodInMinutes: BYOS_SYNC_PERIOD_MINUTES,
      });
    } catch {
      // Alarm recreation is best effort; startup and user activity still trigger synchronization.
    }
  }

  async #clearRetryAlarm(): Promise<void> {
    try {
      await this.#dependencies.alarms.clear(BYOS_SYNC_RETRY_ALARM);
    } catch {
      // A stale retry alarm is harmless because every trigger repeats the connection preflight.
    }
  }

  async #handleGlobalFailure(): Promise<void> {
    let dueEntries;

    try {
      dueEntries = await this.#dependencies.queue.listDue();
    } catch {
      await this.#scheduleRetryAlarm();
      return;
    }

    for (const entry of dueEntries) {
      try {
        await this.#dependencies.queue.fail(entry.pageKey, entry.revisionId);
      } catch {
        // The exact revision remains durable; alarm scheduling below avoids a tight retry loop.
      }
    }

    await this.#scheduleRetryAlarm();
  }

  async #scheduleRetryAlarm(): Promise<void> {
    let entries;

    try {
      entries = await this.#dependencies.queue.listAll();
    } catch {
      return;
    }

    if (entries.length === 0) {
      await this.#clearRetryAlarm();
      return;
    }

    const earliest = entries.reduce(
      (current, entry) =>
        Math.min(current, new Date(entry.nextAttemptAt).valueOf()),
      Number.POSITIVE_INFINITY,
    );
    const now = readValidClock(this.#dependencies.clock);

    if (now === undefined || !Number.isFinite(earliest)) {
      return;
    }

    try {
      await this.#dependencies.alarms.create(BYOS_SYNC_RETRY_ALARM, {
        when: Math.max(now.valueOf() + SYNC_RETRY_BASE_DELAY_MS, earliest),
      });
    } catch {
      // Periodic and activity triggers remain available when one-shot alarm creation fails.
    }
  }
}

export class ChromeByosSyncAlarmPort implements ByosSyncAlarmPort {
  async create(
    name: string,
    alarmInfo: { readonly periodInMinutes: number } | { readonly when: number },
  ): Promise<void> {
    await chrome.alarms.create(name, alarmInfo);
  }

  clear(name: string): Promise<boolean> {
    return chrome.alarms.clear(name);
  }
}

export function createByosS3ReplicaCredentialProvider(
  coordinator: Pick<ByosCoordinator, 'getProtocolCredentials'>,
  invalidateProtocolCredentials: () => void = () => undefined,
): ByosS3ReplicaCredentialProvider {
  let binding:
    | {
        readonly connection: ByosConnectionV1;
        readonly generation: number;
      }
    | undefined;
  let generation = 0;

  return Object.freeze({
    bind: (connection: ByosConnectionV1) => {
      generation += 1;
      const boundGeneration = generation;
      binding = {
        connection: Object.freeze({ ...connection }),
        generation: boundGeneration,
      };

      return () => {
        if (binding?.generation === boundGeneration) {
          binding = undefined;
        }
      };
    },
    get: async () => {
      const active = binding;

      if (active === undefined) {
        throw new Error(
          'BYOS synchronization credentials are not bound to a connection.',
        );
      }

      const credentials = await coordinator.getProtocolCredentials(
        active.connection,
      );

      if (
        binding?.generation !== active.generation ||
        generation !== active.generation
      ) {
        throw new Error(
          'BYOS synchronization credentials are no longer current.',
        );
      }

      return Object.freeze({
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
        bucket: credentials.bucket,
      });
    },
    invalidate: () => {
      generation += 1;
      binding = undefined;
      invalidateProtocolCredentials();
    },
  });
}

export function createProductionByosSyncRuntime(): ByosSyncRuntime {
  const clock = () => new Date();
  const settings = new ChromeLocalSettingsRepository();
  const queue = new ChromeLocalSyncQueue({
    clock,
    random: Math.random,
  });
  const byos = createByosClient();
  const credentials = createByosS3ReplicaCredentialProvider(
    byos.coordinator,
    () => {
      byos.invalidateProtocolCredentials();
    },
  );
  const remote = new S3ReplicaRepository({
    endpoint: BYOS_S3_ENDPOINT,
    region: BYOS_S3_REGION,
    credentialProvider: credentials,
  });
  const engine = new DefaultSyncEngine({
    localRepository: new ChromeLocalNoteRepository(),
    remoteRepository: remote,
    queue,
    prepareLocalState: recoverPendingIdentityMigration,
    clock,
  });

  return new ByosSyncRuntime({
    config: byos.config,
    settings,
    engine,
    queue,
    credentials,
    alarms: new ChromeByosSyncAlarmPort(),
    clock,
  });
}
