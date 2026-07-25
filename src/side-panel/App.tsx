import { useEffect, useRef, useState } from 'react';

import '../styles/base.css';
import type {
  ActivePageSessionController,
  ActivePageSessionState,
  SupportedActivePageSessionState,
  UnsupportedActivePageSessionState,
} from './activePageSession';

type SessionController = Pick<ActivePageSessionController, 'start' | 'stop'>;

export type CreateActivePageSessionController = (
  emitState: (state: ActivePageSessionState) => void,
) => SessionController;

export interface SidePanelAppProps {
  readonly createController: CreateActivePageSessionController;
  readonly openSettings: () => void | Promise<void>;
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

function SupportedPageShell({
  session,
}: {
  readonly session: SupportedActivePageSessionState;
}) {
  const pageTitle = session.title.trim();

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
      <p>
        This page is identified and ready. The note editor is not connected yet.
      </p>
      <p className="status" role="status">
        Page identified
      </p>
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

function SessionArea({ view }: { readonly view: SessionView }) {
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

  return (
    <div className="session-area">
      {flushError === undefined ? null : (
        <p className="session-alert surface" role="alert">
          {flushError.message}
        </p>
      )}
      {supported !== undefined ? (
        <SupportedPageShell
          key={supported.identity.pageKey}
          session={supported}
        />
      ) : transient === undefined ? null : (
        <TransientSessionState state={transient} />
      )}
    </div>
  );
}

export function SidePanelApp({
  createController,
  openSettings,
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

      <SessionArea view={view} />

      <section
        className="surface preferences-surface"
        aria-labelledby="settings-heading"
      >
        <h2 id="settings-heading">Preferences</h2>
        <p>
          The settings page currently provides an overview of planned editor,
          page identity, and storage controls.
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
