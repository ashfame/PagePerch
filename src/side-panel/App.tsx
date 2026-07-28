import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
} from 'react';

import '../styles/base.css';
import type { SettingsRepository } from '../repositories/settingsRepository';
import type { CanonicalPageOpener } from './chromeCanonicalPageOpener';
import type { PageNoteEditorProps } from './PageNoteEditor';
import type {
  ActivePageSessionController,
  ActivePageSessionState,
  SupportedActivePageSessionState,
  UnsupportedActivePageSessionState,
} from './activePageSession';
import type {
  PageNoteOwnership,
  PageNoteOwnershipConnection,
  PageNoteOwnershipView,
} from './pageNoteOwnership';
import type {
  RootRecentNoteEntry,
  RootRecentNotesConnection,
  RootRecentNotesIndex,
  RootRecentNotesState,
} from './rootRecentNotes';
import type {
  PageSyncVisibility,
  PageSyncVisibilityConnection,
  PageSyncVisibilityState,
} from '../sync/syncVisibility';

export type {
  CreatePageNoteDraftRuntime,
  PageNoteDraftRuntime,
  RegisterPendingPageSave,
} from './pageNoteOwnership';

type SessionController = Pick<ActivePageSessionController, 'start' | 'stop'>;

export type CreateActivePageSessionController = (
  emitState: (state: ActivePageSessionState) => void,
) => SessionController;

export interface SidePanelAppProps {
  readonly createController: CreateActivePageSessionController;
  readonly draftOwnership: PageNoteOwnership;
  readonly Editor: ComponentType<PageNoteEditorProps>;
  readonly openSettings: () => void | Promise<void>;
  readonly pageOpener: CanonicalPageOpener;
  readonly pageSyncVisibility?: PageSyncVisibility;
  readonly recentNotesIndex: RootRecentNotesIndex;
  readonly settings: Pick<SettingsRepository, 'get'>;
}

interface SessionView {
  readonly current: ActivePageSessionState;
  readonly lastSupported?: SupportedActivePageSessionState;
}

interface SessionRuntime {
  readonly factory: CreateActivePageSessionController;
  acceptingEmissions: boolean;
  controller?: SessionController;
  startCleanup?: () => void;
  stopped: boolean;
  cleanupVersion: number;
}

interface SessionLifecycle {
  runtime?: SessionRuntime;
}

const SESSION_STARTUP_ERROR: ActivePageSessionState = {
  status: 'error',
  reason: 'listener-registration-failed',
  message:
    'PagePerch could not start tracking the active page. Reopen the side panel to retry.',
};

function stopSessionRuntime(runtime: SessionRuntime): void {
  if (runtime.stopped) {
    return;
  }

  runtime.stopped = true;
  runtime.acceptingEmissions = false;
  const startCleanup = runtime.startCleanup;
  runtime.startCleanup = undefined;

  try {
    if (startCleanup === undefined) {
      runtime.controller?.stop();
    } else {
      startCleanup();
    }
  } catch {
    // Runtime cleanup remains idempotent even if a Chrome listener removal fails.
  }
}

function useActivePageSession(
  createController: CreateActivePageSessionController,
): SessionView {
  const [view, setView] = useState<SessionView>({
    current: { status: 'loading' },
  });
  const lifecycleRef = useRef<SessionLifecycle>({});
  const publishStateRef = useRef((state: ActivePageSessionState) => {
    setView((previous) => ({
      current: state,
      ...(state.status === 'supported'
        ? { lastSupported: state }
        : previous.lastSupported === undefined
          ? {}
          : { lastSupported: previous.lastSupported }),
    }));
  });
  const resetStateRef = useRef((state: ActivePageSessionState) => {
    setView({ current: state });
  });

  useEffect(() => {
    const lifecycle = lifecycleRef.current;
    const previousRuntime = lifecycle.runtime;

    if (
      previousRuntime !== undefined &&
      previousRuntime.factory !== createController
    ) {
      stopSessionRuntime(previousRuntime);
      lifecycle.runtime = undefined;
      resetStateRef.current({ status: 'loading' });
    }

    let runtime = lifecycle.runtime;

    if (runtime === undefined) {
      runtime = {
        factory: createController,
        acceptingEmissions: true,
        stopped: false,
        cleanupVersion: 0,
      };
      lifecycle.runtime = runtime;
      const createdRuntime = runtime;

      try {
        createdRuntime.controller = createController((state) => {
          if (!createdRuntime.acceptingEmissions || createdRuntime.stopped) {
            return;
          }

          publishStateRef.current(state);
        });

        try {
          createdRuntime.startCleanup = createdRuntime.controller.start();
        } catch {
          stopSessionRuntime(createdRuntime);
          resetStateRef.current(SESSION_STARTUP_ERROR);
        }
      } catch {
        createdRuntime.stopped = true;
        createdRuntime.acceptingEmissions = false;
        resetStateRef.current(SESSION_STARTUP_ERROR);
      }
    } else {
      runtime.acceptingEmissions = true;
      runtime.cleanupVersion += 1;
    }

    return () => {
      runtime.acceptingEmissions = false;
      const cleanupVersion = runtime.cleanupVersion + 1;
      runtime.cleanupVersion = cleanupVersion;

      queueMicrotask(() => {
        if (
          runtime.cleanupVersion !== cleanupVersion ||
          runtime.acceptingEmissions
        ) {
          return;
        }

        stopSessionRuntime(runtime);

        if (lifecycle.runtime === runtime) {
          lifecycle.runtime = undefined;
        }
      });
    };
  }, [createController]);

  return view;
}

function unsupportedMessage(state: UnsupportedActivePageSessionState): string {
  switch (state.reason) {
    case 'no-active-tab':
      return 'No active browser tab is available in this window. Select a page and try again.';
    case 'missing-tab-id':
      return 'The active tab is missing the identifier PagePerch needs. Switch tabs or reopen the panel.';
    case 'missing-url':
      return 'The active tab did not provide a page address. Reload the page or switch tabs.';
    case 'invalid-url':
      return 'The active tab has an invalid page address. Reload the page or navigate to another site.';
    case 'unsupported-scheme':
      return `PagePerch notes are available on HTTP and HTTPS pages. The ${state.protocol ?? 'current'} page type is not supported.`;
  }
}

function canonicalContext(canonicalUrl: string): string {
  try {
    const url = new URL(canonicalUrl);

    return `${url.pathname}${url.search}`;
  } catch {
    return canonicalUrl;
  }
}

interface PageNoteDraftView {
  readonly view?: PageNoteOwnershipView;
  readonly retryOwnership: () => void;
}

interface LocalSaveSyncEvidencePort {
  beginLocalSave(): void;
  clearLocalSave(): void;
  completeLocalSave(): void;
}

const NOTE_RUNTIME_ERROR =
  'PagePerch could not prepare this local note. Retry.';
function usePageNoteDraft(
  session: SupportedActivePageSessionState | undefined,
  ownership: PageNoteOwnership,
  syncEvidence: LocalSaveSyncEvidencePort,
): PageNoteDraftView {
  const [view, setView] = useState<PageNoteOwnershipView>();
  const connectionRef = useRef<PageNoteOwnershipConnection>();
  const saveLifecycleRef = useRef<{
    pageKey: string | undefined;
    phase: 'idle' | 'saving' | 'saved-locally' | 'save-error' | undefined;
  }>({ pageKey: undefined, phase: undefined });

  useEffect(() => {
    const connection = ownership.connect((view) => {
      const savePhase =
        view?.status === 'state' && view.state.status === 'ready'
          ? view.state.save.phase
          : undefined;
      const previous = saveLifecycleRef.current;
      const samePage = view?.pageKey === previous.pageKey;

      if (
        savePhase === 'saving' &&
        (!samePage || previous.phase !== 'saving')
      ) {
        syncEvidence.beginLocalSave();
      } else if (
        savePhase === 'saved-locally' &&
        (!samePage ||
          (previous.phase !== 'saving' && previous.phase !== 'saved-locally'))
      ) {
        syncEvidence.beginLocalSave();
        syncEvidence.completeLocalSave();
      } else if (savePhase === 'saved-locally' && previous.phase === 'saving') {
        syncEvidence.completeLocalSave();
      } else if (savePhase !== 'saving' && savePhase !== 'saved-locally') {
        syncEvidence.clearLocalSave();
      }

      saveLifecycleRef.current = {
        pageKey: view?.pageKey,
        phase: savePhase,
      };
      setView(view);
    });
    connectionRef.current = connection;

    return () => {
      if (connectionRef.current === connection) {
        connectionRef.current = undefined;
      }

      connection.disconnect();
    };
  }, [ownership, syncEvidence]);

  useEffect(() => {
    connectionRef.current?.setSession(session);
  }, [ownership, session]);

  const retryOwnership = () => {
    connectionRef.current?.retry();
  };

  return {
    view,
    retryOwnership,
  };
}

interface RootRecentNotesView {
  readonly retry: () => void;
  readonly state: RootRecentNotesState | undefined;
}

function useRootRecentNotes(
  session: SupportedActivePageSessionState | undefined,
  index: RootRecentNotesIndex,
  enabled: boolean,
): RootRecentNotesView {
  const [state, setState] = useState<RootRecentNotesState>();
  const connectionRef = useRef<RootRecentNotesConnection>();

  useEffect(() => {
    if (!enabled) {
      connectionRef.current = undefined;
      return;
    }

    const connection = index.connect(setState);
    connectionRef.current = connection;

    return () => {
      if (connectionRef.current === connection) {
        connectionRef.current = undefined;
      }

      connection.disconnect();
    };
  }, [enabled, index]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    connectionRef.current?.setSession(session);
  }, [enabled, index, session]);

  return {
    retry: () => {
      connectionRef.current?.retry();
    },
    state,
  };
}

interface PageSyncVisibilityView {
  readonly evidence: LocalSaveSyncEvidencePort;
  readonly state: PageSyncVisibilityState | undefined;
  readonly trustRemoteClaim: boolean;
}

interface LocalSaveSyncEvidence {
  baselineHistoryKnown: boolean;
  baselineLastSuccessfulSyncAt: string | undefined;
  baselinePendingRevisionId: string | undefined;
  lastPendingRevisionId: string | undefined;
  observedPendingRevisionId: string | undefined;
  phase: 'inactive' | 'saved' | 'saving';
  trustRemoteClaim: boolean;
}

interface PageSyncVisibilityPresentation {
  readonly state: PageSyncVisibilityState | undefined;
  readonly trustRemoteClaim: boolean;
}

function pendingRevisionId(
  state: PageSyncVisibilityState | undefined,
): string | undefined {
  return state?.status === 'ready' ? state.pendingRevisionId : undefined;
}

function hasKnownRemoteHistory(
  state: PageSyncVisibilityState | undefined,
): boolean {
  return (
    state?.status === 'ready' &&
    state.mode !== 'unavailable' &&
    state.mode !== 'waiting-unavailable'
  );
}

function hasNewerSuccessfulSync(
  evidence: LocalSaveSyncEvidence,
  state: PageSyncVisibilityState,
): boolean {
  if (
    state.status !== 'ready' ||
    !evidence.baselineHistoryKnown ||
    state.lastSuccessfulSyncAt === undefined
  ) {
    return false;
  }

  if (evidence.baselineLastSuccessfulSyncAt === undefined) {
    return true;
  }

  const baseline = new Date(evidence.baselineLastSuccessfulSyncAt).valueOf();
  const current = new Date(state.lastSuccessfulSyncAt).valueOf();

  return (
    Number.isFinite(baseline) && Number.isFinite(current) && current > baseline
  );
}

function observeSyncEvidence(
  evidence: LocalSaveSyncEvidence,
  state: PageSyncVisibilityState | undefined,
): void {
  if (
    evidence.phase === 'inactive' ||
    state === undefined ||
    state.status !== 'ready'
  ) {
    return;
  }

  const pendingRevision = state.pendingRevisionId;

  if (pendingRevision !== undefined) {
    if (pendingRevision !== evidence.baselinePendingRevisionId) {
      evidence.observedPendingRevisionId = pendingRevision;
    }

    evidence.lastPendingRevisionId = pendingRevision;
    evidence.trustRemoteClaim = false;
    return;
  }

  if (
    evidence.observedPendingRevisionId !== undefined &&
    evidence.lastPendingRevisionId === evidence.observedPendingRevisionId
  ) {
    evidence.trustRemoteClaim = true;
  }

  if (hasNewerSuccessfulSync(evidence, state)) {
    evidence.trustRemoteClaim = true;
  }

  evidence.lastPendingRevisionId = undefined;
}

function usePageSyncVisibility(
  session: SupportedActivePageSessionState | undefined,
  visibility: PageSyncVisibility | undefined,
): PageSyncVisibilityView {
  const [presentation, setPresentation] =
    useState<PageSyncVisibilityPresentation>({
      state: undefined,
      trustRemoteClaim: true,
    });
  const stateRef = useRef<PageSyncVisibilityState>();
  const evidenceRef = useRef<LocalSaveSyncEvidence>({
    baselineHistoryKnown: false,
    baselineLastSuccessfulSyncAt: undefined,
    baselinePendingRevisionId: undefined,
    lastPendingRevisionId: undefined,
    observedPendingRevisionId: undefined,
    phase: 'inactive',
    trustRemoteClaim: true,
  });
  const connectionRef = useRef<PageSyncVisibilityConnection>();
  const beginLocalSave = useCallback(() => {
    const current = stateRef.current;
    const currentPendingRevision = pendingRevisionId(current);
    evidenceRef.current = {
      baselineHistoryKnown: hasKnownRemoteHistory(current),
      baselineLastSuccessfulSyncAt:
        current?.status === 'ready' ? current.lastSuccessfulSyncAt : undefined,
      baselinePendingRevisionId: currentPendingRevision,
      lastPendingRevisionId: currentPendingRevision,
      observedPendingRevisionId: undefined,
      phase: 'saving',
      trustRemoteClaim: false,
    };
    setPresentation((previous) => ({
      ...previous,
      trustRemoteClaim: false,
    }));
  }, []);
  const clearLocalSave = useCallback(() => {
    evidenceRef.current.phase = 'inactive';
    evidenceRef.current.trustRemoteClaim = true;
    setPresentation((previous) => ({
      ...previous,
      trustRemoteClaim: true,
    }));
  }, []);
  const completeLocalSave = useCallback(() => {
    if (evidenceRef.current.phase !== 'saving') {
      return;
    }

    evidenceRef.current.phase = 'saved';
    const trustRemoteClaim = evidenceRef.current.trustRemoteClaim;
    setPresentation((previous) => ({
      ...previous,
      trustRemoteClaim,
    }));
  }, []);
  const evidence = useMemo(
    () => ({
      beginLocalSave,
      clearLocalSave,
      completeLocalSave,
    }),
    [beginLocalSave, clearLocalSave, completeLocalSave],
  );

  useEffect(() => {
    if (visibility === undefined) {
      connectionRef.current = undefined;
      return;
    }

    const connection = visibility.connect((nextState) => {
      const previousState = stateRef.current;

      if (previousState?.pageKey !== nextState?.pageKey) {
        evidenceRef.current.phase = 'inactive';
        evidenceRef.current.trustRemoteClaim = true;
      } else {
        observeSyncEvidence(evidenceRef.current, nextState);
      }

      stateRef.current = nextState;
      setPresentation({
        state: nextState,
        trustRemoteClaim: evidenceRef.current.trustRemoteClaim,
      });
    });
    connectionRef.current = connection;

    return () => {
      if (connectionRef.current === connection) {
        connectionRef.current = undefined;
      }

      connection.disconnect();
    };
  }, [visibility]);

  useEffect(() => {
    connectionRef.current?.setPage(session?.identity.pageKey);
  }, [session, visibility]);

  return {
    evidence,
    state: visibility === undefined ? undefined : presentation.state,
    trustRemoteClaim: presentation.trustRemoteClaim,
  };
}

function PageSyncStatus({
  locallySaved,
  pageKey,
  state,
  trustRemoteClaim,
}: {
  readonly locallySaved: boolean;
  readonly pageKey: string;
  readonly state: PageSyncVisibilityState | undefined;
  readonly trustRemoteClaim: boolean;
}) {
  const activeState = state?.pageKey === pageKey ? state : undefined;

  if (activeState === undefined || activeState.status === 'loading') {
    return locallySaved ? (
      <p className="status note-status" role="status" aria-live="polite">
        Saved locally
      </p>
    ) : null;
  }

  if (activeState.status === 'error') {
    return (
      <div className="sync-visibility-message">
        <p className="status note-status" role="status" aria-live="polite">
          {locallySaved
            ? 'Saved locally · BYOS sync status unavailable'
            : 'BYOS sync status unavailable'}
        </p>
        <p className="sync-status-detail">
          Editing and local saves remain available. Open settings to review
          BYOS.
        </p>
      </div>
    );
  }

  switch (activeState.mode) {
    case 'waiting':
      return (
        <p className="status note-status" role="status" aria-live="polite">
          Waiting to sync
        </p>
      );
    case 'waiting-reconnect':
      return (
        <div className="sync-visibility-message">
          <p className="status note-status" role="status" aria-live="polite">
            Waiting to sync
          </p>
          <p className="sync-status-detail">
            Reconnect BYOS in settings. Your note remains saved locally.
          </p>
        </div>
      );
    case 'waiting-unavailable':
      return (
        <div className="sync-visibility-message">
          <p className="status note-status" role="status" aria-live="polite">
            Waiting to sync
          </p>
          <p className="sync-status-detail">
            BYOS is unavailable in this build. Your note remains saved locally.
          </p>
        </div>
      );
    case 'synced':
      return (
        <p className="status note-status" role="status" aria-live="polite">
          {locallySaved && !trustRemoteClaim
            ? 'Saved locally'
            : 'Synced to BYOS'}
        </p>
      );
    case 'checking':
      return (
        <p className="status note-status" role="status" aria-live="polite">
          {locallySaved
            ? trustRemoteClaim
              ? 'Saved locally · Checking BYOS'
              : 'Saved locally'
            : 'Checking BYOS'}
        </p>
      );
    case 'local-only':
    case 'unavailable':
      return (
        <p className="status note-status" role="status" aria-live="polite">
          {locallySaved ? 'Saved locally' : 'Local only'}
        </p>
      );
    case 'reconnect-required':
      return (
        <div className="sync-visibility-message">
          <p className="status note-status" role="status" aria-live="polite">
            {locallySaved ? 'Saved locally · Reconnect BYOS' : 'Reconnect BYOS'}
          </p>
          <p className="sync-status-detail">
            Reconnect BYOS in settings. Local notes remain available.
          </p>
        </div>
      );
  }
}

function recentNoteTitle(entry: RootRecentNoteEntry): string {
  const title = entry.title.trim();

  return title === '' ? canonicalContext(entry.canonicalUrl) : title;
}

function savedTimeLabel(savedAt: string): string {
  const date = new Date(savedAt);

  if (Number.isNaN(date.valueOf())) {
    return savedAt;
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function RecentNotes({
  isRoot,
  pageKey,
  pageOpener,
  retry,
  state,
}: {
  readonly isRoot: boolean;
  readonly pageKey: string;
  readonly pageOpener: CanonicalPageOpener;
  readonly retry: () => void;
  readonly state: RootRecentNotesState | undefined;
}) {
  const activeState = state?.pageKey === pageKey ? state : undefined;
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterQuery, setFilterQuery] = useState('');
  const [openErrorPageKey, setOpenErrorPageKey] = useState<string>();
  const actionLifecycleRef = useRef({ attempt: 0, mounted: true });
  const filterButtonRef = useRef<HTMLButtonElement>(null);
  const filterInputRef = useRef<HTMLInputElement>(null);
  const filterMinimumHeightRef = useRef<number>();
  const sectionRef = useRef<HTMLElement>(null);
  const baseHeading = isRoot
    ? 'Recent notes on this origin'
    : 'Recent notes under this page';
  const emptyMessage = isRoot
    ? 'No other saved notes on this origin yet.'
    : 'No saved notes under this page yet.';
  const entries =
    activeState?.status === 'ready' ? activeState.entries : undefined;
  const normalizedFilter = filterQuery.toLocaleLowerCase();
  const visibleEntries =
    entries === undefined || normalizedFilter === ''
      ? entries
      : entries.filter((entry) => {
          const title = recentNoteTitle(entry).toLocaleLowerCase();
          const context = canonicalContext(
            entry.canonicalUrl,
          ).toLocaleLowerCase();

          return (
            title.includes(normalizedFilter) ||
            context.includes(normalizedFilter)
          );
        });
  const heading =
    visibleEntries === undefined
      ? baseHeading
      : `${baseHeading} (${visibleEntries.length})`;

  useEffect(() => {
    if (filterOpen) {
      filterInputRef.current?.focus();
    }
  }, [filterOpen]);

  useLayoutEffect(() => {
    const section = sectionRef.current;

    if (!filterOpen) {
      filterMinimumHeightRef.current = undefined;
      section?.style.removeProperty('min-height');
      return;
    }

    if (filterQuery !== '' || entries === undefined || section === null) {
      return;
    }

    const sectionHeight = section.getBoundingClientRect().height;
    const minimumHeight = Math.max(
      filterMinimumHeightRef.current ?? 0,
      sectionHeight,
    );
    filterMinimumHeightRef.current = minimumHeight;
    section.style.minHeight = `${String(minimumHeight)}px`;
  }, [entries, filterOpen, filterQuery]);

  useEffect(() => {
    const lifecycle = actionLifecycleRef.current;
    lifecycle.mounted = true;

    return () => {
      lifecycle.mounted = false;
      lifecycle.attempt += 1;
    };
  }, []);

  const openEntry = (entry: RootRecentNoteEntry) => {
    const lifecycle = actionLifecycleRef.current;
    const attempt = lifecycle.attempt + 1;
    lifecycle.attempt = attempt;
    setOpenErrorPageKey(undefined);
    const fail = () => {
      if (lifecycle.mounted && lifecycle.attempt === attempt) {
        setOpenErrorPageKey(entry.pageKey);
      }
    };

    try {
      void Promise.resolve(
        pageOpener.openCanonicalUrl(entry.canonicalUrl),
      ).then(() => {
        if (lifecycle.mounted && lifecycle.attempt === attempt) {
          setOpenErrorPageKey(undefined);
        }
      }, fail);
    } catch {
      fail();
    }
  };

  return (
    <section
      ref={sectionRef}
      className="surface recent-notes-surface"
      aria-labelledby="recent-notes-heading"
    >
      <div className="recent-notes-heading-row">
        <h2 id="recent-notes-heading">{heading}</h2>
        <button
          ref={filterButtonRef}
          type="button"
          className="recent-notes-filter-link"
          aria-controls="recent-notes-filter"
          aria-expanded={filterOpen}
          onClick={() => {
            setFilterOpen(true);
          }}
        >
          Filter
        </button>
      </div>
      {filterOpen ? (
        <label className="recent-notes-filter" htmlFor="recent-notes-filter">
          <span>Filter recent notes</span>
          <input
            ref={filterInputRef}
            id="recent-notes-filter"
            type="search"
            value={filterQuery}
            onChange={(event) => {
              setFilterQuery(event.currentTarget.value);
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') {
                return;
              }

              event.preventDefault();
              event.stopPropagation();

              if (filterQuery !== '') {
                setFilterQuery('');
                return;
              }

              setFilterOpen(false);
              filterButtonRef.current?.focus();
            }}
          />
        </label>
      ) : null}
      {activeState === undefined || activeState.status === 'loading' ? (
        <p className="status" role="status" aria-live="polite">
          Loading recent notes
        </p>
      ) : activeState.status === 'error' ? (
        <div className="note-action-panel">
          <p className="session-alert" role="alert">
            {isRoot
              ? 'PagePerch could not load recent notes from this origin. Retry.'
              : 'PagePerch could not load recent notes under this page. Retry.'}
          </p>
          <button type="button" onClick={retry}>
            Retry recent notes
          </button>
        </div>
      ) : (
        <>
          {activeState.refreshError ? (
            <div className="note-action-panel recent-notes-issue">
              <p className="session-alert" role="alert">
                PagePerch could not refresh recent notes. Previously loaded
                notes are still shown.
              </p>
              <button type="button" onClick={retry}>
                Retry recent notes
              </button>
            </div>
          ) : activeState.subscriptionError ? (
            <div className="note-action-panel recent-notes-issue">
              <p className="session-alert" role="alert">
                Recent notes cannot update automatically right now. Retry
                watching for local changes.
              </p>
              <button type="button" onClick={retry}>
                Retry recent notes
              </button>
            </div>
          ) : null}
          {activeState.refreshing ? (
            <p className="status recent-notes-refresh" role="status">
              Refreshing recent notes
            </p>
          ) : null}
          {activeState.entries.length === 0 ? (
            <p className="recent-notes-empty" role="status">
              {emptyMessage}
            </p>
          ) : visibleEntries?.length === 0 ? (
            <p className="recent-notes-empty" role="status">
              No recent notes match this filter.
            </p>
          ) : (
            <ul className="recent-notes-list">
              {visibleEntries?.map((entry) => {
                const title = recentNoteTitle(entry);

                return (
                  <li className="recent-note-item" key={entry.pageKey}>
                    <div className="recent-note-copy">
                      <h3>{title}</h3>
                      <code title={entry.canonicalUrl}>
                        {canonicalContext(entry.canonicalUrl)}
                      </code>
                      <p className="recent-note-saved">
                        Saved{' '}
                        <time dateTime={entry.savedAt}>
                          {savedTimeLabel(entry.savedAt)}
                        </time>
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        openEntry(entry);
                      }}
                    >
                      Open {title} in new tab
                    </button>
                    {openErrorPageKey === entry.pageKey ? (
                      <p
                        className="session-alert recent-note-open-error"
                        role="alert"
                      >
                        PagePerch could not open this saved page. Try again.
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function SupportedPageShell({
  session,
  draft,
  retryOwnership,
  syncVisibility,
  trustRemoteClaim,
  Editor,
}: {
  readonly session: SupportedActivePageSessionState;
  readonly draft?: PageNoteOwnershipView;
  readonly retryOwnership: () => void;
  readonly syncVisibility?: PageSyncVisibilityState;
  readonly trustRemoteClaim: boolean;
  readonly Editor: ComponentType<PageNoteEditorProps>;
}) {
  const [editorPhase, setEditorPhase] = useState<'loading' | 'ready' | 'error'>(
    'loading',
  );
  const [actionError, setActionError] = useState<string>();
  const actionLifecycleRef = useRef({ mounted: true, attempt: 0 });
  const activeDraft =
    draft?.pageKey === session.identity.pageKey ? draft : undefined;
  useEffect(() => {
    const actionLifecycle = actionLifecycleRef.current;
    actionLifecycle.mounted = true;

    return () => {
      actionLifecycle.mounted = false;
      actionLifecycle.attempt += 1;
    };
  }, []);
  const runAsyncAction = (
    action: () => void | Promise<void>,
    failureMessage: string,
  ) => {
    const actionLifecycle = actionLifecycleRef.current;
    const attempt = actionLifecycle.attempt + 1;
    actionLifecycle.attempt = attempt;
    setActionError(undefined);
    const fail = () => {
      if (actionLifecycle.mounted && actionLifecycle.attempt === attempt) {
        setActionError(failureMessage);
      }
    };

    try {
      void Promise.resolve(action()).catch(fail);
    } catch {
      fail();
    }
  };

  return (
    <div
      className="page-document-shell"
      aria-busy={
        activeDraft === undefined ||
        (activeDraft.status === 'state' &&
          activeDraft.state.status === 'loading')
      }
      data-page-key={session.identity.pageKey}
      data-testid="page-document-shell"
    >
      {activeDraft === undefined ? null : activeDraft.status ===
        'runtime-error' ? (
        <div className="note-action-panel">
          <p className="session-alert" role="alert">
            {activeDraft.message}
          </p>
          <button
            type="button"
            onClick={() => {
              try {
                retryOwnership();
              } catch {
                setActionError(NOTE_RUNTIME_ERROR);
              }
            }}
          >
            Retry local note
          </button>
        </div>
      ) : activeDraft.state.status === 'loading' ? null : activeDraft.state
          .status === 'load-error' ? (
        <div className="note-action-panel">
          <p className="session-alert" role="alert">
            {activeDraft.state.error.message}
          </p>
          <button
            type="button"
            onClick={() => {
              runAsyncAction(
                () => activeDraft.runtime.retry(),
                NOTE_RUNTIME_ERROR,
              );
            }}
          >
            Retry loading note
          </button>
        </div>
      ) : (
        <div className="note-editor-area">
          {editorPhase === 'error' ? (
            <p className="session-alert editor-alert" role="alert">
              PagePerch could not open the local note editor. Reload the panel
              to retry.
            </p>
          ) : null}
          <Editor
            key={session.identity.pageKey}
            initialContentHtml={activeDraft.state.initialContentHtml}
            editorMode={activeDraft.state.editorMode}
            onContentChange={(contentHtml) => {
              setActionError(undefined);

              try {
                activeDraft.runtime.contentChanged(contentHtml);
              } catch {
                setActionError(NOTE_RUNTIME_ERROR);
              }
            }}
            onLoading={() => {
              setEditorPhase('loading');
            }}
            onReady={() => {
              setEditorPhase('ready');
            }}
            onError={() => {
              setEditorPhase('error');
            }}
          />
          {activeDraft.state.save.phase === 'saving' ? (
            <p className="status note-status" role="status" aria-live="polite">
              Saving
            </p>
          ) : activeDraft.state.save.phase === 'save-error' ? (
            <div className="note-action-panel">
              <p className="session-alert" role="alert">
                {activeDraft.state.save.error.message}
              </p>
              <button
                type="button"
                onClick={() => {
                  runAsyncAction(
                    () => activeDraft.runtime.retry(),
                    NOTE_RUNTIME_ERROR,
                  );
                }}
              >
                Retry saving note
              </button>
            </div>
          ) : (
            <PageSyncStatus
              locallySaved={activeDraft.state.save.phase === 'saved-locally'}
              pageKey={session.identity.pageKey}
              state={syncVisibility}
              trustRemoteClaim={trustRemoteClaim}
            />
          )}
        </div>
      )}
      {actionError === undefined ? null : (
        <p className="session-alert note-action-error" role="alert">
          {actionError}
        </p>
      )}
    </div>
  );
}

function TransientSessionState({
  state,
}: {
  readonly state: Exclude<
    ActivePageSessionState,
    SupportedActivePageSessionState
  >;
}) {
  if (state.status === 'loading') {
    return (
      <section
        className="surface"
        aria-labelledby="page-session-loading-heading"
      >
        <h2 id="page-session-loading-heading">Finding the active page</h2>
        <p className="status" role="status" aria-live="polite">
          Loading page details
        </p>
      </section>
    );
  }

  if (state.status === 'unsupported') {
    return (
      <section
        className="surface"
        aria-labelledby="page-session-unsupported-heading"
      >
        <h2 id="page-session-unsupported-heading">
          Notes aren&apos;t available here
        </h2>
        <p role="status">{unsupportedMessage(state)}</p>
      </section>
    );
  }

  return (
    <section className="surface" aria-labelledby="page-session-error-heading">
      <h2 id="page-session-error-heading">PagePerch needs attention</h2>
      <p className="session-alert" role="alert">
        {state.message}
      </p>
    </section>
  );
}

function SessionArea({
  view,
  draftOwnership,
  Editor,
  pageOpener,
  pageSyncVisibility,
  recentNotesIndex,
  showRecentNotesOnOrigin,
}: {
  readonly view: SessionView;
  readonly draftOwnership: PageNoteOwnership;
  readonly Editor: ComponentType<PageNoteEditorProps>;
  readonly pageOpener: CanonicalPageOpener;
  readonly pageSyncVisibility?: PageSyncVisibility;
  readonly recentNotesIndex: RootRecentNotesIndex;
  readonly showRecentNotesOnOrigin: boolean;
}) {
  const flushError =
    view.current.status === 'error' &&
    view.current.reason === 'pending-save-flush-failed' &&
    view.lastSupported !== undefined
      ? view.current
      : undefined;
  const supported =
    view.current.status === 'supported'
      ? view.current
      : flushError === undefined
        ? undefined
        : view.lastSupported;
  const transient =
    view.current.status === 'supported' ? undefined : view.current;
  const recentNotes = useRootRecentNotes(
    supported,
    recentNotesIndex,
    showRecentNotesOnOrigin,
  );
  const syncVisibility = usePageSyncVisibility(supported, pageSyncVisibility);
  const draft = usePageNoteDraft(
    supported,
    draftOwnership,
    syncVisibility.evidence,
  );

  return (
    <div className="session-area">
      {flushError === undefined ? null : (
        <p className="session-alert surface" role="alert">
          {flushError.message}
        </p>
      )}
      {supported !== undefined ? (
        <>
          <SupportedPageShell
            key={supported.identity.pageKey}
            session={supported}
            draft={draft.view}
            retryOwnership={draft.retryOwnership}
            syncVisibility={syncVisibility.state}
            trustRemoteClaim={syncVisibility.trustRemoteClaim}
            Editor={Editor}
          />
          {showRecentNotesOnOrigin ? (
            <RecentNotes
              key={`recent:${supported.identity.pageKey}`}
              isRoot={supported.identity.isRoot}
              pageKey={supported.identity.pageKey}
              pageOpener={pageOpener}
              retry={recentNotes.retry}
              state={recentNotes.state}
            />
          ) : null}
        </>
      ) : transient === undefined ? null : (
        <TransientSessionState state={transient} />
      )}
    </div>
  );
}

export function SidePanelApp({
  createController,
  draftOwnership,
  Editor,
  openSettings,
  pageOpener,
  pageSyncVisibility,
  recentNotesIndex,
  settings,
}: SidePanelAppProps) {
  const view = useActivePageSession(createController);
  const [showRecentNotesOnOrigin, setShowRecentNotesOnOrigin] = useState(false);
  const [settingsError, setSettingsError] = useState<string>();
  const settingsAttemptRef = useRef(0);
  const settingsMountedRef = useRef(false);

  useEffect(() => {
    settingsMountedRef.current = true;

    return () => {
      settingsMountedRef.current = false;
      settingsAttemptRef.current += 1;
    };
  }, []);

  useEffect(() => {
    let active = true;

    const applyPreference = (value: boolean) => {
      if (active) {
        setShowRecentNotesOnOrigin(value);
      }
    };

    try {
      void Promise.resolve(settings.get()).then(
        (loadedSettings) => {
          applyPreference(loadedSettings.showRecentNotesOnOrigin);
        },
        () => {
          applyPreference(false);
        },
      );
    } catch {
      applyPreference(false);
    }

    return () => {
      active = false;
    };
  }, [settings]);

  const handleOpenSettings = () => {
    const attempt = settingsAttemptRef.current + 1;
    settingsAttemptRef.current = attempt;
    const complete = (error?: string) => {
      if (
        settingsMountedRef.current &&
        settingsAttemptRef.current === attempt
      ) {
        setSettingsError(error);
      }
    };

    try {
      void Promise.resolve(openSettings()).then(
        () => {
          complete();
        },
        () => {
          complete('PagePerch could not open settings. Try again.');
        },
      );
    } catch {
      complete('PagePerch could not open settings. Try again.');
    }
  };

  return (
    <main className="app-shell side-panel-shell">
      <header className="brand-header">
        <img src="/brand/page-perch-logo.png" alt="" width="48" height="48" />
        <div className="brand-copy">
          <h1>PagePerch</h1>
          <p>Notes that stay beside the page.</p>
        </div>
        <button
          type="button"
          className="settings-link"
          onClick={handleOpenSettings}
        >
          Settings
        </button>
      </header>
      {settingsError === undefined ? null : (
        <p className="session-alert settings-open-alert" role="alert">
          {settingsError}
        </p>
      )}

      <SessionArea
        view={view}
        draftOwnership={draftOwnership}
        Editor={Editor}
        pageOpener={pageOpener}
        pageSyncVisibility={pageSyncVisibility}
        recentNotesIndex={recentNotesIndex}
        showRecentNotesOnOrigin={showRecentNotesOnOrigin}
      />
    </main>
  );
}
