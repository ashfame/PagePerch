import { describe, expect, it, vi } from 'vitest';

const {
  createProductionByosSyncRuntime,
  handleAlarm,
  invalidateCredentials,
  recoverPendingIdentityMigration,
  start,
  trigger,
} = vi.hoisted(() => {
  const outcome = {
    status: 'disconnected' as const,
    uploaded: 0,
    downloaded: 0,
    unchanged: 0,
    conflicts: 0,
    failed: 0,
    pending: 0,
  };
  const start = vi.fn(() => Promise.resolve(outcome));
  const trigger = vi.fn(() => Promise.resolve(outcome));
  const handleAlarm = vi.fn(() => Promise.resolve(undefined));
  const invalidateCredentials = vi.fn();

  return {
    createProductionByosSyncRuntime: vi.fn(() => ({
      start,
      trigger,
      handleAlarm,
      invalidateCredentials,
    })),
    handleAlarm,
    invalidateCredentials,
    recoverPendingIdentityMigration: vi.fn(() => Promise.resolve()),
    start,
    trigger,
  };
});

vi.mock('./background/identityMigrationRecovery', () => ({
  recoverPendingIdentityMigration,
}));
vi.mock('./background/byosSyncRuntime', () => ({
  createProductionByosSyncRuntime,
}));

describe('service worker bootstrap', () => {
  it('configures the toolbar and resumes migration recovery exactly once on worker bootstrap', async () => {
    const setPanelBehavior = vi.fn(() => Promise.resolve());
    const installedAddListener = vi.fn();
    const startupAddListener = vi.fn();
    const messageAddListener = vi.fn();
    const alarmAddListener = vi.fn();
    vi.stubGlobal('chrome', {
      runtime: {
        onInstalled: { addListener: installedAddListener },
        onStartup: { addListener: startupAddListener },
        onMessage: { addListener: messageAddListener },
      },
      alarms: { onAlarm: { addListener: alarmAddListener } },
      sidePanel: { setPanelBehavior },
    });
    vi.resetModules();

    await import('./service-worker');
    await vi.waitFor(() => {
      expect(createProductionByosSyncRuntime).toHaveBeenCalledOnce();
      expect(setPanelBehavior).toHaveBeenCalledOnce();
      expect(recoverPendingIdentityMigration).toHaveBeenCalledOnce();
      expect(start).toHaveBeenCalledOnce();
    });

    const installListener = installedAddListener.mock.calls[0]?.[0] as
      (() => void) | undefined;
    const startupListener = startupAddListener.mock.calls[0]?.[0] as
      (() => void) | undefined;
    const alarmListener = alarmAddListener.mock.calls[0]?.[0] as
      ((alarm: { name: string }) => void) | undefined;
    const messageListener = messageAddListener.mock.calls[0]?.[0] as
      | ((
          message: unknown,
          sender: chrome.runtime.MessageSender,
          sendResponse: (response: unknown) => void,
        ) => boolean)
      | undefined;
    expect(installListener).toBeTypeOf('function');
    expect(startupListener).toBeTypeOf('function');
    expect(messageListener).toBeTypeOf('function');
    expect(
      messageListener?.({ type: 'another-extension:message' }, {}, vi.fn()),
    ).toBe(false);
    const sendResponse = vi.fn();
    expect(
      messageListener?.(
        {
          type: 'pageperch:v1:sync-runtime:trigger',
          reason: 'panel-open',
        },
        {},
        sendResponse,
      ),
    ).toBe(true);
    expect(
      messageListener?.(
        {
          type: 'pageperch:v1:sync-runtime:invalidate-credentials',
        },
        {},
        sendResponse,
      ),
    ).toBe(false);
    installListener?.();
    startupListener?.();
    alarmListener?.({ name: 'pageperch:v1:byos-sync-periodic' });
    await vi.waitFor(() => {
      expect(setPanelBehavior).toHaveBeenCalledTimes(2);
      expect(start).toHaveBeenCalledTimes(3);
      expect(trigger).toHaveBeenCalledOnce();
      expect(invalidateCredentials).toHaveBeenCalledOnce();
      expect(sendResponse).toHaveBeenCalledWith({
        type: 'pageperch:v1:sync-runtime:credentials-invalidated',
      });
      expect(sendResponse).toHaveBeenCalledWith({
        type: 'pageperch:v1:sync-runtime:status',
        outcome: {
          status: 'disconnected',
          uploaded: 0,
          downloaded: 0,
          unchanged: 0,
          conflicts: 0,
          failed: 0,
          pending: 0,
        },
      });
      expect(handleAlarm).toHaveBeenCalledWith(
        'pageperch:v1:byos-sync-periodic',
      );
    });
    expect(recoverPendingIdentityMigration).toHaveBeenCalledTimes(3);
  });

  it('reports a sanitized error when Chrome rejects panel configuration', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    vi.stubGlobal('chrome', {
      runtime: {
        onInstalled: { addListener: vi.fn() },
        onStartup: { addListener: vi.fn() },
        onMessage: { addListener: vi.fn() },
      },
      alarms: { onAlarm: { addListener: vi.fn() } },
      sidePanel: {
        setPanelBehavior: vi.fn(() =>
          Promise.reject(new Error('sensitive browser detail')),
        ),
      },
    });
    vi.resetModules();

    await import('./service-worker');
    await vi.waitFor(() => {
      expect(consoleError).toHaveBeenCalledWith(
        'PagePerch could not configure the toolbar side panel behavior.',
      );
    });
    expect(consoleError).not.toHaveBeenCalledWith(
      expect.stringContaining('sensitive browser detail'),
    );
  });

  it('contains migration recovery failures with one stable actionable sanitized message', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    recoverPendingIdentityMigration.mockRejectedValueOnce(
      new Error(
        'secret-token https://private.example/note Private note content',
      ),
    );
    vi.stubGlobal('chrome', {
      runtime: {
        onInstalled: { addListener: vi.fn() },
        onStartup: { addListener: vi.fn() },
        onMessage: { addListener: vi.fn() },
      },
      alarms: { onAlarm: { addListener: vi.fn() } },
      sidePanel: {
        setPanelBehavior: vi.fn(() => Promise.resolve()),
      },
    });
    vi.resetModules();

    await import('./service-worker');
    await vi.waitFor(() => {
      expect(consoleError).toHaveBeenCalledWith(
        'PagePerch could not finish a pending note identity update. Open PagePerch settings and retry.',
      );
    });
    expect(consoleError).toHaveBeenCalledOnce();
    expect(consoleError.mock.calls.flat().join(' ')).not.toMatch(
      /secret-token|private\.example|Private note content/u,
    );
  });
});
