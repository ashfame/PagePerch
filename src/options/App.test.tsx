import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { EditorMode, SettingsRecordV1 } from '../domain/settings';
import {
  ChromeLocalSettingsRepository,
  SETTINGS_STORAGE_KEY,
} from '../repositories/chromeLocalSettingsRepository';
import { enqueueStorageOperation } from '../repositories/chromeStorage';
import { ByosError } from '../services/byosError';
import { IDENTITY_MIGRATION_JOURNAL_STORAGE_KEY } from '../services/identityMigrationPersistence';
import type {
  PendingSyncCount,
  PendingSyncCountConnection,
  PendingSyncCountState,
} from '../sync/syncVisibility';
import { InMemoryChromeStorage } from '../../test/inMemoryChromeStorage';
import { OptionsApp, type OptionsAppDependencies } from './App';

const builtInExclusions = {
  exactParameterNames: ['gclid', 'fbclid'],
  parameterNamePrefixes: ['utm_'],
} as const;

const NOW = '2026-07-25T12:00:00.000Z';

function connection() {
  return {
    accessToken: 'oauth-access-token',
    connectedAt: NOW,
    expiresAt: '2026-07-25T13:00:00.000Z',
  };
}

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

class FakePendingSyncCount implements PendingSyncCount {
  readonly disconnect = vi.fn();
  readonly connect = vi.fn(
    (
      emitState: (state: PendingSyncCountState) => void,
    ): PendingSyncCountConnection => {
      this.emitState = emitState;

      return { disconnect: this.disconnect };
    },
  );
  private emitState: ((state: PendingSyncCountState) => void) | undefined;

  emit(state: PendingSyncCountState): void {
    this.emitState?.(state);
  }
}

interface Harness {
  current(): SettingsRecordV1;
  readonly dependencies: OptionsAppDependencies;
  readonly connect: ReturnType<typeof vi.fn<() => Promise<void>>>;
  readonly disconnect: ReturnType<typeof vi.fn<() => Promise<void>>>;
  readonly get: ReturnType<typeof vi.fn<() => Promise<SettingsRecordV1>>>;
  readonly invalidateCredentials: ReturnType<typeof vi.fn<() => Promise<void>>>;
  readonly pendingSyncCount: FakePendingSyncCount;
  readonly request: ReturnType<typeof vi.fn>;
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
  readonly clock: ReturnType<typeof vi.fn<() => Date>>;
}

interface HarnessOptions {
  readonly clientId?: string;
  readonly enabled?: boolean;
}

function harness(
  initial: SettingsRecordV1 = settings(),
  options: HarnessOptions = {},
): Harness {
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
  const connect = vi.fn(() => {
    stored = { ...stored, byosConnection: connection() };
    return Promise.resolve();
  });
  const disconnect = vi.fn(() => {
    stored = {
      schemaVersion: stored.schemaVersion,
      editorMode: stored.editorMode,
      pageIdentityExclusions: stored.pageIdentityExclusions,
    };
    return Promise.resolve();
  });
  const clock = vi.fn(() => new Date(NOW));
  const request = vi.fn(() =>
    Promise.resolve({
      status: 'synced' as const,
      uploaded: 0,
      downloaded: 0,
      unchanged: 0,
      conflicts: 0,
      failed: 0,
      pending: 0,
    }),
  );
  const invalidateCredentials = vi.fn(() => Promise.resolve());
  const clientId = options.clientId ?? 'client-public';
  const pendingSyncCount = new FakePendingSyncCount();

  return {
    clock,
    connect,
    current: () => cloneSettings(stored),
    dependencies: {
      builtInExclusions,
      byos: {
        clock,
        config: {
          clientId,
          enabled: options.enabled ?? true,
        },
        connection: { connect, disconnect },
      },
      migration: { start },
      pendingSyncCount,
      settings: { get, updateEditorMode },
      syncMessages: { invalidateCredentials, request },
    },
    disconnect,
    get,
    invalidateCredentials,
    pendingSyncCount,
    request,
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
          byos: {
            clock: () => new Date(NOW),
            config: { clientId: 'client-public', enabled: true },
            connection: {
              connect: vi.fn(() => Promise.resolve()),
              disconnect: vi.fn(() => Promise.resolve()),
            },
          },
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

  it('shows built-in exclusions, accessible rule fields, and configured Local-only storage boundaries', async () => {
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
    expect(screen.getByRole('button', { name: 'Connect BYOS' })).toBeEnabled();
    expect(screen.queryByText('Pending changes')).toBeNull();
    expect(
      screen.queryByText(/sync engine is not yet configured/iu),
    ).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sync now' })).toBeNull();
  });

  it('updates the passive aggregate pending-page count without sync controls', async () => {
    const testHarness = harness();
    await renderReady(testHarness);

    expect(screen.getByText('Pages waiting to sync')).toBeInTheDocument();
    expect(screen.getByText('Checking…')).toBeInTheDocument();

    act(() => {
      testHarness.pendingSyncCount.emit({ status: 'ready', count: 2 });
    });
    expect(screen.getByText('2 pages')).toBeInTheDocument();

    act(() => {
      testHarness.pendingSyncCount.emit({ status: 'ready', count: 1 });
    });
    expect(screen.getByText('1 page')).toBeInTheDocument();

    act(() => {
      testHarness.pendingSyncCount.emit({ status: 'error' });
    });
    expect(screen.getByText('Unavailable')).toBeInTheDocument();

    act(() => {
      testHarness.pendingSyncCount.emit({ status: 'ready', count: 0 });
    });
    expect(screen.getByText('0 pages')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sync now/iu })).toBeNull();
    expect(screen.queryByRole('button', { name: /retry sync/iu })).toBeNull();
  });

  it('disables connection with exact missing-client guidance and no client calls', async () => {
    const testHarness = harness(settings(), { clientId: '   ' });
    await renderReady(testHarness);

    expect(screen.getByText('Local only')).toBeInTheDocument();
    expect(
      screen.getByText(
        'BYOS connection is unavailable because this build has no public client ID.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect BYOS' })).toBeDisabled();
    expect(testHarness.connect).not.toHaveBeenCalled();
    expect(testHarness.disconnect).not.toHaveBeenCalled();
    expect(testHarness.clock).not.toHaveBeenCalled();
    expect(
      screen.queryByText('Stored BYOS connection is inactive in this build.'),
    ).toBeNull();
    expect(
      screen.queryByRole('button', {
        name: 'Remove local BYOS connection',
      }),
    ).toBeNull();
  });

  it('discloses and manually removes an inactive stored connection without enabling authorization', async () => {
    const user = userEvent.setup();
    const currentConnection = connection();
    const testHarness = harness(
      settings({ byosConnection: currentConnection }),
      { clientId: '   ' },
    );
    testHarness.disconnect.mockRejectedValueOnce(
      new ByosError('disconnect-failed', 'sentinel-stored-token'),
    );
    await renderReady(testHarness);

    expect(
      screen.getByText('Stored BYOS connection is inactive in this build.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(currentConnection.accessToken)).toBeNull();
    expect(testHarness.connect).not.toHaveBeenCalled();
    expect(testHarness.disconnect).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole('button', {
        name: 'Remove local BYOS connection',
      }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'BYOS could not be disconnected safely. Retry disconnect.',
    );
    expect(screen.getByRole('alert')).not.toHaveTextContent('sentinel');
    expect(testHarness.get).toHaveBeenCalledTimes(2);

    await user.click(screen.getByRole('button', { name: 'Retry disconnect' }));

    await waitFor(() => {
      expect(
        screen.queryByText('Stored BYOS connection is inactive in this build.'),
      ).toBeNull();
    });
    expect(testHarness.disconnect).toHaveBeenCalledTimes(2);
    expect(testHarness.connect).not.toHaveBeenCalled();
    expect(testHarness.get).toHaveBeenCalledTimes(3);
    expect(screen.getByRole('button', { name: 'Connect BYOS' })).toBeDisabled();
  });

  it('connects from the disconnected state, refreshes settings, and preserves other settings', async () => {
    const user = userEvent.setup();
    const initial = settings({
      editorMode: 'paragraphs-only',
      pageIdentityExclusions: [
        { origin: 'https://example.com', parameterNames: ['session'] },
      ],
    });
    const testHarness = harness(initial);
    testHarness.request.mockRejectedValueOnce(
      new Error('service worker unavailable'),
    );
    await renderReady(testHarness);

    await user.click(screen.getByRole('button', { name: 'Connect BYOS' }));

    expect(await screen.findByText('Connected')).toBeInTheDocument();
    expect(testHarness.connect).toHaveBeenCalledOnce();
    expect(testHarness.request).toHaveBeenCalledWith('connection');
    expect(testHarness.get).toHaveBeenCalledTimes(2);
    expect(testHarness.current()).toEqual({
      ...initial,
      byosConnection: connection(),
    });
    expect(screen.getByRole('combobox', { name: 'Editor mode' })).toHaveValue(
      'paragraphs-only',
    );
    expect(
      screen.getByRole('button', {
        name: 'Remove session from https://example.com',
      }),
    ).toBeInTheDocument();
  });

  it('sanitizes a connect failure and retries successfully after refreshing actual state', async () => {
    const user = userEvent.setup();
    const testHarness = harness();
    testHarness.connect.mockRejectedValueOnce(
      new ByosError('token-failed', 'sentinel-token sentinel-callback'),
    );
    await renderReady(testHarness);

    await user.click(screen.getByRole('button', { name: 'Connect BYOS' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'BYOS connection was not completed. Retry the connection.',
    );
    expect(screen.getByRole('alert')).not.toHaveTextContent('sentinel');
    expect(testHarness.get).toHaveBeenCalledTimes(2);

    await user.click(
      screen.getByRole('button', { name: 'Retry BYOS connection' }),
    );

    expect(await screen.findByText('Connected')).toBeInTheDocument();
    expect(testHarness.connect).toHaveBeenCalledTimes(2);
    expect(testHarness.get).toHaveBeenCalledTimes(3);
  });

  it('shows connected status, human-readable expiry, last sync, and no secret material', async () => {
    const currentConnection = {
      ...connection(),
      lastSuccessfulSyncAt: '2026-07-25T12:15:00.000Z',
    };
    const testHarness = harness(
      settings({ byosConnection: currentConnection }),
    );
    await renderReady(testHarness);

    expect(screen.getByText('Local + BYOS')).toBeInTheDocument();
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.getByText('Token expires')).toBeInTheDocument();
    expect(screen.getByText('Last successful sync')).toBeInTheDocument();
    expect(
      document.querySelector(`time[datetime="${currentConnection.expiresAt}"]`),
    ).toHaveTextContent(/\S/u);
    expect(
      document.querySelector(
        `time[datetime="${currentConnection.lastSuccessfulSyncAt}"]`,
      ),
    ).toHaveTextContent(/\S/u);
    expect(screen.queryByText(currentConnection.accessToken)).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Disconnect BYOS' }),
    ).toBeEnabled();
  });

  it('wakes exactly at token expiry and transitions to reconnect required', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const expiresAt = '2026-07-25T12:00:01.000Z';
    const testHarness = harness(
      settings({
        byosConnection: {
          ...connection(),
          expiresAt,
        },
      }),
    );
    testHarness.clock.mockImplementation(() => new Date(Date.now()));
    const rendered = render(
      <OptionsApp dependencies={testHarness.dependencies} />,
    );

    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByText('Connected')).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(999);
      });
      expect(screen.getByText('Connected')).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(screen.getByText('Reconnect required')).toBeInTheDocument();
    } finally {
      rendered.unmount();
      vi.useRealTimers();
    }
  });

  it('clears a pending expiry wake when Options unmounts', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const testHarness = harness(settings({ byosConnection: connection() }));
    testHarness.clock.mockImplementation(() => new Date(Date.now()));
    const rendered = render(
      <OptionsApp dependencies={testHarness.dependencies} />,
    );

    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(vi.getTimerCount()).toBe(1);

      rendered.unmount();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      rendered.unmount();
      vi.useRealTimers();
    }
  });

  it('shows reconnect and disconnect controls for an expired connection', async () => {
    const user = userEvent.setup();
    const testHarness = harness(
      settings({
        byosConnection: {
          ...connection(),
          expiresAt: NOW,
        },
      }),
    );
    await renderReady(testHarness);

    expect(screen.getByText('Reconnect required')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Reconnect BYOS' }),
    ).toBeEnabled();
    expect(
      screen.getByRole('button', { name: 'Disconnect BYOS' }),
    ).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Reconnect BYOS' }));
    expect(await screen.findByText('Connected')).toBeInTheDocument();
    expect(testHarness.connect).toHaveBeenCalledOnce();
  });

  it('disconnects, refreshes actual settings, and preserves editor and identity settings', async () => {
    const user = userEvent.setup();
    const initial = settings({
      editorMode: 'paragraphs-only',
      pageIdentityExclusions: [
        { origin: 'https://example.com', parameterNames: ['session'] },
      ],
      byosConnection: connection(),
    });
    const testHarness = harness(initial);
    testHarness.invalidateCredentials.mockRejectedValueOnce(
      new Error('service worker unavailable'),
    );
    await renderReady(testHarness);

    await user.click(screen.getByRole('button', { name: 'Disconnect BYOS' }));

    expect(await screen.findByText('Not connected')).toBeInTheDocument();
    expect(testHarness.invalidateCredentials).toHaveBeenCalledOnce();
    expect(testHarness.disconnect).toHaveBeenCalledOnce();
    expect(testHarness.get).toHaveBeenCalledTimes(2);
    expect(testHarness.current()).toEqual({
      schemaVersion: 1,
      editorMode: 'paragraphs-only',
      pageIdentityExclusions: initial.pageIdentityExclusions,
    });
  });

  it('waits for best-effort worker invalidation before clearing the local connection', async () => {
    const user = userEvent.setup();
    let releaseInvalidation = (): void => undefined;
    const invalidation = new Promise<void>((resolve) => {
      releaseInvalidation = resolve;
    });
    const testHarness = harness(settings({ byosConnection: connection() }));
    testHarness.invalidateCredentials.mockReturnValueOnce(invalidation);
    await renderReady(testHarness);

    await user.click(screen.getByRole('button', { name: 'Disconnect BYOS' }));
    expect(testHarness.invalidateCredentials).toHaveBeenCalledOnce();
    expect(testHarness.disconnect).not.toHaveBeenCalled();

    releaseInvalidation();
    await waitFor(() => {
      expect(testHarness.disconnect).toHaveBeenCalledOnce();
    });
    expect(await screen.findByText('Not connected')).toBeInTheDocument();
  });

  it('retains refreshed connected state after disconnect failure and retries', async () => {
    const user = userEvent.setup();
    const testHarness = harness(settings({ byosConnection: connection() }));
    testHarness.disconnect.mockRejectedValueOnce(
      new ByosError('disconnect-failed', 'sentinel-access-token'),
    );
    await renderReady(testHarness);

    await user.click(screen.getByRole('button', { name: 'Disconnect BYOS' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'BYOS could not be disconnected safely. Retry disconnect.',
    );
    expect(screen.getByRole('alert')).not.toHaveTextContent('sentinel');
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(testHarness.get).toHaveBeenCalledTimes(2);

    await user.click(screen.getByRole('button', { name: 'Retry disconnect' }));

    expect(await screen.findByText('Not connected')).toBeInTheDocument();
    expect(testHarness.disconnect).toHaveBeenCalledTimes(2);
    expect(testHarness.get).toHaveBeenCalledTimes(3);
  });

  it('reports refresh failure after an action and retries status refresh without repeating authorization', async () => {
    const user = userEvent.setup();
    const testHarness = harness();
    await renderReady(testHarness);
    testHarness.get.mockRejectedValueOnce(
      new Error('sentinel-refresh secret-token'),
    );

    await user.click(screen.getByRole('button', { name: 'Connect BYOS' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'PagePerch could not refresh the actual BYOS connection state.',
    );
    expect(screen.getByRole('alert')).not.toHaveTextContent('sentinel');
    expect(screen.getByText('BYOS status unknown')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect BYOS' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reconnect BYOS' })).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Disconnect BYOS' }),
    ).toBeNull();

    await user.click(
      screen.getByRole('button', { name: 'Retry status refresh' }),
    );

    expect(await screen.findByText('Connected')).toBeInTheDocument();
    expect(testHarness.connect).toHaveBeenCalledOnce();
    expect(testHarness.get).toHaveBeenCalledTimes(3);
    expect(
      screen.getByRole('button', { name: 'Disconnect BYOS' }),
    ).toBeEnabled();
  });

  it('suppresses repeated disconnect while status refresh is required', async () => {
    const user = userEvent.setup();
    const testHarness = harness(settings({ byosConnection: connection() }));
    await renderReady(testHarness);
    testHarness.get.mockRejectedValueOnce(new Error('sentinel-refresh'));

    await user.click(screen.getByRole('button', { name: 'Disconnect BYOS' }));

    expect(await screen.findByText('BYOS status unknown')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Disconnect BYOS' }),
    ).toBeNull();
    expect(
      screen.queryByRole('button', {
        name: 'Remove local BYOS connection',
      }),
    ).toBeNull();
    expect(testHarness.disconnect).toHaveBeenCalledOnce();

    await user.click(
      screen.getByRole('button', { name: 'Retry status refresh' }),
    );

    expect(await screen.findByText('Not connected')).toBeInTheDocument();
    expect(testHarness.disconnect).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Connect BYOS' })).toBeEnabled();
  });

  it('disables conflicting controls and prevents duplicate connect while busy in Strict Mode', async () => {
    let finishConnect: (() => void) | undefined;
    const pendingConnect = new Promise<void>((resolve) => {
      finishConnect = resolve;
    });
    const testHarness = harness();
    testHarness.connect.mockReturnValueOnce(pendingConnect);
    render(
      <StrictMode>
        <OptionsApp dependencies={testHarness.dependencies} />
      </StrictMode>,
    );
    await screen.findByRole('heading', { level: 2, name: 'Editor' });
    const connectButton = screen.getByRole('button', {
      name: 'Connect BYOS',
    });

    fireEvent.click(connectButton);
    fireEvent.click(connectButton);

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Connecting BYOS',
    );
    expect(testHarness.connect).toHaveBeenCalledOnce();
    expect(
      screen.getByRole('combobox', { name: 'Editor mode' }),
    ).toBeDisabled();
    expect(screen.getByLabelText('Exact website origin')).toBeDisabled();
    expect(screen.getByLabelText('Query parameter name')).toBeDisabled();
    expect(connectButton).toBeDisabled();

    testHarness.get.mockResolvedValueOnce(
      settings({ byosConnection: connection() }),
    );
    finishConnect?.();
    expect(await screen.findByText('Connected')).toBeInTheDocument();
  });

  it('handles an injected invalid clock as reconnect-required without leaking errors', async () => {
    const testHarness = harness(settings({ byosConnection: connection() }));
    testHarness.clock.mockReturnValue(new Date(Number.NaN));
    await renderReady(testHarness);

    expect(screen.getByText('Reconnect required')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Reconnect BYOS' }),
    ).toBeEnabled();
    expect(
      screen.getByRole('button', { name: 'Disconnect BYOS' }),
    ).toBeEnabled();
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
    testHarness.request.mockRejectedValueOnce(
      new Error('service worker unavailable'),
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
    expect(testHarness.request).toHaveBeenCalledWith('identity-migration');
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
