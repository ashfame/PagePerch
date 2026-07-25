import type {
  NoteMutationResult,
  NotePageInput,
  NoteService,
  SavePageDraftInput,
} from '../domain/note';
import type { PageIdentity } from '../domain/pageIdentity';
import type { EditorMode } from '../domain/settings';
import type { SettingsRepository } from '../repositories/settingsRepository';
import { normalizeGutenbergContent } from '../services/note';

export const PAGE_NOTE_SAVE_DEBOUNCE_MS = 750 as const;

type PageNoteService = Pick<
  NoteService,
  'clearPage' | 'loadLive' | 'saveDraft'
>;
type PageNoteSettings = Pick<SettingsRepository, 'get'>;

export interface PageNoteDraftPageContext {
  readonly identity: PageIdentity;
  readonly representativeUrl: string;
  readonly activeTabTitle: string;
}

export interface PageNoteDraftScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface PageNoteDraftError {
  readonly message: string;
  readonly detail?: string;
}

export interface LoadingPageNoteDraftState {
  readonly status: 'loading';
}

export interface LoadErrorPageNoteDraftState {
  readonly status: 'load-error';
  readonly error: PageNoteDraftError;
}

export type PageNoteSaveState =
  | Readonly<{ phase: 'idle' }>
  | Readonly<{ phase: 'saving' }>
  | Readonly<{ phase: 'saved-locally' }>
  | Readonly<{ phase: 'save-error'; error: PageNoteDraftError }>;

export interface ReadyPageNoteDraftState {
  readonly status: 'ready';
  readonly initialContentHtml: string;
  readonly editorMode: EditorMode;
  readonly save: PageNoteSaveState;
}

export type PageNoteDraftState =
  | LoadingPageNoteDraftState
  | LoadErrorPageNoteDraftState
  | ReadyPageNoteDraftState;

export interface PageNoteDraftControllerDependencies {
  readonly noteService: PageNoteService;
  readonly settingsRepository: PageNoteSettings;
  readonly pageContext: PageNoteDraftPageContext;
  readonly emitState: (state: PageNoteDraftState) => void;
  readonly scheduler?: PageNoteDraftScheduler;
}

export class PageNoteDraftPageKeyError extends Error {
  constructor() {
    super(
      'A page note draft controller cannot change to a different page key.',
    );
    this.name = 'PageNoteDraftPageKeyError';
  }
}

interface PersistenceSnapshot {
  readonly revision: number;
  readonly contentHtml: string;
  readonly pageContext: PageNoteDraftPageContext;
}

type PersistenceOutcome =
  | Readonly<{
      status: 'fulfilled';
      revision: number;
      result: NoteMutationResult;
    }>
  | Readonly<{ status: 'rejected'; revision: number; error: unknown }>;

interface ActivePersistence {
  readonly owner: object;
  readonly promise: Promise<PersistenceOutcome>;
}

function clonePageIdentity(identity: PageIdentity): PageIdentity {
  return { ...identity };
}

function clonePageContext(
  context: PageNoteDraftPageContext,
): PageNoteDraftPageContext {
  return {
    identity: clonePageIdentity(context.identity),
    representativeUrl: context.representativeUrl,
    activeTabTitle: context.activeTabTitle,
  };
}

function haveSamePageContext(
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

function toPageNoteDraftError(
  operation: 'load' | 'save',
  error: unknown,
): PageNoteDraftError {
  const message =
    operation === 'load'
      ? 'PagePerch could not load this note from local storage. Retry.'
      : 'PagePerch could not save this note locally. Retry.';
  const detail =
    error instanceof Error && error.message.trim() !== ''
      ? error.message
      : undefined;

  return Object.freeze({
    message,
    ...(detail === undefined ? {} : { detail }),
  });
}

function toError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error('PagePerch could not complete the local note operation.');
}

function freezeSaveState(state: PageNoteSaveState): PageNoteSaveState {
  return Object.freeze(state);
}

function isEditorMode(value: unknown): value is EditorMode {
  return value === 'text-focused-blocks' || value === 'paragraphs-only';
}

function freezeState(state: PageNoteDraftState): PageNoteDraftState {
  if (state.status === 'ready') {
    return Object.freeze({
      ...state,
      save: freezeSaveState(state.save),
    });
  }

  return Object.freeze(state);
}

const browserScheduler: PageNoteDraftScheduler = {
  setTimeout(callback, delayMs) {
    return globalThis.setTimeout(callback, delayMs);
  },
  clearTimeout(handle) {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
  },
};

export class PageNoteDraftController {
  readonly #noteService: PageNoteService;
  readonly #settingsRepository: PageNoteSettings;
  readonly #emitState: (state: PageNoteDraftState) => void;
  readonly #scheduler: PageNoteDraftScheduler;
  #pageContext: PageNoteDraftPageContext;
  #state: PageNoteDraftState = freezeState({ status: 'loading' });
  #lifecycle: 'new' | 'started' | 'stopping' | 'stopped' = 'new';
  #loadGeneration = 0;
  #loadPromise: Promise<void> | undefined;
  #readyState:
    | Readonly<{
        initialContentHtml: string;
        editorMode: EditorMode;
      }>
    | undefined;
  #latestContentHtml = '';
  #revision = 0;
  #handledRevision = 0;
  #eligibleRevision = 0;
  #timer: unknown;
  #hasTimer = false;
  #activePersistence: ActivePersistence | undefined;
  #backgroundDrain: Promise<void> | undefined;
  #flushPromise: Promise<void> | undefined;
  #stopPromise: Promise<void> | undefined;

  constructor({
    noteService,
    settingsRepository,
    pageContext,
    emitState,
    scheduler = browserScheduler,
  }: PageNoteDraftControllerDependencies) {
    this.#noteService = noteService;
    this.#settingsRepository = settingsRepository;
    this.#pageContext = clonePageContext(pageContext);
    this.#emitState = emitState;
    this.#scheduler = scheduler;
  }

  getState(): PageNoteDraftState {
    return this.#state;
  }

  start(): Promise<void> {
    if (this.#lifecycle === 'stopping' || this.#lifecycle === 'stopped') {
      return this.#stopPromise ?? Promise.resolve();
    }

    if (this.#readyState !== undefined) {
      return Promise.resolve();
    }

    this.#lifecycle = 'started';

    return this.#load();
  }

  retry(): Promise<void> {
    if (this.#lifecycle !== 'started') {
      return Promise.resolve();
    }

    if (
      this.#loadPromise !== undefined ||
      this.#state.status === 'load-error'
    ) {
      return this.#load();
    }

    if (
      this.#state.status === 'ready' &&
      this.#state.save.phase === 'save-error'
    ) {
      return this.flushPendingSave();
    }

    return Promise.resolve();
  }

  contentChanged(contentHtml: string): void {
    if (
      this.#lifecycle !== 'started' ||
      this.#readyState === undefined ||
      typeof contentHtml !== 'string' ||
      contentHtml === this.#latestContentHtml
    ) {
      return;
    }

    this.#latestContentHtml = contentHtml;
    this.#revision += 1;
    this.#publishReady({ phase: 'saving' });

    if (this.#flushPromise === undefined) {
      this.#scheduleLatest();
    }
  }

  updatePageContext(pageContext: PageNoteDraftPageContext): void {
    if (this.#lifecycle !== 'started') {
      return;
    }

    if (pageContext.identity.pageKey !== this.#pageContext.identity.pageKey) {
      throw new PageNoteDraftPageKeyError();
    }

    const nextContext = clonePageContext(pageContext);
    const changed = !haveSamePageContext(this.#pageContext, nextContext);
    this.#pageContext = nextContext;

    if (!changed || this.#revision <= this.#handledRevision) {
      return;
    }

    this.#revision += 1;
    this.#publishReady({ phase: 'saving' });

    if (this.#flushPromise === undefined) {
      this.#scheduleLatest();
    }
  }

  flushPendingSave(): Promise<void> {
    if (
      this.#readyState === undefined ||
      this.#revision <= this.#handledRevision
    ) {
      return Promise.resolve();
    }

    if (this.#flushPromise !== undefined) {
      return this.#flushPromise;
    }

    this.#cancelTimer();
    const flush = Promise.resolve().then(() => this.#flushUntilCurrent());
    this.#flushPromise = flush;
    const settleFlush = (): void => {
      if (this.#flushPromise !== flush) {
        return;
      }

      this.#flushPromise = undefined;

      if (this.#revision <= this.#handledRevision) {
        this.#cancelTimer();
      } else if (
        this.#lifecycle === 'started' &&
        this.#revision > this.#handledRevision &&
        this.#state.status === 'ready' &&
        this.#state.save.phase === 'saving' &&
        !this.#hasTimer
      ) {
        this.#scheduleLatest();
      }
    };
    void flush.then(settleFlush, settleFlush);

    return flush;
  }

  /**
   * Blocks new ownership immediately and drains every accepted draft revision.
   * Callers must await this promise before mounting a replacement controller.
   */
  stop(): Promise<void> {
    if (this.#lifecycle === 'stopped') {
      return this.#stopPromise ?? Promise.resolve();
    }

    if (this.#stopPromise !== undefined) {
      return this.#stopPromise;
    }

    this.#lifecycle = 'stopping';
    this.#loadGeneration += 1;
    this.#cancelTimer();
    const stop = Promise.resolve()
      .then(async () => {
        if (
          this.#readyState !== undefined &&
          this.#revision > this.#handledRevision
        ) {
          await this.flushPendingSave();
        }

        this.#lifecycle = 'stopped';
      })
      .catch((error: unknown) => {
        throw error;
      });
    this.#stopPromise = stop;
    void stop.then(
      () => undefined,
      () => {
        if (this.#stopPromise === stop) {
          this.#stopPromise = undefined;
        }
      },
    );

    return stop;
  }

  #load(): Promise<void> {
    if (this.#loadPromise !== undefined) {
      return this.#loadPromise;
    }

    const generation = ++this.#loadGeneration;
    this.#publish(freezeState({ status: 'loading' }));

    let notePromise: ReturnType<PageNoteService['loadLive']>;
    let settingsPromise: ReturnType<PageNoteSettings['get']>;

    try {
      notePromise = Promise.resolve(
        this.#noteService.loadLive(this.#pageContext.identity.pageKey),
      );
    } catch (error) {
      notePromise = Promise.reject(toError(error));
    }

    try {
      settingsPromise = Promise.resolve(this.#settingsRepository.get());
    } catch (error) {
      settingsPromise = Promise.reject(toError(error));
    }

    const load = Promise.all([notePromise, settingsPromise])
      .then(([note, settings]) => {
        if (!this.#isCurrentLoad(generation)) {
          return;
        }

        if (!isEditorMode(settings.editorMode)) {
          throw new Error('Local settings contain an unsupported editor mode.');
        }

        const initialContentHtml =
          note === undefined || note.deletedAt !== undefined
            ? ''
            : note.contentHtml;
        this.#readyState = Object.freeze({
          initialContentHtml,
          editorMode: settings.editorMode,
        });
        this.#latestContentHtml = initialContentHtml;
        this.#publishReady({ phase: 'idle' });
      })
      .catch((error: unknown) => {
        if (this.#isCurrentLoad(generation)) {
          this.#publish(
            freezeState({
              status: 'load-error',
              error: toPageNoteDraftError('load', error),
            }),
          );
        }
      })
      .finally(() => {
        if (this.#loadPromise === load) {
          this.#loadPromise = undefined;
        }
      });

    this.#loadPromise = load;

    return load;
  }

  #isCurrentLoad(generation: number): boolean {
    return this.#lifecycle === 'started' && generation === this.#loadGeneration;
  }

  #scheduleLatest(): void {
    if (this.#lifecycle !== 'started') {
      return;
    }

    this.#cancelTimer();
    this.#timer = this.#scheduler.setTimeout(() => {
      this.#hasTimer = false;
      this.#timer = undefined;
      this.#eligibleRevision = this.#revision;
      this.#startBackgroundDrain();
    }, PAGE_NOTE_SAVE_DEBOUNCE_MS);
    this.#hasTimer = true;
  }

  #cancelTimer(): void {
    if (!this.#hasTimer) {
      return;
    }

    this.#scheduler.clearTimeout(this.#timer);
    this.#hasTimer = false;
    this.#timer = undefined;
  }

  #startBackgroundDrain(): void {
    if (this.#backgroundDrain !== undefined) {
      return;
    }

    const drain = this.#drainEligible();
    this.#backgroundDrain = drain;
    void drain.then(
      () => {
        if (this.#backgroundDrain === drain) {
          this.#backgroundDrain = undefined;
        }
      },
      () => {
        if (this.#backgroundDrain === drain) {
          this.#backgroundDrain = undefined;
        }
      },
    );
  }

  async #drainEligible(): Promise<void> {
    while (
      this.#revision > this.#handledRevision &&
      this.#eligibleRevision >= this.#revision
    ) {
      const outcome = await this.#getOrStartPersistence();

      if (
        outcome.status === 'rejected' &&
        outcome.revision === this.#revision
      ) {
        return;
      }
    }
  }

  async #flushUntilCurrent(): Promise<void> {
    while (this.#revision > this.#handledRevision) {
      this.#eligibleRevision = this.#revision;
      const outcome = await this.#getOrStartPersistence();

      if (
        outcome.status === 'rejected' &&
        outcome.revision === this.#revision
      ) {
        throw outcome.error;
      }
    }
  }

  #getOrStartPersistence(): Promise<PersistenceOutcome> {
    if (this.#activePersistence !== undefined) {
      return this.#activePersistence.promise;
    }

    const snapshot: PersistenceSnapshot = {
      revision: this.#revision,
      contentHtml: this.#latestContentHtml,
      pageContext: clonePageContext(this.#pageContext),
    };
    const owner = {};
    const applied = (async (): Promise<PersistenceOutcome> => {
      try {
        const outcome = await this.#persist(snapshot);
        this.#applyOutcome(outcome);

        return outcome;
      } finally {
        if (this.#activePersistence?.owner === owner) {
          this.#activePersistence = undefined;
        }
      }
    })();
    this.#activePersistence = { owner, promise: applied };

    return applied;
  }

  async #persist(snapshot: PersistenceSnapshot): Promise<PersistenceOutcome> {
    try {
      const pageInput: NotePageInput = {
        identity: clonePageIdentity(snapshot.pageContext.identity),
        representativeUrl: snapshot.pageContext.representativeUrl,
        activeTabTitle: snapshot.pageContext.activeTabTitle,
      };
      let result: NoteMutationResult;

      if (normalizeGutenbergContent(snapshot.contentHtml) === '') {
        result = await this.#noteService.clearPage(pageInput);
      } else {
        const draftInput: SavePageDraftInput = {
          ...pageInput,
          contentHtml: snapshot.contentHtml,
        };
        result = await this.#noteService.saveDraft(draftInput);
      }

      return Object.freeze({
        status: 'fulfilled',
        revision: snapshot.revision,
        result,
      });
    } catch (error) {
      return Object.freeze({
        status: 'rejected',
        revision: snapshot.revision,
        error,
      });
    }
  }

  #applyOutcome(outcome: PersistenceOutcome): void {
    if (outcome.status === 'fulfilled') {
      this.#handledRevision = Math.max(this.#handledRevision, outcome.revision);

      if (outcome.revision === this.#revision) {
        this.#publishReady({ phase: 'saved-locally' });
      }

      return;
    }

    if (outcome.revision === this.#revision) {
      this.#publishReady({
        phase: 'save-error',
        error: toPageNoteDraftError('save', outcome.error),
      });
    }
  }

  #createReadyState(save: PageNoteSaveState): ReadyPageNoteDraftState {
    if (this.#readyState === undefined) {
      throw new Error('The page note draft is not ready.');
    }

    return freezeState({
      status: 'ready',
      initialContentHtml: this.#readyState.initialContentHtml,
      editorMode: this.#readyState.editorMode,
      save,
    }) as ReadyPageNoteDraftState;
  }

  #publishReady(save: PageNoteSaveState): void {
    if (this.#readyState !== undefined) {
      this.#publish(this.#createReadyState(save));
    }
  }

  #publish(state: PageNoteDraftState): void {
    if (this.#lifecycle === 'started') {
      this.#state = state;

      try {
        this.#emitState(state);
      } catch {
        // Presentation failures cannot interrupt local persistence bookkeeping.
      }
    }
  }
}

export type PendingPageSaveHandler = () => Promise<void>;

interface PendingPageSaveRegistration {
  readonly id: number;
  readonly handler: PendingPageSaveHandler;
}

export class PendingPageSaveCoordinator {
  #nextRegistrationId = 0;
  #registrationGeneration = 0;
  #current: PendingPageSaveRegistration | undefined;
  #flushPromise: Promise<void> | undefined;

  register(handler: PendingPageSaveHandler): () => void {
    const registration: PendingPageSaveRegistration = {
      id: ++this.#nextRegistrationId,
      handler,
    };
    this.#registrationGeneration += 1;
    this.#current = registration;

    return () => {
      if (this.#current?.id === registration.id) {
        this.#current = undefined;
        this.#registrationGeneration += 1;
      }
    };
  }

  flushPendingSave(): Promise<void> {
    if (this.#flushPromise !== undefined) {
      return this.#flushPromise;
    }

    const flush = Promise.resolve().then(() => this.#flushRegistrations());
    this.#flushPromise = flush;
    void flush.then(
      () => {
        if (this.#flushPromise === flush) {
          this.#flushPromise = undefined;
        }
      },
      () => {
        if (this.#flushPromise === flush) {
          this.#flushPromise = undefined;
        }
      },
    );

    return flush;
  }

  async #flushRegistrations(): Promise<void> {
    let lastFlushedRegistrationId: number | undefined;

    while (true) {
      const registration = this.#current;

      if (
        registration === undefined ||
        registration.id === lastFlushedRegistrationId
      ) {
        const settledGeneration = this.#registrationGeneration;
        await Promise.resolve();

        if (settledGeneration === this.#registrationGeneration) {
          return;
        }

        continue;
      }

      lastFlushedRegistrationId = registration.id;
      await registration.handler();
    }
  }
}
