import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';

import type { BuiltInPageIdentityExclusions } from '../domain/pageIdentity';
import type { EditorMode, SettingsRecordV1 } from '../domain/settings';
import type { SettingsRepository } from '../repositories/settingsRepository';
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

export interface OptionsAppDependencies {
  readonly builtInExclusions: BuiltInPageIdentityExclusions;
  readonly migration: MigrationPort;
  readonly settings: SettingsPort;
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

type BusyOperation = 'editor' | 'identity';

function isEditorMode(value: string): value is EditorMode {
  return value === 'text-focused-blocks' || value === 'paragraphs-only';
}

function busyMessage(operation: BusyOperation): string {
  return operation === 'editor'
    ? 'Saving editor mode…'
    : 'Updating page identity…';
}

export function OptionsApp({ dependencies }: OptionsAppProps) {
  const [view, setView] = useState<ViewState>({ status: 'loading' });
  const [busy, setBusy] = useState<BusyOperation>();
  const [notice, setNotice] = useState<Notice>();
  const [originInput, setOriginInput] = useState('');
  const [parameterInput, setParameterInput] = useState('');
  const loadRevision = useRef(0);
  const operationInFlight = useRef(false);

  const loadSettings = useCallback(async () => {
    const revision = loadRevision.current + 1;
    loadRevision.current = revision;
    setView({ status: 'loading' });
    setNotice(undefined);

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

  const isBusy = busy !== undefined;

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
                {view.settings.byosConnection === undefined
                  ? 'Local only'
                  : 'Local + BYOS'}
              </strong>
            </p>
            <p>Local storage is always on and cannot be disabled.</p>
            <p>
              {view.settings.byosConnection === undefined
                ? 'BYOS connection setup is coming next.'
                : 'This BYOS connection remains available. Connection management is coming next.'}
            </p>
            <button type="button" disabled>
              {view.settings.byosConnection === undefined
                ? 'Connect BYOS — coming next'
                : 'Manage BYOS — coming next'}
            </button>
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
