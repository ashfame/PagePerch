import type { SupportedActivePageSessionState } from './activePageSession';
import type {
  PageNoteDraftPageContext,
  PageNoteDraftState,
} from './pageNoteDraft';

export interface PageNoteDraftRuntime {
  getState(): PageNoteDraftState;
  start(): Promise<void>;
  retry(): Promise<void>;
  contentChanged(contentHtml: string): void;
  updatePageContext(pageContext: PageNoteDraftPageContext): void;
  flushPendingSave(): Promise<void>;
  stop(): Promise<void>;
}

export type CreatePageNoteDraftRuntime = (
  pageContext: PageNoteDraftPageContext,
  emitState: (state: PageNoteDraftState) => void,
) => PageNoteDraftRuntime;

export type RegisterPendingPageSave = (
  handler: () => Promise<void>,
) => () => void;

export type PageNoteOwnershipView =
  | Readonly<{
      pageKey: string;
      status: 'state';
      state: PageNoteDraftState;
      runtime: PageNoteDraftRuntime;
    }>
  | Readonly<{
      pageKey: string;
      status: 'runtime-error';
      message: string;
    }>;

export interface PageNoteOwnershipConnection {
  setSession(session: SupportedActivePageSessionState | undefined): void;
  retry(): void;
  disconnect(): void;
}

export interface PageNoteOwnership {
  connect(
    emitView: (view: PageNoteOwnershipView | undefined) => void,
  ): PageNoteOwnershipConnection;
}

interface DraftOwner {
  readonly pageKey: string;
  readonly runtime: PageNoteDraftRuntime;
  readonly startOutcome: Promise<StartOutcome>;
  context: PageNoteDraftPageContext;
  acceptingEmissions: boolean;
  invalid: boolean;
  needsRepublish: boolean;
  phase: 'starting' | 'started';
  unregister?: () => void;
}

type StartOutcome =
  | Readonly<{ status: 'fulfilled' }>
  | Readonly<{ status: 'rejected'; error: unknown }>;

interface RequestWaiter {
  readonly resolve: () => void;
}

interface OwnershipFailure {
  readonly message: string;
  readonly pageKey: string | undefined;
  readonly provenance: 'cleanup' | 'runtime';
}

const NOTE_RUNTIME_ERROR =
  'PagePerch could not prepare this local note. Retry.';
const NOTE_STOP_ERROR =
  'PagePerch could not finish saving the previous local note. Retry.';

function draftContext(
  session: SupportedActivePageSessionState,
): PageNoteDraftPageContext {
  return {
    identity: { ...session.identity },
    representativeUrl: session.representativeUrl,
    activeTabTitle: session.title,
  };
}

function haveSameDraftContext(
  left: PageNoteDraftPageContext,
  right: PageNoteDraftPageContext,
): boolean {
  return (
    left.representativeUrl === right.representativeUrl &&
    left.activeTabTitle === right.activeTabTitle &&
    left.identity.pageKey === right.identity.pageKey &&
    left.identity.canonicalUrl === right.identity.canonicalUrl &&
    left.identity.origin === right.identity.origin &&
    left.identity.pathname === right.identity.pathname &&
    left.identity.isRoot === right.identity.isRoot
  );
}

function cloneSession(
  session: SupportedActivePageSessionState,
): SupportedActivePageSessionState {
  return {
    ...session,
    identity: { ...session.identity },
  };
}

export class DefaultPageNoteOwnership implements PageNoteOwnership {
  readonly #createDraftRuntime: CreatePageNoteDraftRuntime;
  readonly #registerPendingSave: RegisterPendingPageSave;
  readonly #requestWaiters = new Set<RequestWaiter>();
  #connectionId = 0;
  #currentConnectionId: number | undefined;
  #emitView: ((view: PageNoteOwnershipView | undefined) => void) | undefined;
  #view: PageNoteOwnershipView | undefined;
  #desired: SupportedActivePageSessionState | undefined;
  #owner: DraftOwner | undefined;
  #requestVersion = 0;
  #reconciledVersion = 0;
  #transition: Promise<void> | undefined;
  #failure: OwnershipFailure | undefined;

  constructor(
    createDraftRuntime: CreatePageNoteDraftRuntime,
    registerPendingSave: RegisterPendingPageSave,
  ) {
    this.#createDraftRuntime = createDraftRuntime;
    this.#registerPendingSave = registerPendingSave;
  }

  connect(
    emitView: (view: PageNoteOwnershipView | undefined) => void,
  ): PageNoteOwnershipConnection {
    const connectionId = ++this.#connectionId;
    this.#currentConnectionId = connectionId;
    this.#emitView = emitView;
    this.#emitCurrentView();

    return {
      setSession: (session) => {
        if (this.#currentConnectionId !== connectionId) {
          return;
        }

        this.#clearRuntimeFailureFor(session);
        this.#desired =
          session === undefined ? undefined : cloneSession(session);
        this.#requestReconcile();
      },
      retry: () => {
        if (
          this.#currentConnectionId !== connectionId ||
          this.#desired === undefined
        ) {
          return;
        }

        this.#failure = undefined;
        this.#publish(undefined);
        this.#requestReconcile();
      },
      disconnect: () => {
        queueMicrotask(() => {
          if (this.#currentConnectionId !== connectionId) {
            return;
          }

          this.#currentConnectionId = undefined;
          this.#emitView = undefined;
          this.#clearRuntimeFailureFor(undefined);
          this.#desired = undefined;
          this.#requestReconcile();
        });
      },
    };
  }

  #requestReconcile(): void {
    this.#requestVersion += 1;

    for (const waiter of this.#requestWaiters) {
      waiter.resolve();
    }
    this.#requestWaiters.clear();
    this.#scheduleReconcile();
  }

  #scheduleReconcile(): void {
    if (this.#transition !== undefined) {
      return;
    }

    const transition = Promise.resolve().then(() => this.#reconcile());
    this.#transition = transition;
    const settle = (): void => {
      if (this.#transition !== transition) {
        return;
      }

      this.#transition = undefined;

      if (this.#reconciledVersion !== this.#requestVersion) {
        this.#scheduleReconcile();
      }
    };
    void transition.then(settle, () => {
      this.#failRuntime(NOTE_RUNTIME_ERROR);
      this.#reconciledVersion = this.#requestVersion;
      settle();
    });
  }

  async #reconcile(): Promise<void> {
    while (true) {
      const version = this.#requestVersion;
      const desired = this.#desired;
      const owner = this.#owner;

      if (this.#failure !== undefined) {
        this.#publishRuntimeError(this.#failure.message);
        this.#markReconciled(version);

        return;
      }

      if (desired === undefined) {
        if (owner !== undefined && !(await this.#stopOwner(owner))) {
          this.#markReconciled(version);

          return;
        }

        this.#publish(undefined);
        if (this.#markReconciled(version)) {
          return;
        }

        continue;
      }

      const context = draftContext(desired);

      if (owner !== undefined) {
        if (owner.pageKey !== desired.identity.pageKey) {
          if (!(await this.#stopOwner(owner))) {
            this.#markReconciled(version);

            return;
          }

          continue;
        }

        if (owner.phase === 'starting') {
          if (!(await this.#settleStartingOwner(owner))) {
            this.#markReconciled(version);

            return;
          }

          continue;
        }

        if (owner.invalid) {
          if (!(await this.#stopOwner(owner))) {
            this.#markReconciled(version);

            return;
          }

          continue;
        }

        if (!haveSameDraftContext(owner.context, context)) {
          try {
            owner.runtime.updatePageContext(context);
            owner.context = context;
            owner.needsRepublish = true;
          } catch {
            owner.acceptingEmissions = false;
            owner.needsRepublish = true;
            this.#failRuntime(NOTE_RUNTIME_ERROR);
            this.#markReconciled(version);

            return;
          }
        }

        if (owner.needsRepublish && !this.#publishOwnerState(owner)) {
          this.#markReconciled(version);

          return;
        }

        if (this.#markReconciled(version)) {
          return;
        }

        continue;
      }

      this.#publish(undefined);
      if (!this.#createOwner(desired, context)) {
        return;
      }
    }
  }

  #createOwner(
    desired: SupportedActivePageSessionState,
    context: PageNoteDraftPageContext,
  ): boolean {
    let runtime: PageNoteDraftRuntime | undefined;

    try {
      runtime = this.#createDraftRuntime(context, (state) => {
        const activeOwner = this.#owner;

        if (
          runtime === undefined ||
          activeOwner?.runtime !== runtime ||
          !activeOwner.acceptingEmissions
        ) {
          return;
        }

        activeOwner.needsRepublish = false;
        this.#publish({
          pageKey: activeOwner.pageKey,
          status: 'state',
          state,
          runtime,
        });
      });
    } catch {
      this.#failRuntime(NOTE_RUNTIME_ERROR);
      this.#reconciledVersion = this.#requestVersion;

      return false;
    }

    const startOutcome = Promise.resolve()
      .then(() => runtime.start())
      .then<StartOutcome, StartOutcome>(
        () => ({ status: 'fulfilled' }),
        (error: unknown) => ({ status: 'rejected', error }),
      );
    const owner: DraftOwner = {
      pageKey: desired.identity.pageKey,
      runtime,
      startOutcome,
      context,
      acceptingEmissions: true,
      invalid: false,
      needsRepublish: true,
      phase: 'starting',
    };
    this.#owner = owner;

    try {
      const unregister = this.#registerPendingSave(() =>
        runtime.flushPendingSave(),
      );

      if (typeof unregister !== 'function') {
        throw new Error(
          'The pending-save registry did not return an unregister function.',
        );
      }

      owner.unregister = unregister;
    } catch {
      owner.invalid = true;
    }

    return true;
  }

  async #settleStartingOwner(owner: DraftOwner): Promise<boolean> {
    while (this.#owner === owner && owner.phase === 'starting') {
      if (owner.invalid) {
        const stopped = await this.#stopOwner(owner);

        if (stopped) {
          this.#failRuntime(NOTE_RUNTIME_ERROR);
        }

        return false;
      }

      const waiter = this.#waitForRequest();
      const result = await Promise.race([
        owner.startOutcome,
        waiter.promise.then(() => ({ status: 'request-changed' }) as const),
      ]);
      waiter.cancel();

      if (result.status === 'request-changed') {
        const desired = this.#desired;

        if (
          desired === undefined ||
          desired.identity.pageKey !== owner.pageKey
        ) {
          return this.#stopOwner(owner);
        }

        const context = draftContext(desired);

        if (!haveSameDraftContext(owner.context, context)) {
          try {
            owner.runtime.updatePageContext(context);
            owner.context = context;
          } catch {
            owner.acceptingEmissions = false;
            owner.needsRepublish = true;
            this.#failRuntime(NOTE_RUNTIME_ERROR);
            this.#markReconciled(this.#requestVersion);

            return false;
          }
        }

        continue;
      }

      if (result.status === 'rejected') {
        const stopped = await this.#stopOwner(owner);

        if (stopped) {
          this.#failRuntime(NOTE_RUNTIME_ERROR);
        }

        return false;
      }

      owner.phase = 'started';
      owner.needsRepublish = true;

      return true;
    }

    return true;
  }

  async #stopOwner(owner: DraftOwner): Promise<boolean> {
    owner.acceptingEmissions = false;
    owner.invalid = true;

    try {
      await owner.runtime.stop();
    } catch {
      this.#failCleanup(NOTE_STOP_ERROR);

      return false;
    }

    try {
      owner.unregister?.();
    } catch {
      this.#failCleanup(NOTE_RUNTIME_ERROR);

      return false;
    }

    if (this.#owner === owner) {
      this.#owner = undefined;
    }

    return true;
  }

  #publishOwnerState(owner: DraftOwner): boolean {
    try {
      this.#publish({
        pageKey: owner.pageKey,
        status: 'state',
        state: owner.runtime.getState(),
        runtime: owner.runtime,
      });
      owner.acceptingEmissions = true;
      owner.needsRepublish = false;

      return true;
    } catch {
      owner.acceptingEmissions = false;
      owner.needsRepublish = true;
      this.#failRuntime(NOTE_RUNTIME_ERROR);

      return false;
    }
  }

  #publishRuntimeError(message: string): void {
    const pageKey = this.#desired?.identity.pageKey ?? this.#owner?.pageKey;

    if (pageKey !== undefined) {
      this.#publish({
        pageKey,
        status: 'runtime-error',
        message,
      });
    }
  }

  #failRuntime(message: string): void {
    this.#recordFailure(message, 'runtime');
  }

  #failCleanup(message: string): void {
    this.#recordFailure(message, 'cleanup');
  }

  #recordFailure(
    message: string,
    provenance: OwnershipFailure['provenance'],
  ): void {
    this.#failure = {
      message,
      pageKey: this.#desired?.identity.pageKey ?? this.#owner?.pageKey,
      provenance,
    };
    this.#publishRuntimeError(message);
  }

  #clearRuntimeFailureFor(
    session: SupportedActivePageSessionState | undefined,
  ): void {
    const failure = this.#failure;

    if (
      failure?.provenance === 'runtime' &&
      (session === undefined || session.identity.pageKey !== failure.pageKey)
    ) {
      this.#failure = undefined;
    }
  }

  #publish(view: PageNoteOwnershipView | undefined): void {
    this.#view = view;
    this.#emitCurrentView();
  }

  #emitCurrentView(): void {
    try {
      this.#emitView?.(this.#view);
    } catch {
      // React presentation cannot interrupt durable ownership bookkeeping.
    }
  }

  #markReconciled(version: number): boolean {
    this.#reconciledVersion = version;

    return version === this.#requestVersion;
  }

  #waitForRequest(): {
    readonly promise: Promise<void>;
    readonly cancel: () => void;
  } {
    let waiter!: RequestWaiter;
    const promise = new Promise<void>((resolve) => {
      waiter = { resolve };
      this.#requestWaiters.add(waiter);
    });

    return {
      promise,
      cancel: () => {
        this.#requestWaiters.delete(waiter);
      },
    };
  }
}
