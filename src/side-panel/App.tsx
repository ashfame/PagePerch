import { useEffect, useRef, useState, type ComponentType } from 'react';

import '../styles/base.css';
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
  readonly recentNotesIndex: RootRecentNotesIndex;
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

const NOTE_RUNTIME_ERROR =
  'PagePerch could not prepare this local note. Retry.';
function usePageNoteDraft(
  session: SupportedActivePageSessionState | undefined,
  ownership: PageNoteOwnership,
): PageNoteDraftView {
  const [view, setView] = useState<PageNoteOwnershipView>();
  const connectionRef = useRef<PageNoteOwnershipConnection>();

  useEffect(() => {
    const connection = ownership.connect(setView);
    connectionRef.current = connection;

    return () => {
      if (connectionRef.current === connection) {
        connectionRef.current = undefined;
      }

      connection.disconnect();
    };
  }, [ownership]);

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
): RootRecentNotesView {
  const [state, setState] = useState<RootRecentNotesState>();
  const connectionRef = useRef<RootRecentNotesConnection>();

  useEffect(() => {
    const connection = index.connect(setState);
    connectionRef.current = connection;

    return () => {
      if (connectionRef.current === connection) {
        connectionRef.current = undefined;
      }

      connection.disconnect();
    };
  }, [index]);

  useEffect(() => {
    connectionRef.current?.setSession(session);
  }, [index, session]);

  return {
    retry: () => {
      connectionRef.current?.retry();
    },
    state,
  };
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

function RecentOriginNotes({
  pageKey,
  pageOpener,
  retry,
  state,
}: {
  readonly pageKey: string;
  readonly pageOpener: CanonicalPageOpener;
  readonly retry: () => void;
  readonly state: RootRecentNotesState | undefined;
}) {
  const activeState = state?.pageKey === pageKey ? state : undefined;
  const [openErrorPageKey, setOpenErrorPageKey] = useState<string>();
  const actionLifecycleRef = useRef({ attempt: 0, mounted: true });

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
      className="surface recent-notes-surface"
      aria-labelledby="recent-origin-notes-heading"
    >
      <h2 id="recent-origin-notes-heading">Recent notes on this origin</h2>
      {activeState === undefined || activeState.status === 'loading' ? (
        <p className="status" role="status" aria-live="polite">
          Loading recent notes
        </p>
      ) : activeState.status === 'error' ? (
        <div className="note-action-panel">
          <p className="session-alert" role="alert">
            PagePerch could not load recent notes from this origin. Retry.
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
              No other saved notes on this origin yet.
            </p>
          ) : (
            <ul className="recent-notes-list">
              {activeState.entries.map((entry) => {
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
  Editor,
}: {
  readonly session: SupportedActivePageSessionState;
  readonly draft?: PageNoteOwnershipView;
  readonly retryOwnership: () => void;
  readonly Editor: ComponentType<PageNoteEditorProps>;
}) {
  const pageTitle = session.title.trim();
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
    <section
      className="surface page-document-shell"
      aria-labelledby="page-note-heading"
      data-testid="page-document-shell"
    >
      <p className="surface-label">Page note</p>
      <h2 id="page-note-heading">
        Notes for {pageTitle === '' ? 'this page' : pageTitle}
      </h2>
      <p className="page-context">
        <span>Canonical page</span>
        <code title={session.identity.canonicalUrl}>
          {canonicalContext(session.identity.canonicalUrl)}
        </code>
      </p>
      {activeDraft === undefined ? (
        <p className="status note-status" role="status" aria-live="polite">
          Loading cached note
        </p>
      ) : activeDraft.status === 'runtime-error' ? (
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
      ) : activeDraft.state.status === 'loading' ? (
        <p className="status note-status" role="status" aria-live="polite">
          Loading cached note
        </p>
      ) : activeDraft.state.status === 'load-error' ? (
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
          ) : activeDraft.state.save.phase === 'saved-locally' ? (
            <p className="status note-status" role="status" aria-live="polite">
              Saved locally
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
          ) : null}
        </div>
      )}
      {actionError === undefined ? null : (
        <p className="session-alert note-action-error" role="alert">
          {actionError}
        </p>
      )}
    </section>
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
  recentNotesIndex,
}: {
  readonly view: SessionView;
  readonly draftOwnership: PageNoteOwnership;
  readonly Editor: ComponentType<PageNoteEditorProps>;
  readonly pageOpener: CanonicalPageOpener;
  readonly recentNotesIndex: RootRecentNotesIndex;
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
  const draft = usePageNoteDraft(supported, draftOwnership);
  const recentNotes = useRootRecentNotes(supported, recentNotesIndex);

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
            Editor={Editor}
          />
          {supported.identity.isRoot ? (
            <RecentOriginNotes
              key={`recent:${supported.identity.pageKey}`}
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
  recentNotesIndex,
}: SidePanelAppProps) {
  const view = useActivePageSession(createController);
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
        <div>
          <h1>PagePerch</h1>
          <p>Notes that stay beside the page.</p>
        </div>
      </header>

      <SessionArea
        view={view}
        draftOwnership={draftOwnership}
        Editor={Editor}
        pageOpener={pageOpener}
        recentNotesIndex={recentNotesIndex}
      />

      <section
        className="surface preferences-surface"
        aria-labelledby="settings-heading"
      >
        <h2 id="settings-heading">Preferences</h2>
        <p>
          Review editor safeguards, page identity behavior, and local storage
          boundaries.
        </p>
        {settingsError === undefined ? null : (
          <p className="session-alert preferences-alert" role="alert">
            {settingsError}
          </p>
        )}
        <button type="button" onClick={handleOpenSettings}>
          Open settings
        </button>
      </section>
    </main>
  );
}
