import { StrictMode } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type {
  ActivePageSessionState,
  SupportedActivePageSessionState,
} from './activePageSession';
import { SidePanelApp, type CreateActivePageSessionController } from './App';

class FakeSessionController {
  readonly stop = vi.fn();
  readonly start = vi.fn(() => this.stop);

  constructor(
    private readonly emitState: (state: ActivePageSessionState) => void,
  ) {}

  emit(state: ActivePageSessionState): void {
    this.emitState(state);
  }
}

function supportedSession(
  overrides: Partial<SupportedActivePageSessionState> = {},
): SupportedActivePageSessionState {
  return {
    status: 'supported',
    tabId: 1,
    representativeUrl: 'https://example.com/path?a=1',
    title: 'Example title',
    identity: {
      canonicalUrl: 'https://example.com/path?a=1',
      isRoot: false,
      origin: 'https://example.com',
      pageKey: 'A'.repeat(43),
      pathname: '/path',
    },
    ...overrides,
  };
}

function renderApp(
  options: {
    readonly strict?: boolean;
    readonly openSettings?: () => void | Promise<void>;
  } = {},
) {
  let controller: FakeSessionController | undefined;
  const createController = vi.fn<CreateActivePageSessionController>(
    (emitState) => {
      controller = new FakeSessionController(emitState);

      return controller;
    },
  );
  const openSettings = vi.fn(options.openSettings ?? (() => undefined));
  const app = (
    <SidePanelApp
      createController={createController}
      openSettings={openSettings}
    />
  );
  const rendered = render(
    options.strict === true ? <StrictMode>{app}</StrictMode> : app,
  );

  if (controller === undefined) {
    throw new Error(
      'Expected the mounted app to create its session controller.',
    );
  }

  return {
    ...rendered,
    controller,
    createController,
    openSettings,
  };
}

function emit(
  controller: FakeSessionController,
  state: ActivePageSessionState,
): void {
  act(() => {
    controller.emit(state);
  });
}

describe('SidePanelApp session states', () => {
  it('renders a branded loading state and keeps settings available', async () => {
    const user = userEvent.setup();
    const { openSettings } = renderApp();

    expect(
      screen.getByRole('heading', { level: 1, name: 'PagePerch' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', {
        level: 2,
        name: 'Finding the active page',
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Loading page details',
    );
    expect(
      screen.getByText(
        /overview of planned editor, page identity, and storage controls/u,
      ),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Open settings' }));
    expect(openSettings).toHaveBeenCalledOnce();
  });

  it.each([
    [
      {
        status: 'unsupported',
        reason: 'no-active-tab',
        title: '',
      },
      'No active browser tab is available',
    ],
    [
      {
        status: 'unsupported',
        reason: 'missing-tab-id',
        title: 'Missing ID',
      },
      'missing the identifier',
    ],
    [
      {
        status: 'unsupported',
        reason: 'missing-url',
        tabId: 1,
        title: 'Missing URL',
      },
      'did not provide a page address',
    ],
    [
      {
        status: 'unsupported',
        reason: 'invalid-url',
        tabId: 1,
        representativeUrl: 'not-a-url',
        title: 'Invalid URL',
      },
      'invalid page address',
    ],
    [
      {
        status: 'unsupported',
        reason: 'unsupported-scheme',
        tabId: 1,
        representativeUrl: 'chrome-extension://abc/side-panel.html',
        title: 'Extension page',
        protocol: 'chrome-extension:',
      },
      'chrome-extension: page type is not supported',
    ],
  ] as const)(
    'renders a distinct unsupported explanation for %j',
    (state, expectedMessage) => {
      const { controller } = renderApp();

      emit(controller, state);

      expect(
        screen.getByRole('heading', {
          level: 2,
          name: "Notes aren't available here",
        }),
      ).toBeInTheDocument();
      expect(screen.getByRole('status')).toHaveTextContent(expectedMessage);
      expect(
        screen.getByRole('button', { name: 'Open settings' }),
      ).toBeInTheDocument();
    },
  );

  it('renders a supported page shell with title and canonical path context', () => {
    const { controller } = renderApp();

    emit(controller, supportedSession());

    expect(
      screen.getByRole('heading', {
        level: 2,
        name: 'Notes for Example title',
      }),
    ).toBeInTheDocument();
    expect(screen.getByText('/path?a=1')).toHaveAttribute(
      'title',
      'https://example.com/path?a=1',
    );
    expect(
      screen.getByText(/editor is not connected yet/u),
    ).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Page identified');
  });

  it('renders actionable non-flush errors instead of the prior page shell', () => {
    const { controller } = renderApp();
    emit(controller, supportedSession());

    emit(controller, {
      status: 'error',
      reason: 'identity-failed',
      message: 'Reload the page or reopen the side panel to retry.',
      tabId: 1,
    });

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Reload the page or reopen the side panel to retry.',
    );
    expect(
      screen.getByRole('heading', {
        level: 2,
        name: 'PagePerch needs attention',
      }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('page-document-shell')).not.toBeInTheDocument();
  });

  it('renders an actionable settings-load failure with settings still available', () => {
    const { controller } = renderApp();

    emit(controller, {
      status: 'error',
      reason: 'settings-load-failed',
      message:
        'PagePerch could not load page identity settings. Open settings or retry.',
      tabId: 1,
    });

    expect(screen.getByRole('alert')).toHaveTextContent(
      'PagePerch could not load page identity settings.',
    );
    expect(
      screen.getByRole('button', { name: 'Open settings' }),
    ).toBeInTheDocument();
  });

  it('retains the supported keyed shell when the pending save flush fails', () => {
    const { controller } = renderApp();
    emit(controller, supportedSession());
    const pageShell = screen.getByTestId('page-document-shell');

    emit(controller, {
      status: 'error',
      reason: 'pending-save-flush-failed',
      message: 'Save the previous note before switching pages.',
      tabId: 2,
    });

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Save the previous note before switching pages.',
    );
    expect(screen.getByTestId('page-document-shell')).toBe(pageShell);
    expect(
      screen.getByRole('heading', {
        level: 2,
        name: 'Notes for Example title',
      }),
    ).toBeInTheDocument();
  });

  it('preserves the shell for same-key metadata updates and remounts it for a new page key', () => {
    const { controller } = renderApp();
    emit(controller, supportedSession());
    const firstShell = screen.getByTestId('page-document-shell');

    emit(
      controller,
      supportedSession({
        representativeUrl: 'https://example.com/path?a=1#section',
        title: 'Updated title',
      }),
    );
    expect(screen.getByTestId('page-document-shell')).toBe(firstShell);
    expect(
      screen.getByRole('heading', {
        level: 2,
        name: 'Notes for Updated title',
      }),
    ).toBeInTheDocument();

    emit(
      controller,
      supportedSession({
        representativeUrl: 'https://example.com/other',
        title: 'Other page',
        identity: {
          canonicalUrl: 'https://example.com/other',
          isRoot: false,
          origin: 'https://example.com',
          pageKey: 'B'.repeat(43),
          pathname: '/other',
        },
      }),
    );
    expect(screen.getByTestId('page-document-shell')).not.toBe(firstShell);
    expect(screen.getByText('/other')).toBeInTheDocument();
  });
});

describe('SidePanelApp controller lifecycle', () => {
  it('creates and starts one controller through the StrictMode effect probe, then stops it on unmount', async () => {
    const { controller, createController, unmount } = renderApp({
      strict: true,
    });

    await act(async () => {
      await Promise.resolve();
    });
    expect(createController).toHaveBeenCalledOnce();
    expect(controller.start).toHaveBeenCalledOnce();
    expect(controller.stop).not.toHaveBeenCalled();

    unmount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(controller.stop).toHaveBeenCalledOnce();
  });

  it('stops and replaces the runtime exactly once when the controller factory changes', async () => {
    let firstController: FakeSessionController | undefined;
    let secondController: FakeSessionController | undefined;
    const firstFactory = vi.fn<CreateActivePageSessionController>(
      (emitState) => {
        firstController = new FakeSessionController(emitState);

        return firstController;
      },
    );
    const secondFactory = vi.fn<CreateActivePageSessionController>(
      (emitState) => {
        secondController = new FakeSessionController(emitState);

        return secondController;
      },
    );
    const openSettings = vi.fn();
    const { rerender } = render(
      <SidePanelApp
        createController={firstFactory}
        openSettings={openSettings}
      />,
    );

    if (firstController === undefined) {
      throw new Error('Expected the first controller to be created.');
    }

    rerender(
      <SidePanelApp
        createController={secondFactory}
        openSettings={openSettings}
      />,
    );

    if (secondController === undefined) {
      throw new Error('Expected the replacement controller to be created.');
    }

    expect(firstController.stop).toHaveBeenCalledOnce();
    expect(secondController.start).toHaveBeenCalledOnce();
    emit(firstController, supportedSession({ title: 'Stale first runtime' }));
    expect(
      screen.queryByText('Notes for Stale first runtime'),
    ).not.toBeInTheDocument();
    emit(secondController, supportedSession({ title: 'Replacement runtime' }));
    expect(
      screen.getByText('Notes for Replacement runtime'),
    ).toBeInTheDocument();

    await act(async () => {
      await Promise.resolve();
    });
    expect(firstController.stop).toHaveBeenCalledOnce();
    expect(secondController.stop).not.toHaveBeenCalled();
    expect(firstFactory).toHaveBeenCalledOnce();
    expect(secondFactory).toHaveBeenCalledOnce();
  });

  it('renders an actionable error when the controller factory throws', () => {
    const createController = vi.fn<CreateActivePageSessionController>(() => {
      throw new Error('factory failed');
    });

    render(
      <SidePanelApp
        createController={createController}
        openSettings={vi.fn()}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent(
      'could not start tracking the active page',
    );
    expect(createController).toHaveBeenCalledOnce();
  });

  it('cleans a partially started controller and renders an actionable error when start throws', () => {
    const stop = vi.fn();
    const start = vi.fn(() => {
      throw new Error('start failed');
    });
    const createController = vi.fn<CreateActivePageSessionController>(() => ({
      start,
      stop,
    }));

    render(
      <SidePanelApp
        createController={createController}
        openSettings={vi.fn()}
      />,
    );

    expect(start).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'could not start tracking the active page',
    );
  });

  it('accepts a synchronous session emission during controller startup', () => {
    const stop = vi.fn();
    const start = vi.fn();
    const createController = vi.fn<CreateActivePageSessionController>(
      (emitState) => ({
        stop,
        start: () => {
          start();
          emitState(supportedSession({ title: 'Synchronous startup' }));

          return stop;
        },
      }),
    );

    render(
      <SidePanelApp
        createController={createController}
        openSettings={vi.fn()}
      />,
    );

    expect(
      screen.getByRole('heading', {
        level: 2,
        name: 'Notes for Synchronous startup',
      }),
    ).toBeInTheDocument();
    expect(start).toHaveBeenCalledOnce();
  });

  it('suppresses emissions immediately after unmount and stops once in queued cleanup', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const { controller, unmount } = renderApp();

    unmount();
    expect(controller.stop).not.toHaveBeenCalled();
    act(() => {
      controller.emit(supportedSession());
    });
    expect(
      screen.queryByText('Notes for Example title'),
    ).not.toBeInTheDocument();

    await act(async () => {
      await Promise.resolve();
    });

    expect(controller.stop).toHaveBeenCalledOnce();
    expect(
      screen.queryByText('Notes for Example title'),
    ).not.toBeInTheDocument();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('creates a fresh runtime on remount while the prior cleanup is queued', async () => {
    const controllers: FakeSessionController[] = [];
    const createController = vi.fn<CreateActivePageSessionController>(
      (emitState) => {
        const controller = new FakeSessionController(emitState);
        controllers.push(controller);

        return controller;
      },
    );
    const firstMount = render(
      <SidePanelApp
        createController={createController}
        openSettings={vi.fn()}
      />,
    );
    const firstController = controllers[0];

    firstMount.unmount();
    const secondMount = render(
      <SidePanelApp
        createController={createController}
        openSettings={vi.fn()}
      />,
    );
    const secondController = controllers[1];

    expect(firstController).toBeDefined();
    expect(secondController).toBeDefined();
    expect(secondController).not.toBe(firstController);
    expect(createController).toHaveBeenCalledTimes(2);

    await act(async () => {
      await Promise.resolve();
    });
    expect(firstController?.stop).toHaveBeenCalledOnce();
    expect(secondController?.stop).not.toHaveBeenCalled();

    secondMount.unmount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(secondController?.stop).toHaveBeenCalledOnce();
  });
});

describe('SidePanelApp settings navigation', () => {
  it('shows a synchronous settings error and clears it after a successful retry', async () => {
    const openSettings = vi
      .fn<() => void | Promise<void>>()
      .mockImplementationOnce(() => {
        throw new Error('options unavailable');
      })
      .mockImplementationOnce(() => undefined);
    const user = userEvent.setup();
    renderApp({ openSettings });
    const button = screen.getByRole('button', { name: 'Open settings' });

    await user.click(button);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'PagePerch could not open settings. Try again.',
    );

    await user.click(button);
    await waitFor(() => {
      expect(
        screen.queryByText('PagePerch could not open settings. Try again.'),
      ).not.toBeInTheDocument();
    });
    expect(openSettings).toHaveBeenCalledTimes(2);
  });

  it('shows a rejected settings request and clears it after a successful retry without an unhandled rejection', async () => {
    const unhandledRejection = vi.fn();
    process.on('unhandledRejection', unhandledRejection);

    try {
      const openSettings = vi
        .fn<() => void | Promise<void>>()
        .mockRejectedValueOnce(new Error('options unavailable'))
        .mockResolvedValueOnce();
      const user = userEvent.setup();
      renderApp({ openSettings });
      const button = screen.getByRole('button', { name: 'Open settings' });

      await user.click(button);
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'PagePerch could not open settings. Try again.',
      );

      await user.click(button);
      await waitFor(() => {
        expect(
          screen.queryByText('PagePerch could not open settings. Try again.'),
        ).not.toBeInTheDocument();
      });
      await Promise.resolve();
      expect(openSettings).toHaveBeenCalledTimes(2);
      expect(unhandledRejection).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandledRejection);
    }
  });
});
