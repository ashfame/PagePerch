import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { EditorMode, SettingsRecordV1 } from '../domain/settings';
import {
  ChromeLocalSettingsRepository,
  SETTINGS_STORAGE_KEY,
} from '../repositories/chromeLocalSettingsRepository';
import { enqueueStorageOperation } from '../repositories/chromeStorage';
import { IDENTITY_MIGRATION_JOURNAL_STORAGE_KEY } from '../services/identityMigrationPersistence';
import { InMemoryChromeStorage } from '../../test/inMemoryChromeStorage';
import { OptionsApp, type OptionsAppDependencies } from './App';

const builtInExclusions = {
  exactParameterNames: ['gclid', 'fbclid'],
  parameterNamePrefixes: ['utm_'],
} as const;

function settings(overrides: Partial<SettingsRecordV1> = {}): SettingsRecordV1 {
  return {
    schemaVersion: 1,
    editorMode: 'text-focused-blocks',
    pageIdentityExclusions: [],
    ...overrides,
  };
}

function cloneSettings(value: SettingsRecordV1): SettingsRecordV1 {
  return structuredClone(value);
}

interface Harness {
  current(): SettingsRecordV1;
  readonly dependencies: OptionsAppDependencies;
  readonly get: ReturnType<typeof vi.fn<() => Promise<SettingsRecordV1>>>;
  readonly updateEditorMode: ReturnType<
    typeof vi.fn<(editorMode: EditorMode) => Promise<SettingsRecordV1>>
  >;
  readonly start: ReturnType<
    typeof vi.fn<
      (
        value: SettingsRecordV1,
      ) => Promise<{ readonly operationId: string; readonly status: 'applied' }>
    >
  >;
}

function harness(initial: SettingsRecordV1 = settings()): Harness {
  let stored = cloneSettings(initial);
  const get = vi.fn(() => Promise.resolve(cloneSettings(stored)));
  const updateEditorMode = vi.fn((editorMode: EditorMode) => {
    stored = { ...stored, editorMode };
    return Promise.resolve(cloneSettings(stored));
  });
  const start = vi.fn((value: SettingsRecordV1) => {
    stored = cloneSettings(value);
    return Promise.resolve({
      status: 'applied' as const,
      operationId: 'options-operation',
    });
  });

  return {
    current: () => cloneSettings(stored),
    dependencies: {
      builtInExclusions,
      migration: { start },
      settings: { get, updateEditorMode },
    },
    get,
    updateEditorMode,
    start,
  };
}

async function renderReady(testHarness: Harness): Promise<void> {
  render(<OptionsApp dependencies={testHarness.dependencies} />);
  await screen.findByRole('heading', { level: 2, name: 'Editor' });
}

async function fillRule(
  user: ReturnType<typeof userEvent.setup>,
  origin: string,
  parameterName: string,
): Promise<void> {
  await user.clear(screen.getByLabelText('Exact website origin'));
  await user.type(screen.getByLabelText('Exact website origin'), origin);
  await user.clear(screen.getByLabelText('Query parameter name'));
  await user.type(screen.getByLabelText('Query parameter name'), parameterName);
}

describe('OptionsApp', () => {
  it('renders an accessible loading state while local settings are pending', () => {
    const pending = new Promise<SettingsRecordV1>(() => undefined);
    const testHarness = harness();
    testHarness.get.mockReturnValueOnce(pending);

    render(<OptionsApp dependencies={testHarness.dependencies} />);

    expect(
      screen.getByRole('heading', { level: 1, name: 'PagePerch settings' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: 'Loading settings' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Reading local settings',
    );
    expect(screen.getByRole('main')).toHaveAttribute('aria-busy', 'true');
  });

  it('shows a sanitized load error and retries successfully', async () => {
    const user = userEvent.setup();
    const testHarness = harness();
    testHarness.get
      .mockRejectedValueOnce(
        new Error('secret-token https://private.example/settings'),
      )
      .mockResolvedValueOnce(settings({ editorMode: 'paragraphs-only' }));

    render(<OptionsApp dependencies={testHarness.dependencies} />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'PagePerch could not read local settings.',
    );
    expect(screen.getByRole('alert')).not.toHaveTextContent('secret-token');
    await user.click(
      screen.getByRole('button', { name: 'Retry loading settings' }),
    );

    expect(
      await screen.findByRole('combobox', { name: 'Editor mode' }),
    ).toHaveValue('paragraphs-only');
    expect(testHarness.get).toHaveBeenCalledTimes(2);
  });

  it('saves editor mode directly while preserving custom exclusions and BYOS metadata', async () => {
    const user = userEvent.setup();
    const current = settings({
      pageIdentityExclusions: [
        { origin: 'https://example.com', parameterNames: ['session'] },
      ],
      byosConnection: {
        accessToken: 'preserved-token',
        connectedAt: '2026-07-25T10:00:00Z',
        expiresAt: '2026-08-01T10:00:00Z',
      },
    });
    const testHarness = harness(current);
    await renderReady(testHarness);

    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Editor mode' }),
      'paragraphs-only',
    );

    await waitFor(() => {
      expect(testHarness.updateEditorMode).toHaveBeenCalledOnce();
    });
    expect(testHarness.updateEditorMode).toHaveBeenCalledWith(
      'paragraphs-only',
    );
    expect(testHarness.current()).toEqual({
      ...current,
      editorMode: 'paragraphs-only',
    });
    expect(testHarness.start).not.toHaveBeenCalled();
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Editor mode saved.',
    );
  });

  it('retains the previous editor mode and allows retry after a direct save failure', async () => {
    const user = userEvent.setup();
    const testHarness = harness();
    testHarness.updateEditorMode.mockRejectedValueOnce(
      new Error('write failed'),
    );
    await renderReady(testHarness);
    const selector = screen.getByRole('combobox', { name: 'Editor mode' });

    await user.selectOptions(selector, 'paragraphs-only');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Editor mode could not be saved. Retry.',
    );
    expect(selector).toHaveValue('text-focused-blocks');
    expect(selector).toBeEnabled();

    await user.selectOptions(selector, 'paragraphs-only');
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Editor mode saved.',
    );
    expect(testHarness.updateEditorMode).toHaveBeenCalledTimes(2);
  });

  it('atomically applies an editor mode to settings completed by recovery after the UI loaded a stale snapshot', async () => {
    const user = userEvent.setup();
    const initial = settings();
    const recovered = settings({
      pageIdentityExclusions: [
        { origin: 'https://example.com', parameterNames: ['session'] },
      ],
      byosConnection: {
        accessToken: 'newer-token',
        connectedAt: '2026-07-25T11:00:00Z',
        expiresAt: '2026-08-01T11:00:00Z',
        lastSuccessfulSyncAt: '2026-07-25T11:30:00Z',
      },
    });
    const storage = new InMemoryChromeStorage({
      [IDENTITY_MIGRATION_JOURNAL_STORAGE_KEY]: { pending: true },
      [SETTINGS_STORAGE_KEY]: initial,
    });
    const repository = new ChromeLocalSettingsRepository(storage);
    const start = vi.fn(() =>
      Promise.resolve({
        status: 'applied' as const,
        operationId: 'unused-operation',
      }),
    );
    render(
      <OptionsApp
        dependencies={{
          builtInExclusions,
          migration: { start },
          settings: repository,
        }}
      />,
    );
    const selector = await screen.findByRole('combobox', {
      name: 'Editor mode',
    });
    expect(selector).toHaveValue('text-focused-blocks');
    expect(screen.getByText('Local only')).toBeInTheDocument();
    let finishRecovery: (() => void) | undefined;
    const recoveryGate = new Promise<void>((resolve) => {
      finishRecovery = resolve;
    });
    const recoveryCompletion = enqueueStorageOperation(storage, async () => {
      await recoveryGate;
      await storage.set({ [SETTINGS_STORAGE_KEY]: recovered });
      await storage.remove(IDENTITY_MIGRATION_JOURNAL_STORAGE_KEY);
    });

    await user.selectOptions(selector, 'paragraphs-only');
    expect(selector).toBeDisabled();
    finishRecovery?.();
    await recoveryCompletion;

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Editor mode saved.',
    );
    const expected = { ...recovered, editorMode: 'paragraphs-only' as const };
    expect(storage.snapshot()).toEqual({ [SETTINGS_STORAGE_KEY]: expected });
    expect(selector).toHaveValue('paragraphs-only');
    expect(screen.getByText('Local + BYOS')).toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: 'Remove session from https://example.com',
      }),
    ).toBeInTheDocument();
    expect(start).not.toHaveBeenCalled();
  });

  it('shows built-in exclusions, accessible rule fields, and Local-only storage boundaries', async () => {
    const testHarness = harness();
    await renderReady(testHarness);

    expect(screen.getByText('utm_*')).toBeInTheDocument();
    expect(screen.getByText('gclid')).toBeInTheDocument();
    expect(screen.getByText('fbclid')).toBeInTheDocument();
    expect(screen.getByLabelText('Exact website origin')).toHaveAttribute(
      'placeholder',
      'https://example.com',
    );
    expect(screen.getByLabelText('Query parameter name')).toBeInTheDocument();
    expect(screen.getByText('Local only')).toBeInTheDocument();
    expect(
      screen.getByText('Local storage is always on and cannot be disabled.'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Connect BYOS — coming next' }),
    ).toBeDisabled();
  });

  it('shows Local + BYOS without inventing connection management actions', async () => {
    const testHarness = harness(
      settings({
        byosConnection: {
          accessToken: 'existing-token',
          connectedAt: '2026-07-25T10:00:00Z',
          expiresAt: '2026-08-01T10:00:00Z',
        },
      }),
    );
    await renderReady(testHarness);

    expect(screen.getByText('Local + BYOS')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Manage BYOS — coming next' }),
    ).toBeDisabled();
    expect(
      screen.queryByText(/sign in|oauth|disconnect/iu),
    ).not.toBeInTheDocument();
  });

  it('adds one normalized exclusion through the executor, refreshes settings, and clears inputs only on success', async () => {
    const user = userEvent.setup();
    const testHarness = harness();
    await renderReady(testHarness);
    await fillRule(user, 'https://example.com', 'Session');

    await user.click(screen.getByRole('button', { name: 'Add exclusion' }));

    await waitFor(() => {
      expect(testHarness.start).toHaveBeenCalledOnce();
    });
    expect(testHarness.start).toHaveBeenCalledWith({
      ...settings(),
      pageIdentityExclusions: [
        { origin: 'https://example.com', parameterNames: ['session'] },
      ],
    });
    expect(testHarness.updateEditorMode).not.toHaveBeenCalled();
    expect(testHarness.get).toHaveBeenCalledTimes(2);
    expect(
      await screen.findByRole('button', {
        name: 'Remove session from https://example.com',
      }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Exact website origin')).toHaveValue('');
    expect(screen.getByLabelText('Query parameter name')).toHaveValue('');
  });

  it('removes one parameter through the executor, refreshes, and removes an empty origin rule', async () => {
    const user = userEvent.setup();
    const testHarness = harness(
      settings({
        pageIdentityExclusions: [
          { origin: 'https://example.com', parameterNames: ['session'] },
        ],
      }),
    );
    await renderReady(testHarness);

    await user.click(
      screen.getByRole('button', {
        name: 'Remove session from https://example.com',
      }),
    );

    await waitFor(() => {
      expect(testHarness.start).toHaveBeenCalledWith({
        ...settings(),
        pageIdentityExclusions: [],
      });
    });
    expect(
      await screen.findByText('No custom exclusions.'),
    ).toBeInTheDocument();
    expect(testHarness.get).toHaveBeenCalledTimes(2);
  });

  it('rejects invalid origins, built-ins, and duplicates before executor calls while retaining inputs', async () => {
    const user = userEvent.setup();
    const testHarness = harness(
      settings({
        pageIdentityExclusions: [
          { origin: 'https://example.com', parameterNames: ['session'] },
        ],
      }),
    );
    await renderReady(testHarness);

    await fillRule(user, 'https://example.com/path', 'campaign');
    await user.click(screen.getByRole('button', { name: 'Add exclusion' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Enter a canonical HTTP(S) origin',
    );

    await fillRule(user, 'https://example.com', 'UTM_campaign');
    await user.click(screen.getByRole('button', { name: 'Add exclusion' }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'already excluded by PagePerch',
    );

    await fillRule(user, 'https://example.com', 'SESSION');
    await user.click(screen.getByRole('button', { name: 'Add exclusion' }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'already excludes this query parameter',
    );
    expect(testHarness.start).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Exact website origin')).toHaveValue(
      'https://example.com',
    );
    expect(screen.getByLabelText('Query parameter name')).toHaveValue(
      'SESSION',
    );
  });

  it('retains rule inputs after migration failure and retries through the executor', async () => {
    const user = userEvent.setup();
    const testHarness = harness();
    testHarness.start.mockRejectedValueOnce(new Error('migration failed'));
    await renderReady(testHarness);
    await fillRule(user, 'https://example.com', 'session');

    await user.click(screen.getByRole('button', { name: 'Add exclusion' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Page identity settings could not be saved. Retry.',
    );
    expect(screen.getByLabelText('Exact website origin')).toHaveValue(
      'https://example.com',
    );
    expect(screen.getByLabelText('Query parameter name')).toHaveValue(
      'session',
    );

    await user.click(screen.getByRole('button', { name: 'Add exclusion' }));

    expect(
      await screen.findByRole('button', {
        name: 'Remove session from https://example.com',
      }),
    ).toBeInTheDocument();
    expect(testHarness.start).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText('Exact website origin')).toHaveValue('');
  });

  it('disables editor and rule actions while a migration is pending', async () => {
    const user = userEvent.setup();
    const testHarness = harness(
      settings({
        pageIdentityExclusions: [
          { origin: 'https://example.com', parameterNames: ['session'] },
        ],
      }),
    );
    let finishMigration: (() => void) | undefined;
    const migrationPending = new Promise<{
      readonly operationId: string;
      readonly status: 'applied';
    }>((resolve) => {
      finishMigration = () => {
        resolve({ status: 'applied', operationId: 'pending-operation' });
      };
    });
    testHarness.start.mockImplementationOnce(() => migrationPending);
    await renderReady(testHarness);
    await fillRule(user, 'https://example.com', 'campaign');

    await user.click(screen.getByRole('button', { name: 'Add exclusion' }));

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Updating page identity',
    );
    expect(
      screen.getByRole('combobox', { name: 'Editor mode' }),
    ).toBeDisabled();
    expect(screen.getByLabelText('Exact website origin')).toBeDisabled();
    expect(screen.getByLabelText('Query parameter name')).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Add exclusion' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', {
        name: 'Remove session from https://example.com',
      }),
    ).toBeDisabled();

    finishMigration?.();
    await waitFor(() => {
      expect(
        screen.getByRole('combobox', { name: 'Editor mode' }),
      ).toBeEnabled();
    });
  });
});
