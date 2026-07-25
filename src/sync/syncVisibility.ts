import type { ByosClientConfig } from '../background/byosClient';
import type { ByosConnectionV1 } from '../domain/settings';
import type { SettingsRepository } from '../repositories/settingsRepository';
import type { SyncQueue, SyncQueueEntry } from './syncQueue';

export interface SyncVisibilityChanges {
  subscribeAll(listener: () => void): () => void;
  subscribePage(pageKey: string, listener: () => void): () => void;
}

export type PageSyncVisibilityMode =
  | 'checking'
  | 'local-only'
  | 'reconnect-required'
  | 'synced'
  | 'unavailable'
  | 'waiting'
  | 'waiting-reconnect'
  | 'waiting-unavailable';

export type PageSyncVisibilityState =
  | Readonly<{
      readonly pageKey: string;
      readonly status: 'loading';
    }>
  | Readonly<{
      readonly pageKey: string;
      readonly status: 'error';
    }>
  | Readonly<{
      readonly mode: PageSyncVisibilityMode;
      readonly pageKey: string;
      readonly lastSuccessfulSyncAt?: string;
      readonly pendingRevisionId?: string;
      readonly status: 'ready';
    }>;

export interface PageSyncVisibilityConnection {
  disconnect(): void;
  setPage(pageKey: string | undefined): void;
}

export interface PageSyncVisibility {
  connect(
    emitState: (state: PageSyncVisibilityState | undefined) => void,
  ): PageSyncVisibilityConnection;
}

export type PendingSyncCountState =
  | Readonly<{ readonly status: 'loading' }>
  | Readonly<{ readonly status: 'error' }>
  | Readonly<{ readonly count: number; readonly status: 'ready' }>;

export interface PendingSyncCountConnection {
  disconnect(): void;
}

export interface PendingSyncCount {
  connect(
    emitState: (state: PendingSyncCountState) => void,
  ): PendingSyncCountConnection;
}

type SyncSettingsReader = Pick<SettingsRepository, 'get'>;
type PageSyncQueueReader = Pick<SyncQueue, 'get'>;
type CountSyncQueueReader = Pick<SyncQueue, 'count'>;

export interface DefaultPageSyncVisibilityDependencies {
  readonly changes: SyncVisibilityChanges;
  readonly clock: () => Date;
  readonly config: ByosClientConfig;
  readonly queue: PageSyncQueueReader;
  readonly settings: SyncSettingsReader;
}

export interface DefaultPendingSyncCountDependencies {
  readonly changes: SyncVisibilityChanges;
  readonly queue: CountSyncQueueReader;
}

interface PageLoadCycle {
  readonly pageKey: string;
  completedRevision: number;
  requestedRevision: number;
  running: boolean;
  subscriptionError: boolean;
  subscriptionRevision: number;
  unsubscribe: (() => void) | undefined;
}

interface CountLoadCycle {
  completedRevision: number;
  requestedRevision: number;
  running: boolean;
  subscriptionError: boolean;
  subscriptionRevision: number;
  unsubscribe: (() => void) | undefined;
}

function isConfigured(config: ByosClientConfig): boolean {
  return (
    config.enabled &&
    typeof config.clientId === 'string' &&
    config.clientId.trim() !== ''
  );
}

function hasExpired(connection: ByosConnectionV1, clock: () => Date): boolean {
  let now: Date;
  const expiresAt = new Date(connection.expiresAt).valueOf();

  try {
    now = clock();
  } catch {
    return true;
  }

  return (
    !(now instanceof Date) ||
    !Number.isFinite(now.valueOf()) ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= now.valueOf()
  );
}

function readyPageState(
  pageKey: string,
  config: ByosClientConfig,
  connection: ByosConnectionV1 | undefined,
  entry: SyncQueueEntry | undefined,
  clock: () => Date,
): PageSyncVisibilityState {
  if (entry !== undefined) {
    return Object.freeze({
      mode: !isConfigured(config)
        ? ('waiting-unavailable' as const)
        : connection === undefined || hasExpired(connection, clock)
          ? ('waiting-reconnect' as const)
          : ('waiting' as const),
      pageKey,
      ...(connection?.lastSuccessfulSyncAt === undefined
        ? {}
        : { lastSuccessfulSyncAt: connection.lastSuccessfulSyncAt }),
      pendingRevisionId: entry.revisionId,
      status: 'ready' as const,
    });
  }

  if (!isConfigured(config)) {
    return Object.freeze({
      mode: 'unavailable' as const,
      pageKey,
      status: 'ready' as const,
    });
  }

  if (connection === undefined) {
    return Object.freeze({
      mode: 'local-only' as const,
      pageKey,
      status: 'ready' as const,
    });
  }

  const expired = hasExpired(connection, clock);

  return Object.freeze({
    mode: expired
      ? ('reconnect-required' as const)
      : connection.lastSuccessfulSyncAt === undefined
        ? ('checking' as const)
        : ('synced' as const),
    pageKey,
    ...(connection.lastSuccessfulSyncAt === undefined
      ? {}
      : { lastSuccessfulSyncAt: connection.lastSuccessfulSyncAt }),
    status: 'ready' as const,
  });
}

export class DefaultPageSyncVisibility implements PageSyncVisibility {
  readonly #dependencies: DefaultPageSyncVisibilityDependencies;
  #connectionId = 0;
  #currentConnectionId: number | undefined;
  #cycle: PageLoadCycle | undefined;
  #emitState:
    ((state: PageSyncVisibilityState | undefined) => void) | undefined;
  #state: PageSyncVisibilityState | undefined;

  constructor(dependencies: DefaultPageSyncVisibilityDependencies) {
    this.#dependencies = dependencies;
  }

  connect(
    emitState: (state: PageSyncVisibilityState | undefined) => void,
  ): PageSyncVisibilityConnection {
    const connectionId = ++this.#connectionId;
    this.#currentConnectionId = connectionId;
    this.#emitState = emitState;
    this.#emitCurrentState();

    return {
      disconnect: () => {
        queueMicrotask(() => {
          if (this.#currentConnectionId !== connectionId) {
            return;
          }

          this.#currentConnectionId = undefined;
          this.#emitState = undefined;
          this.#setPage(undefined);
        });
      },
      setPage: (pageKey) => {
        if (this.#currentConnectionId === connectionId) {
          this.#setPage(pageKey);
        }
      },
    };
  }

  #setPage(pageKey: string | undefined): void {
    if (this.#cycle?.pageKey === pageKey) {
      return;
    }

    const previous = this.#cycle;
    this.#cycle = undefined;
    this.#stopCycle(previous);

    if (pageKey === undefined) {
      this.#publish(undefined);
      return;
    }

    const cycle: PageLoadCycle = {
      pageKey,
      completedRevision: 0,
      requestedRevision: 0,
      running: false,
      subscriptionError: false,
      subscriptionRevision: 0,
      unsubscribe: undefined,
    };
    this.#cycle = cycle;
    this.#publish(Object.freeze({ pageKey, status: 'loading' as const }));
    this.#subscribe(cycle);
    this.#requestLoad(cycle);
  }

  #subscribe(cycle: PageLoadCycle): void {
    const revision = cycle.subscriptionRevision + 1;
    cycle.subscriptionRevision = revision;

    try {
      const unsubscribe = this.#dependencies.changes.subscribePage(
        cycle.pageKey,
        () => {
          if (
            this.#cycle === cycle &&
            cycle.subscriptionRevision === revision
          ) {
            this.#requestLoad(cycle);
          }
        },
      );

      if (typeof unsubscribe !== 'function') {
        throw new Error('Sync visibility subscription requires cleanup.');
      }

      cycle.unsubscribe = unsubscribe;
    } catch {
      cycle.subscriptionError = true;
    }
  }

  #requestLoad(cycle: PageLoadCycle): void {
    if (this.#cycle !== cycle) {
      return;
    }

    cycle.requestedRevision += 1;

    if (!cycle.running) {
      void this.#runLoads(cycle);
    }
  }

  async #runLoads(cycle: PageLoadCycle): Promise<void> {
    cycle.running = true;

    try {
      while (
        this.#cycle === cycle &&
        cycle.completedRevision < cycle.requestedRevision
      ) {
        const revision = cycle.requestedRevision;
        let connection: ByosConnectionV1 | undefined;
        let entry: SyncQueueEntry | undefined;

        try {
          if (isConfigured(this.#dependencies.config)) {
            const [settings, queued] = await Promise.all([
              Promise.resolve().then(() => this.#dependencies.settings.get()),
              Promise.resolve().then(() =>
                this.#dependencies.queue.get(cycle.pageKey),
              ),
            ]);
            connection = settings.byosConnection;
            entry = queued;
          } else {
            entry = await Promise.resolve().then(() =>
              this.#dependencies.queue.get(cycle.pageKey),
            );
          }
        } catch {
          if (this.#cycle !== cycle) {
            return;
          }

          cycle.completedRevision = revision;

          if (revision === cycle.requestedRevision) {
            this.#publish(
              Object.freeze({
                pageKey: cycle.pageKey,
                status: 'error' as const,
              }),
            );
          }
          continue;
        }

        if (this.#cycle !== cycle) {
          return;
        }

        cycle.completedRevision = revision;

        if (revision !== cycle.requestedRevision) {
          continue;
        }

        if (cycle.subscriptionError) {
          this.#publish(
            Object.freeze({
              pageKey: cycle.pageKey,
              status: 'error' as const,
            }),
          );
          continue;
        }

        this.#publish(
          readyPageState(
            cycle.pageKey,
            this.#dependencies.config,
            connection,
            entry,
            this.#dependencies.clock,
          ),
        );
      }
    } finally {
      cycle.running = false;

      if (
        this.#cycle === cycle &&
        cycle.completedRevision < cycle.requestedRevision
      ) {
        void this.#runLoads(cycle);
      }
    }
  }

  #stopCycle(cycle: PageLoadCycle | undefined): void {
    if (cycle === undefined) {
      return;
    }

    const unsubscribe = cycle.unsubscribe;
    cycle.unsubscribe = undefined;
    cycle.subscriptionRevision += 1;

    try {
      unsubscribe?.();
    } catch {
      // Chrome adapters disable forwarding before removal, keeping failed cleanup stale-safe.
    }
  }

  #publish(state: PageSyncVisibilityState | undefined): void {
    this.#state = state;
    this.#emitCurrentState();
  }

  #emitCurrentState(): void {
    try {
      this.#emitState?.(this.#state);
    } catch {
      // Presentation failures cannot interrupt passive local status observation.
    }
  }
}

export class DefaultPendingSyncCount implements PendingSyncCount {
  readonly #dependencies: DefaultPendingSyncCountDependencies;
  #connectionId = 0;
  #currentConnectionId: number | undefined;
  #cycle: CountLoadCycle | undefined;
  #emitState: ((state: PendingSyncCountState) => void) | undefined;
  #state: PendingSyncCountState = Object.freeze({ status: 'loading' });

  constructor(dependencies: DefaultPendingSyncCountDependencies) {
    this.#dependencies = dependencies;
  }

  connect(
    emitState: (state: PendingSyncCountState) => void,
  ): PendingSyncCountConnection {
    const connectionId = ++this.#connectionId;
    this.#currentConnectionId = connectionId;
    this.#emitState = emitState;
    this.#emitCurrentState();

    if (this.#cycle === undefined) {
      this.#start();
    }

    return {
      disconnect: () => {
        queueMicrotask(() => {
          if (this.#currentConnectionId !== connectionId) {
            return;
          }

          this.#currentConnectionId = undefined;
          this.#emitState = undefined;
          const cycle = this.#cycle;
          this.#cycle = undefined;
          this.#stopCycle(cycle);
        });
      },
    };
  }

  #start(): void {
    const cycle: CountLoadCycle = {
      completedRevision: 0,
      requestedRevision: 0,
      running: false,
      subscriptionError: false,
      subscriptionRevision: 0,
      unsubscribe: undefined,
    };
    this.#cycle = cycle;
    this.#publish(Object.freeze({ status: 'loading' as const }));
    this.#subscribe(cycle);
    this.#requestLoad(cycle);
  }

  #subscribe(cycle: CountLoadCycle): void {
    const revision = cycle.subscriptionRevision + 1;
    cycle.subscriptionRevision = revision;

    try {
      const unsubscribe = this.#dependencies.changes.subscribeAll(() => {
        if (this.#cycle === cycle && cycle.subscriptionRevision === revision) {
          this.#requestLoad(cycle);
        }
      });

      if (typeof unsubscribe !== 'function') {
        throw new Error('Pending sync count subscription requires cleanup.');
      }

      cycle.unsubscribe = unsubscribe;
    } catch {
      cycle.subscriptionError = true;
    }
  }

  #requestLoad(cycle: CountLoadCycle): void {
    if (this.#cycle !== cycle) {
      return;
    }

    cycle.requestedRevision += 1;

    if (!cycle.running) {
      void this.#runLoads(cycle);
    }
  }

  async #runLoads(cycle: CountLoadCycle): Promise<void> {
    cycle.running = true;

    try {
      while (
        this.#cycle === cycle &&
        cycle.completedRevision < cycle.requestedRevision
      ) {
        const revision = cycle.requestedRevision;
        let count: number;

        try {
          count = await Promise.resolve().then(() =>
            this.#dependencies.queue.count(),
          );

          if (!Number.isSafeInteger(count) || count < 0) {
            throw new Error('Invalid pending sync count.');
          }
        } catch {
          if (this.#cycle !== cycle) {
            return;
          }

          cycle.completedRevision = revision;

          if (revision === cycle.requestedRevision) {
            this.#publish(Object.freeze({ status: 'error' as const }));
          }
          continue;
        }

        if (this.#cycle !== cycle) {
          return;
        }

        cycle.completedRevision = revision;

        if (revision !== cycle.requestedRevision) {
          continue;
        }

        this.#publish(
          cycle.subscriptionError
            ? Object.freeze({ status: 'error' as const })
            : Object.freeze({ count, status: 'ready' as const }),
        );
      }
    } finally {
      cycle.running = false;

      if (
        this.#cycle === cycle &&
        cycle.completedRevision < cycle.requestedRevision
      ) {
        void this.#runLoads(cycle);
      }
    }
  }

  #stopCycle(cycle: CountLoadCycle | undefined): void {
    if (cycle === undefined) {
      return;
    }

    const unsubscribe = cycle.unsubscribe;
    cycle.unsubscribe = undefined;
    cycle.subscriptionRevision += 1;

    try {
      unsubscribe?.();
    } catch {
      // Chrome adapters disable forwarding before removal, keeping failed cleanup stale-safe.
    }
  }

  #publish(state: PendingSyncCountState): void {
    this.#state = state;
    this.#emitCurrentState();
  }

  #emitCurrentState(): void {
    try {
      this.#emitState?.(this.#state);
    } catch {
      // Presentation failures cannot interrupt passive pending-count observation.
    }
  }
}
