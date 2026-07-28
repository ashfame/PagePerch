import type { NoteRecordV1, NoteService } from '../domain/note';
import type { SupportedActivePageSessionState } from './activePageSession';

type RecentNoteService = Pick<NoteService, 'listRecentByOrigin'>;

export interface RootRecentNoteChanges {
  subscribe(origin: string, listener: () => void): () => void;
}

export interface RootRecentNoteEntry {
  readonly canonicalUrl: string;
  readonly pageKey: string;
  readonly savedAt: string;
  readonly title: string;
}

export type RootRecentNotesState =
  | Readonly<{
      pageKey: string;
      status: 'loading';
    }>
  | Readonly<{
      loadError: true;
      pageKey: string;
      status: 'error';
      subscriptionError: boolean;
    }>
  | Readonly<{
      entries: readonly RootRecentNoteEntry[];
      pageKey: string;
      refreshError: boolean;
      refreshing: boolean;
      status: 'ready';
      subscriptionError: boolean;
    }>;

export interface RootRecentNotesConnection {
  disconnect(): void;
  retry(): void;
  setSession(session: SupportedActivePageSessionState | undefined): void;
}

export interface RootRecentNotesIndex {
  connect(
    emitState: (state: RootRecentNotesState | undefined) => void,
  ): RootRecentNotesConnection;
}

interface RecentNotesContext {
  readonly isRoot: boolean;
  readonly origin: string;
  readonly pageKey: string;
  readonly pathname: string;
}

interface LoadCycle {
  readonly context: RecentNotesContext;
  completedRevision: number;
  entries: readonly RootRecentNoteEntry[] | undefined;
  requestedRevision: number;
  running: boolean;
  subscriptionError: boolean;
  subscriptionRevision: number;
  unsubscribe: (() => void) | undefined;
}

function recentNotesContext(
  session: SupportedActivePageSessionState | undefined,
): RecentNotesContext | undefined {
  if (session === undefined) {
    return undefined;
  }

  let canonicalUrl: URL;

  try {
    canonicalUrl = new URL(session.identity.canonicalUrl);
  } catch {
    return undefined;
  }

  if (
    (canonicalUrl.protocol !== 'http:' && canonicalUrl.protocol !== 'https:') ||
    canonicalUrl.origin !== session.identity.origin
  ) {
    return undefined;
  }

  return {
    isRoot: session.identity.isRoot,
    origin: session.identity.origin,
    pageKey: session.identity.pageKey,
    pathname: canonicalUrl.pathname,
  };
}

function sameContext(
  left: RecentNotesContext | undefined,
  right: RecentNotesContext | undefined,
): boolean {
  return (
    left?.isRoot === right?.isRoot &&
    left?.origin === right?.origin &&
    left?.pageKey === right?.pageKey &&
    left?.pathname === right?.pathname
  );
}

function immutableEntries(
  records: readonly NoteRecordV1[],
  context: RecentNotesContext,
): readonly RootRecentNoteEntry[] {
  return Object.freeze(
    records
      .filter((record) => {
        if (
          record.deletedAt !== undefined ||
          record.pageKey === context.pageKey ||
          record.origin !== context.origin
        ) {
          return false;
        }

        let canonicalUrl: URL;

        try {
          canonicalUrl = new URL(record.canonicalUrl);
        } catch {
          return false;
        }

        if (
          (canonicalUrl.protocol !== 'http:' &&
            canonicalUrl.protocol !== 'https:') ||
          canonicalUrl.origin !== context.origin
        ) {
          return false;
        }

        if (context.isRoot) {
          return true;
        }

        if (canonicalUrl.pathname === context.pathname) {
          return false;
        }

        const descendantPrefix = context.pathname.endsWith('/')
          ? context.pathname
          : `${context.pathname}/`;

        return canonicalUrl.pathname.startsWith(descendantPrefix);
      })
      .map((record) =>
        Object.freeze({
          canonicalUrl: record.canonicalUrl,
          pageKey: record.pageKey,
          savedAt: record.savedAt,
          title: record.title,
        }),
      ),
  );
}

export class DefaultRootRecentNotesIndex implements RootRecentNotesIndex {
  readonly #changes: RootRecentNoteChanges;
  readonly #noteService: RecentNoteService;
  #connectionId = 0;
  #currentConnectionId: number | undefined;
  #cycle: LoadCycle | undefined;
  #emitState: ((state: RootRecentNotesState | undefined) => void) | undefined;
  #state: RootRecentNotesState | undefined;

  constructor(noteService: RecentNoteService, changes: RootRecentNoteChanges) {
    this.#noteService = noteService;
    this.#changes = changes;
  }

  connect(
    emitState: (state: RootRecentNotesState | undefined) => void,
  ): RootRecentNotesConnection {
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
          this.#setContext(undefined);
        });
      },
      retry: () => {
        if (this.#currentConnectionId !== connectionId) {
          return;
        }

        const cycle = this.#cycle;

        if (cycle === undefined) {
          return;
        }

        if (cycle.subscriptionError) {
          this.#subscribe(cycle);
        }
        this.#requestLoad(cycle);
      },
      setSession: (session) => {
        if (this.#currentConnectionId !== connectionId) {
          return;
        }

        this.#setContext(recentNotesContext(session));
      },
    };
  }

  #setContext(context: RecentNotesContext | undefined): void {
    if (sameContext(this.#cycle?.context, context)) {
      return;
    }

    const previousCycle = this.#cycle;
    this.#cycle = undefined;
    this.#stopCycle(previousCycle);

    if (context === undefined) {
      this.#publish(undefined);

      return;
    }

    const cycle: LoadCycle = {
      context,
      completedRevision: 0,
      entries: undefined,
      requestedRevision: 0,
      running: false,
      subscriptionError: false,
      subscriptionRevision: 0,
      unsubscribe: undefined,
    };
    this.#cycle = cycle;
    this.#publish(
      Object.freeze({
        pageKey: context.pageKey,
        status: 'loading' as const,
      }),
    );
    this.#subscribe(cycle);
    this.#requestLoad(cycle);
  }

  #subscribe(cycle: LoadCycle): void {
    if (this.#cycle !== cycle || cycle.unsubscribe !== undefined) {
      return;
    }

    const subscriptionRevision = cycle.subscriptionRevision + 1;
    cycle.subscriptionRevision = subscriptionRevision;

    try {
      const unsubscribe = this.#changes.subscribe(cycle.context.origin, () => {
        if (
          this.#cycle === cycle &&
          cycle.subscriptionRevision === subscriptionRevision
        ) {
          this.#requestLoad(cycle);
        }
      });

      if (typeof unsubscribe !== 'function') {
        throw new Error(
          'Recent-note change subscription did not return cleanup.',
        );
      }

      cycle.unsubscribe = unsubscribe;
      cycle.subscriptionError = false;
    } catch {
      if (cycle.subscriptionRevision === subscriptionRevision) {
        cycle.subscriptionRevision += 1;
      }
      cycle.subscriptionError = true;
    }
  }

  #requestLoad(cycle: LoadCycle): void {
    if (this.#cycle !== cycle) {
      return;
    }

    cycle.requestedRevision += 1;

    if (cycle.entries === undefined) {
      if (this.#state?.status !== 'loading') {
        this.#publish(
          Object.freeze({
            pageKey: cycle.context.pageKey,
            status: 'loading' as const,
          }),
        );
      }
    } else if (
      this.#state?.status !== 'ready' ||
      !this.#state.refreshing ||
      this.#state.refreshError
    ) {
      this.#publishReady(cycle, true, false);
    }

    if (!cycle.running) {
      void this.#runLoads(cycle);
    }
  }

  async #runLoads(cycle: LoadCycle): Promise<void> {
    cycle.running = true;

    try {
      while (
        this.#cycle === cycle &&
        cycle.completedRevision < cycle.requestedRevision
      ) {
        const revision = cycle.requestedRevision;
        let records: readonly NoteRecordV1[];

        try {
          records = await this.#noteService.listRecentByOrigin(
            cycle.context.origin,
          );
        } catch {
          if (this.#cycle !== cycle) {
            return;
          }

          cycle.completedRevision = revision;

          if (revision !== cycle.requestedRevision) {
            continue;
          }

          this.#publishLoadFailure(cycle);

          continue;
        }

        if (this.#cycle !== cycle) {
          return;
        }

        cycle.completedRevision = revision;

        if (revision !== cycle.requestedRevision) {
          continue;
        }

        try {
          cycle.entries = immutableEntries(records, cycle.context);
        } catch {
          this.#publishLoadFailure(cycle);
          continue;
        }
        this.#publishReady(cycle, false, false);
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

  #publishReady(
    cycle: LoadCycle,
    refreshing: boolean,
    refreshError: boolean,
  ): void {
    const entries = cycle.entries;

    if (entries === undefined) {
      return;
    }

    this.#publish(
      Object.freeze({
        entries,
        pageKey: cycle.context.pageKey,
        refreshError,
        refreshing,
        status: 'ready' as const,
        subscriptionError: cycle.subscriptionError,
      }),
    );
  }

  #publishLoadFailure(cycle: LoadCycle): void {
    if (cycle.entries === undefined) {
      this.#publish(
        Object.freeze({
          loadError: true as const,
          pageKey: cycle.context.pageKey,
          status: 'error' as const,
          subscriptionError: cycle.subscriptionError,
        }),
      );
    } else {
      this.#publishReady(cycle, false, true);
    }
  }

  #stopCycle(cycle: LoadCycle | undefined): void {
    if (cycle === undefined) {
      return;
    }

    const unsubscribe = cycle.unsubscribe;
    cycle.unsubscribe = undefined;
    cycle.subscriptionRevision += 1;

    try {
      unsubscribe?.();
    } catch {
      // Adapters disable forwarding before removal so failed removal is stale-safe.
    }
  }

  #publish(state: RootRecentNotesState | undefined): void {
    this.#state = state;
    this.#emitCurrentState();
  }

  #emitCurrentState(): void {
    try {
      this.#emitState?.(this.#state);
    } catch {
      // Presentation failures cannot interrupt index ownership.
    }
  }
}
