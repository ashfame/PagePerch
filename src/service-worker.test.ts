import { describe, expect, it, vi } from 'vitest';

const { recoverPendingIdentityMigration } = vi.hoisted(() => ({
  recoverPendingIdentityMigration: vi.fn(() => Promise.resolve()),
}));

vi.mock('./background/identityMigrationRecovery', () => ({
  recoverPendingIdentityMigration,
}));

describe('service worker bootstrap', () => {
  it('configures the toolbar and resumes migration recovery exactly once on worker bootstrap', async () => {
    const setPanelBehavior = vi.fn(() => Promise.resolve());
    const addListener = vi.fn();
    vi.stubGlobal('chrome', {
      runtime: {
        onInstalled: { addListener },
      },
      sidePanel: { setPanelBehavior },
    });
    vi.resetModules();

    await import('./service-worker');
    await vi.waitFor(() => {
      expect(setPanelBehavior).toHaveBeenCalledOnce();
      expect(recoverPendingIdentityMigration).toHaveBeenCalledOnce();
    });

    const installListener = addListener.mock.calls[0]?.[0] as
      (() => void) | undefined;
    expect(installListener).toBeTypeOf('function');
    installListener?.();
    await vi.waitFor(() => {
      expect(setPanelBehavior).toHaveBeenCalledTimes(2);
    });
    expect(recoverPendingIdentityMigration).toHaveBeenCalledOnce();
  });

  it('reports a sanitized error when Chrome rejects panel configuration', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    vi.stubGlobal('chrome', {
      runtime: {
        onInstalled: { addListener: vi.fn() },
      },
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
      },
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
