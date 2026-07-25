import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';

import type { ByosClientConfig } from '../background/byosClient';
import {
  requestSyncCredentialInvalidation,
  requestSyncFollowUp,
  type SyncRuntimeMessagePort,
} from '../background/syncRuntimeMessages';
import type { BuiltInPageIdentityExclusions } from '../domain/pageIdentity';
import type { EditorMode, SettingsRecordV1 } from '../domain/settings';
import type { SettingsRepository } from '../repositories/settingsRepository';
import type { ByosCoordinator } from '../services/byosCoordinator';
import { ByosError } from '../services/byosError';
import type { IdentityMigrationExecutor } from '../services/identityMigrationExecutor';
import '../styles/base.css';
import './App.css';
import {
  addPageIdentityExclusion,
  OptionsSettingsValidationError,
  removePageIdentityExclusion,
  sortedPageIdentityExclusions,
} from './settingsModel';

type SettingsPort = Pick<SettingsRepository, 'get' | 'updateEditorMode'>;
type MigrationPort = Pick<IdentityMigrationExecutor, 'start'>;
type ByosConnectionPort = Pick<ByosCoordinator, 'connect' | 'disconnect'>;

export interface OptionsByosDependencies {
  readonly clock: () => Date;
  readonly config: ByosClientConfig;
  readonly connection: ByosConnectionPort;
}

export interface OptionsAppDependencies {
  readonly builtInExclusions: BuiltInPageIdentityExclusions;
  readonly byos: OptionsByosDependencies;
  readonly migration: MigrationPort;
  readonly settings: SettingsPort;
  readonly syncMessages?: Pick<
    SyncRuntimeMessagePort,
    'invalidateCredentials' | 'request'
  >;
}

export interface OptionsAppProps {
  readonly dependencies: OptionsAppDependencies;
}

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'load-error' }
  | { readonly settings: SettingsRecordV1; readonly status: 'ready' };

interface Notice {
  readonly kind: 'error' | 'saved';
  readonly message: string;
}

type BusyOperation =
  'byos-connect' | 'byos-disconnect' | 'byos-refresh' | 'editor' | 'identity';

type ByosRetryAction = 'connect' | 'disconnect' | 'refresh';

interface ByosFailure {
  readonly message: string;
  readonly retry: ByosRetryAction;
}

type ByosDisplayState =
  | { readonly kind: 'connected'; readonly expiresAt: string }
  | { readonly kind: 'disconnected' }
  | { readonly kind: 'expired'; readonly expiresAt: string }
  | { readonly kind: 'unavailable' };

const MAX_TIMEOUT_DELAY_MS = 2_147_483_647;

function isEditorMode(value: string): value is EditorMode {
  return value === 'text-focused-blocks' || value === 'paragraphs-only';
}

function busyMessage(operation: BusyOperation): string {
  switch (operation) {
    case 'byos-connect':
      return 'Connecting BYOS…';
    case 'byos-disconnect':
      return 'Disconnecting BYOS…';
    case 'byos-refresh':
      return 'Refreshing BYOS status…';
    case 'editor':
      return 'Saving editor mode…';
    case 'identity':
      return 'Updating page identity…';
  }
}

function isByosConfigured(config: ByosClientConfig): boolean {
  return (
    config.enabled &&
    typeof config.clientId === 'string' &&
    config.clientId.trim() !== ''
  );
}

function byosDisplayState(
  settings: SettingsRecordV1,
  byos: OptionsByosDependencies,
): ByosDisplayState {
  if (!isByosConfigured(byos.config)) {
    return { kind: 'unavailable' };
  }

  const connection = settings.byosConnection;

  if (connection === undefined) {
    return { kind: 'disconnected' };
  }

  const expiresAt = new Date(connection.expiresAt);
  let now: Date;

  try {
    now = byos.clock();
  } catch {
    return { kind: 'expired', expiresAt: connection.expiresAt };
  }

  if (
    !(now instanceof Date) ||
    Number.isNaN(now.valueOf()) ||
    Number.isNaN(expiresAt.valueOf()) ||
    expiresAt.valueOf() <= now.valueOf()
  ) {
    return { kind: 'expired', expiresAt: connection.expiresAt };
  }

  return { kind: 'connected', expiresAt: connection.expiresAt };
}

function formatTimestamp(value: string): string {
  const timestamp = new Date(value);

  if (Number.isNaN(timestamp.valueOf())) {
    return 'Unavailable';
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(timestamp);
}

function byosActionFailure(
  action: 'connect' | 'disconnect',
  error: unknown,
): string {
  if (action === 'disconnect') {
    return 'BYOS could not be disconnected safely. Retry disconnect.';
  }

  if (error instanceof ByosError) {
    switch (error.code) {
      case 'configuration-required':
        return 'BYOS connection is unavailable in this build.';
      case 'randomness-failed':
        return 'Secure BYOS authorization could not be started. Retry the connection.';
      case 'session-failed':
        return 'BYOS authorization state could not be cleaned up safely. Retry the connection.';
      case 'state-mismatch':
        return 'BYOS authorization could not be verified. Retry the connection.';
      case 'authorization-failed':
      case 'token-failed':
      case 'credential-failed':
      case 'disconnect-failed':
      case 'reconnect-required':
        return 'BYOS connection was not completed. Retry the connection.';
    }
  }

  return 'BYOS connection was not completed. Retry the connection.';
}

export function OptionsApp({ dependencies }: OptionsAppProps) {
  const [view, setView] = useState<ViewState>({ status: 'loading' });
  const [busy, setBusy] = useState<BusyOperation>();
  const [notice, setNotice] = useState<Notice>();
  const [byosFailure, setByosFailure] = useState<ByosFailure>();
  const [expiryWakeRevision, setExpiryWakeRevision] = useState(0);
  const [originInput, setOriginInput] = useState('');
  const [parameterInput, setParameterInput] = useState('');
  const loadRevision = useRef(0);
  const operationInFlight = useRef(false);

  const loadSettings = useCallback(async () => {
    const revision = loadRevision.current + 1;
    loadRevision.current = revision;
    setView({ status: 'loading' });
    setNotice(undefined);
    setByosFailure(undefined);

    try {
      const settings = await dependencies.settings.get();

      if (loadRevision.current === revision) {
        setView({ status: 'ready', settings });
      }
    } catch {
      if (loadRevision.current === revision) {
        setView({ status: 'load-error' });
      }
    }
  }, [dependencies.settings]);

  useEffect(() => {
    const loadTimer = window.setTimeout(() => {
      void loadSettings();
    }, 0);

    return () => {
      window.clearTimeout(loadTimer);
      loadRevision.current += 1;
    };
  }, [loadSettings]);

  useEffect(() => {
    if (
      view.status !== 'ready' ||
      !isByosConfigured(dependencies.byos.config) ||
      view.settings.byosConnection === undefined
    ) {
      return;
    }

    const expiresAt = new Date(view.settings.byosConnection.expiresAt);
    let now: Date;

    try {
      now = dependencies.byos.clock();
    } catch {
      return;
    }

    if (
      !(now instanceof Date) ||
      Number.isNaN(now.valueOf()) ||
      Number.isNaN(expiresAt.valueOf()) ||
      expiresAt.valueOf() <= now.valueOf()
    ) {
      return;
    }

    const remaining = expiresAt.valueOf() - now.valueOf();
    const wakeTimer = window.setTimeout(
      () => {
        setExpiryWakeRevision((revision) => revision + 1);
      },
      Math.min(remaining, MAX_TIMEOUT_DELAY_MS),
    );

    return () => {
      window.clearTimeout(wakeTimer);
    };
  }, [dependencies.byos, expiryWakeRevision, view]);

  const beginOperation = (operation: BusyOperation): boolean => {
    if (operationInFlight.current) {
      return false;
    }

    operationInFlight.current = true;
    setBusy(operation);
    setNotice(undefined);
    return true;
  };

  const finishOperation = (): void => {
    operationInFlight.current = false;
    setBusy(undefined);
  };

  const saveEditorMode = async (
    currentSettings: SettingsRecordV1,
    editorMode: EditorMode,
  ): Promise<void> => {
    if (
      currentSettings.editorMode === editorMode ||
      !beginOperation('editor')
    ) {
      return;
    }

    try {
      const updatedSettings =
        await dependencies.settings.updateEditorMode(editorMode);
      setView({ status: 'ready', settings: updatedSettings });
      setNotice({ kind: 'saved', message: 'Editor mode saved.' });
    } catch {
      setNotice({
        kind: 'error',
        message: 'Editor mode could not be saved. Retry.',
      });
    } finally {
      finishOperation();
    }
  };

  const migrateIdentitySettings = async (
    requestedSettings: SettingsRecordV1,
    clearInputs: boolean,
  ): Promise<void> => {
    if (!beginOperation('identity')) {
      return;
    }

    try {
      await dependencies.migration.start(requestedSettings);
      if (dependencies.syncMessages !== undefined) {
        void requestSyncFollowUp(
          dependencies.syncMessages,
          'identity-migration',
        );
      }
      const refreshed = await dependencies.settings.get();
      setView({ status: 'ready', settings: refreshed });

      if (clearInputs) {
        setOriginInput('');
        setParameterInput('');
      }

      setNotice({
        kind: 'saved',
        message: 'Page identity settings saved.',
      });
    } catch {
      setNotice({
        kind: 'error',
        message: 'Page identity settings could not be saved. Retry.',
      });
    } finally {
      finishOperation();
    }
  };

  const addCustomExclusion = async (
    event: FormEvent<HTMLFormElement>,
    settings: SettingsRecordV1,
  ): Promise<void> => {
    event.preventDefault();

    let requestedSettings: SettingsRecordV1;

    try {
      requestedSettings = addPageIdentityExclusion(
        settings,
        originInput,
        parameterInput,
        dependencies.builtInExclusions,
      );
    } catch (error) {
      setNotice({
        kind: 'error',
        message:
          error instanceof OptionsSettingsValidationError
            ? error.message
            : 'The custom exclusion is invalid.',
      });
      return;
    }

    await migrateIdentitySettings(requestedSettings, true);
  };

  const removeCustomExclusion = async (
    settings: SettingsRecordV1,
    origin: string,
    parameterName: string,
  ): Promise<void> => {
    try {
      await migrateIdentitySettings(
        removePageIdentityExclusion(settings, origin, parameterName),
        false,
      );
    } catch (error) {
      setNotice({
        kind: 'error',
        message:
          error instanceof OptionsSettingsValidationError
            ? error.message
            : 'The custom exclusion is invalid.',
      });
    }
  };

  const performByosAction = async (
    action: 'connect' | 'disconnect',
  ): Promise<void> => {
    if (
      (action === 'connect' && !isByosConfigured(dependencies.byos.config)) ||
      !beginOperation(action === 'connect' ? 'byos-connect' : 'byos-disconnect')
    ) {
      return;
    }

    setByosFailure(undefined);
    let actionFailure: ByosFailure | undefined;

    try {
      if (action === 'disconnect' && dependencies.syncMessages !== undefined) {
        await requestSyncCredentialInvalidation(dependencies.syncMessages);
      }

      await dependencies.byos.connection[action]();

      if (action === 'connect' && dependencies.syncMessages !== undefined) {
        void requestSyncFollowUp(dependencies.syncMessages, 'connection');
      }
    } catch (error) {
      actionFailure = {
        message: byosActionFailure(action, error),
        retry: action,
      };
    }

    try {
      const refreshed = await dependencies.settings.get();
      setView({ status: 'ready', settings: refreshed });

      if (actionFailure === undefined) {
        setNotice({
          kind: 'saved',
          message:
            action === 'connect'
              ? 'BYOS connection saved. Local storage remains on.'
              : 'BYOS disconnected. Local storage remains on.',
        });
      } else {
        setByosFailure(actionFailure);
      }
    } catch {
      setNotice(undefined);
      setByosFailure({
        message:
          'PagePerch could not refresh the actual BYOS connection state. Retry status refresh.',
        retry: 'refresh',
      });
    } finally {
      finishOperation();
    }
  };

  const refreshByosStatus = async (): Promise<void> => {
    if (!beginOperation('byos-refresh')) {
      return;
    }

    setByosFailure(undefined);

    try {
      const refreshed = await dependencies.settings.get();
      setView({ status: 'ready', settings: refreshed });
      setNotice({
        kind: 'saved',
        message: 'BYOS connection status refreshed.',
      });
    } catch {
      setNotice(undefined);
      setByosFailure({
        message:
          'PagePerch could not refresh the actual BYOS connection state. Retry status refresh.',
        retry: 'refresh',
      });
    } finally {
      finishOperation();
    }
  };

  const isBusy = busy !== undefined;
  const isByosStatusUnknown = byosFailure?.retry === 'refresh';
  const hasStoredByosConnection =
    view.status === 'ready' && view.settings.byosConnection !== undefined;
  const storageState =
    view.status === 'ready'
      ? byosDisplayState(view.settings, dependencies.byos)
      : undefined;

  return (
    <main
      className="app-shell options-shell"
      aria-busy={view.status === 'loading' || isBusy}
    >
      <header className="brand-header">
        <img src="/brand/page-perch-logo.png" alt="" width="48" height="48" />
        <div>
          <h1>PagePerch settings</h1>
          <p>Private notes, configured with clear boundaries.</p>
        </div>
      </header>

      {view.status === 'loading' ? (
        <section
          className="surface options-state"
          aria-labelledby="loading-heading"
        >
          <h2 id="loading-heading">Loading settings</h2>
          <p className="status" role="status" aria-live="polite">
            Reading local settings…
          </p>
        </section>
      ) : view.status === 'load-error' ? (
        <section
          className="surface options-state"
          aria-labelledby="load-error-heading"
        >
          <h2 id="load-error-heading">Settings unavailable</h2>
          <p className="session-alert" role="alert">
            PagePerch could not read local settings.
          </p>
          <button type="button" onClick={() => void loadSettings()}>
            Retry loading settings
          </button>
        </section>
      ) : (
        <div className="settings-grid" aria-label="PagePerch settings">
          <section className="surface" aria-labelledby="editor-heading">
            <h2 id="editor-heading">Editor</h2>
            <p>Choose how much of the focused Gutenberg editor is available.</p>
            <label className="field-label" htmlFor="editor-mode">
              Editor mode
            </label>
            <select
              id="editor-mode"
              value={view.settings.editorMode}
              disabled={isBusy}
              onChange={(event) => {
                const editorMode = event.currentTarget.value;

                if (isEditorMode(editorMode)) {
                  void saveEditorMode(view.settings, editorMode);
                }
              }}
            >
              <option value="text-focused-blocks">Text-focused blocks</option>
              <option value="paragraphs-only">Paragraphs only</option>
            </select>
          </section>

          <section
            className="surface identity-surface"
            aria-labelledby="identity-heading"
          >
            <h2 id="identity-heading">Page identity</h2>
            <p>
              Excluded query parameters do not make a page a different note.
              Changes migrate affected local notes safely.
            </p>

            <div
              className="built-in-exclusions"
              aria-labelledby="built-ins-heading"
            >
              <h3 id="built-ins-heading">Always excluded by PagePerch</h3>
              <p>Prefix patterns</p>
              <ul>
                {[...dependencies.builtInExclusions.parameterNamePrefixes]
                  .sort()
                  .map((prefix) => (
                    <li key={prefix}>
                      <code>{prefix}*</code>
                    </li>
                  ))}
              </ul>
              <p>Exact parameter names</p>
              <ul>
                {[...dependencies.builtInExclusions.exactParameterNames]
                  .sort()
                  .map((parameterName) => (
                    <li key={parameterName}>
                      <code>{parameterName}</code>
                    </li>
                  ))}
              </ul>
            </div>

            <div
              className="custom-exclusions"
              aria-labelledby="custom-exclusions-heading"
            >
              <h3 id="custom-exclusions-heading">Custom exact-origin rules</h3>
              {sortedPageIdentityExclusions(
                view.settings.pageIdentityExclusions,
              ).length === 0 ? (
                <p className="empty-state">No custom exclusions.</p>
              ) : (
                <ul className="custom-rule-list">
                  {sortedPageIdentityExclusions(
                    view.settings.pageIdentityExclusions,
                  ).map((rule) => (
                    <li key={rule.origin} className="custom-rule">
                      <code>{rule.origin}</code>
                      <ul>
                        {rule.parameterNames.map((parameterName) => (
                          <li key={parameterName}>
                            <code>{parameterName}</code>
                            <button
                              type="button"
                              className="secondary-button"
                              disabled={isBusy}
                              aria-label={`Remove ${parameterName} from ${rule.origin}`}
                              onClick={() => {
                                void removeCustomExclusion(
                                  view.settings,
                                  rule.origin,
                                  parameterName,
                                );
                              }}
                            >
                              Remove
                            </button>
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              )}

              <form
                className="custom-rule-form"
                onSubmit={(event) => {
                  void addCustomExclusion(event, view.settings);
                }}
              >
                <fieldset disabled={isBusy}>
                  <legend>Add one excluded parameter</legend>
                  <label className="field-label" htmlFor="rule-origin">
                    Exact website origin
                  </label>
                  <input
                    id="rule-origin"
                    type="url"
                    inputMode="url"
                    autoComplete="url"
                    placeholder="https://example.com"
                    value={originInput}
                    onChange={(event) => {
                      setOriginInput(event.currentTarget.value);
                    }}
                  />
                  <p className="field-help">
                    Use a canonical HTTP(S) origin with no path, query,
                    fragment, or credentials.
                  </p>

                  <label className="field-label" htmlFor="parameter-name">
                    Query parameter name
                  </label>
                  <input
                    id="parameter-name"
                    type="text"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    placeholder="session"
                    value={parameterInput}
                    onChange={(event) => {
                      setParameterInput(event.currentTarget.value);
                    }}
                  />
                  <button type="submit">Add exclusion</button>
                </fieldset>
              </form>
            </div>
          </section>

          <section className="surface" aria-labelledby="storage-heading">
            <h2 id="storage-heading">Storage &amp; sync</h2>
            <p className="storage-status">
              <strong>
                {isByosStatusUnknown
                  ? 'Local on · BYOS status unknown'
                  : storageState?.kind === 'connected' ||
                      storageState?.kind === 'expired'
                    ? 'Local + BYOS'
                    : 'Local only'}
              </strong>
            </p>
            <p>Local storage is always on and cannot be disabled.</p>
            <p>Connecting BYOS does not turn local storage off.</p>

            {isByosStatusUnknown ? (
              <div className="byos-connection">
                <p className="byos-state">
                  <strong>BYOS status unknown</strong>
                </p>
                <p>
                  Refresh the stored connection state before taking another BYOS
                  action.
                </p>
              </div>
            ) : storageState?.kind === 'unavailable' ? (
              <div className="byos-connection">
                <p className="byos-state">
                  <strong>Unavailable in this build</strong>
                </p>
                <p>
                  BYOS connection is unavailable because this build has no
                  public client ID.
                </p>
                {hasStoredByosConnection ? (
                  <p>Stored BYOS connection is inactive in this build.</p>
                ) : null}
                <button type="button" disabled>
                  Connect BYOS
                </button>
                {hasStoredByosConnection &&
                byosFailure?.retry !== 'disconnect' ? (
                  <button
                    type="button"
                    className="secondary-button byos-remove-button"
                    disabled={isBusy}
                    onClick={() => void performByosAction('disconnect')}
                  >
                    Remove local BYOS connection
                  </button>
                ) : null}
              </div>
            ) : storageState?.kind === 'disconnected' ? (
              <div className="byos-connection">
                <p className="byos-state">
                  <strong>Not connected</strong>
                </p>
                <p>
                  Authorize PagePerch to use the established BYOS storage
                  service while local storage stays on.
                </p>
                {byosFailure?.retry === 'connect' ? null : (
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => void performByosAction('connect')}
                  >
                    Connect BYOS
                  </button>
                )}
              </div>
            ) : (
              <div className="byos-connection">
                <p className="byos-state">
                  <strong>
                    {storageState?.kind === 'connected'
                      ? 'Connected'
                      : 'Reconnect required'}
                  </strong>
                </p>
                <dl className="byos-details">
                  <div>
                    <dt>Token expires</dt>
                    <dd>
                      <time dateTime={storageState?.expiresAt}>
                        {formatTimestamp(storageState?.expiresAt ?? '')}
                      </time>
                    </dd>
                  </div>
                  {view.settings.byosConnection?.lastSuccessfulSyncAt ===
                  undefined ? null : (
                    <div>
                      <dt>Last successful sync</dt>
                      <dd>
                        <time
                          dateTime={
                            view.settings.byosConnection.lastSuccessfulSyncAt
                          }
                        >
                          {formatTimestamp(
                            view.settings.byosConnection.lastSuccessfulSyncAt,
                          )}
                        </time>
                      </dd>
                    </div>
                  )}
                </dl>
                <div className="byos-actions">
                  {storageState?.kind === 'expired' &&
                  byosFailure?.retry !== 'connect' ? (
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => void performByosAction('connect')}
                    >
                      Reconnect BYOS
                    </button>
                  ) : null}
                  {byosFailure?.retry === 'disconnect' ? null : (
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={isBusy}
                      onClick={() => void performByosAction('disconnect')}
                    >
                      Disconnect BYOS
                    </button>
                  )}
                </div>
              </div>
            )}

            {byosFailure === undefined ? null : (
              <div className="byos-failure">
                <p className="session-alert" role="alert">
                  {byosFailure.message}
                </p>
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => {
                    if (byosFailure.retry === 'refresh') {
                      void refreshByosStatus();
                    } else {
                      void performByosAction(byosFailure.retry);
                    }
                  }}
                >
                  {byosFailure.retry === 'connect'
                    ? 'Retry BYOS connection'
                    : byosFailure.retry === 'disconnect'
                      ? 'Retry disconnect'
                      : 'Retry status refresh'}
                </button>
              </div>
            )}
          </section>

          <div className="options-notice" aria-live="polite">
            {busy !== undefined ? (
              <p className="status" role="status">
                {busyMessage(busy)}
              </p>
            ) : notice?.kind === 'error' ? (
              <p className="session-alert" role="alert">
                {notice.message}
              </p>
            ) : notice?.kind === 'saved' ? (
              <p className="status" role="status">
                {notice.message}
              </p>
            ) : null}
          </div>
        </div>
      )}
    </main>
  );
}
