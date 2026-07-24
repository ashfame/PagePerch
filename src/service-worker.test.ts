import { describe, expect, it, vi } from 'vitest';

describe('service worker bootstrap', () => {
  it('configures the toolbar immediately and again after installation', async () => {
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
    });

    const installListener = addListener.mock.calls[0]?.[0] as
      (() => void) | undefined;
    expect(installListener).toBeTypeOf('function');
    installListener?.();
    await vi.waitFor(() => {
      expect(setPanelBehavior).toHaveBeenCalledTimes(2);
    });
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
});
