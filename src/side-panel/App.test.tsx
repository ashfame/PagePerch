import { StrictMode, type ComponentType } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type {
  ActivePageSessionState,
  SupportedActivePageSessionState,
} from './activePageSession';
import { SidePanelApp, type CreateActivePageSessionController } from './App';
import type { PageNoteEditorProps } from './PageNoteEditor';
import type {
  PageNoteDraftPageContext,
  PageNoteDraftState,
} from './pageNoteDraft';
import {
  DefaultPageNoteOwnership,
  type CreatePageNoteDraftRuntime,
  type PageNoteDraftRuntime,
  type RegisterPendingPageSave,
} from './pageNoteOwnership';

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

class FakeDraftRuntime implements PageNoteDraftRuntime {
  state: PageNoteDraftState = { status: 'loading' };
  readonly getState = vi.fn(() => this.state);
  readonly retry = vi.fn(() => Promise.resolve());
  readonly contentChanged = vi.fn();
  readonly updatePageContext = vi.fn((context: PageNoteDraftPageContext) => {
    this.context = context;
  });
  readonly flushPendingSave = vi.fn(() => Promise.resolve());
  readonly stop = vi.fn(() => Promise.resolve());
  readonly start = vi.fn(() => {
    this.emit(this.state);

    return Promise.resolve();
  });

  constructor(
    public context: PageNoteDraftPageContext,
    private readonly emitState: (state: PageNoteDraftState) => void,
  ) {}

  emit(state: PageNoteDraftState): void {
    this.state = state;
    this.emitState(state);
  }
}

function FakeEditor({
  initialContentHtml,
  editorMode,
  onContentChange,
  onLoading,
  onReady,
  onError,
}: PageNoteEditorProps) {
  return (
    <div
      data-testid="fake-page-note-editor"
      data-content={initialContentHtml}
      data-mode={editorMode}
    >
      <button
        type="button"
        onClick={() => {
          onContentChange('<p>Changed in editor</p>');
        }}
      >
        Change editor content
      </button>
      <button type="button" onClick={onLoading}>
        Editor loading
      </button>
      <button type="button" onClick={onReady}>
        Editor ready
      </button>
      <button
        type="button"
        onClick={() => {
          onError(new Error('editor failed'));
        }}
      >
        Editor error
      </button>
    </div>
  );
}

interface DraftTestPorts {
  readonly ownership: DefaultPageNoteOwnership;
  readonly createDraftRuntime: ReturnType<
    typeof vi.fn<CreatePageNoteDraftRuntime>
  >;
  readonly registerPendingSave: ReturnType<
    typeof vi.fn<RegisterPendingPageSave>
  >;
  readonly Editor: ComponentType<PageNoteEditorProps>;
  readonly drafts: FakeDraftRuntime[];
  readonly pendingHandlers: Array<() => Promise<void>>;
  readonly unregisters: ReturnType<typeof vi.fn>[];
  readonly currentPendingHandler: () => (() => Promise<void>) | undefined;
}

function createDraftTestPorts(options?: {
  readonly createDraftRuntime?: CreatePageNoteDraftRuntime;
  readonly registerPendingSave?: RegisterPendingPageSave;
  readonly Editor?: ComponentType<PageNoteEditorProps>;
}): DraftTestPorts {
  const drafts: FakeDraftRuntime[] = [];
  const pendingHandlers: Array<() => Promise<void>> = [];
  const unregisters: ReturnType<typeof vi.fn>[] = [];
  const pendingRegistration: {
    current?: () => Promise<void>;
  } = {};
  const createDraftRuntime = vi.fn<CreatePageNoteDraftRuntime>(
    options?.createDraftRuntime ??
      ((context, emitState) => {
        const draft = new FakeDraftRuntime(context, emitState);
        drafts.push(draft);

        return draft;
      }),
  );
  const registerPendingSave = vi.fn<RegisterPendingPageSave>(
    options?.registerPendingSave ??
      ((handler) => {
        pendingHandlers.push(handler);
        pendingRegistration.current = handler;
        const unregister = vi.fn(() => {
          if (pendingRegistration.current === handler) {
            pendingRegistration.current = undefined;
          }
        });
        unregisters.push(unregister);

        return unregister;
      }),
  );

  return {
    ownership: new DefaultPageNoteOwnership(
      createDraftRuntime,
      registerPendingSave,
    ),
    createDraftRuntime,
    registerPendingSave,
    Editor: options?.Editor ?? FakeEditor,
    drafts,
    pendingHandlers,
    unregisters,
    currentPendingHandler: () => pendingRegistration.current,
  };
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
    readonly draftPorts?: DraftTestPorts;
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
  const draftPorts = options.draftPorts ?? createDraftTestPorts();
  const app = (
    <SidePanelApp
      createController={createController}
      draftOwnership={draftPorts.ownership}
      Editor={draftPorts.Editor}
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
    ...draftPorts,
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

async function settleReact(): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < 12; turn += 1) {
      await Promise.resolve();
    }
  });
}

function readyDraftState(
  overrides: Partial<Extract<PageNoteDraftState, { status: 'ready' }>> = {},
): Extract<PageNoteDraftState, { status: 'ready' }> {
  return {
    status: 'ready',
    initialContentHtml: '<p>Cached note</p>',
    editorMode: 'text-focused-blocks',
    save: { phase: 'idle' },
    ...overrides,
  };
}

function emitDraft(draft: FakeDraftRuntime, state: PageNoteDraftState): void {
  act(() => {
    draft.emit(state);
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
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
        /editor safeguards, page identity behavior, and local storage boundaries/u,
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

  it('renders a supported page shell with title, canonical context, and cached-note loading status', () => {
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
    expect(screen.getByRole('status')).toHaveTextContent('Loading cached note');
    expect(
      screen.queryByText(/editor is not connected yet/u),
    ).not.toBeInTheDocument();
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

describe('SidePanelApp local note composition', () => {
  it('waits for cached note and settings state before mounting the editor and wires editor content', async () => {
    const user = userEvent.setup();
    const { controller, drafts, createDraftRuntime, registerPendingSave } =
      renderApp();

    emit(controller, supportedSession());
    await settleReact();

    expect(createDraftRuntime).toHaveBeenCalledOnce();
    expect(registerPendingSave).toHaveBeenCalledOnce();
    expect(drafts[0]?.start).toHaveBeenCalledOnce();
    expect(screen.getByRole('status')).toHaveTextContent('Loading cached note');
    expect(
      screen.queryByTestId('fake-page-note-editor'),
    ).not.toBeInTheDocument();

    const draft = drafts[0];
    if (draft === undefined) {
      throw new Error('Expected the supported page draft runtime.');
    }

    emitDraft(
      draft,
      readyDraftState({
        initialContentHtml: '<p>Stored locally</p>',
        editorMode: 'paragraphs-only',
      }),
    );

    expect(screen.getByTestId('fake-page-note-editor')).toHaveAttribute(
      'data-content',
      '<p>Stored locally</p>',
    );
    expect(screen.getByTestId('fake-page-note-editor')).toHaveAttribute(
      'data-mode',
      'paragraphs-only',
    );

    await user.click(
      screen.getByRole('button', { name: 'Change editor content' }),
    );
    expect(draft.contentChanged).toHaveBeenCalledWith(
      '<p>Changed in editor</p>',
    );
  });

  it('renders exact live save states and retries an actionable local save error', async () => {
    const user = userEvent.setup();
    const { controller, drafts } = renderApp();
    emit(controller, supportedSession());
    await settleReact();
    const draft = drafts[0];

    if (draft === undefined) {
      throw new Error('Expected the supported page draft runtime.');
    }

    emitDraft(draft, readyDraftState({ save: { phase: 'saving' } }));
    expect(screen.getByRole('status')).toHaveTextContent(/^Saving$/u);

    emitDraft(draft, readyDraftState({ save: { phase: 'saved-locally' } }));
    expect(screen.getByRole('status')).toHaveTextContent(/^Saved locally$/u);

    emitDraft(
      draft,
      readyDraftState({
        save: {
          phase: 'save-error',
          error: {
            message: 'PagePerch could not save this note locally. Retry.',
          },
        },
      }),
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'could not save this note locally',
    );

    await user.click(screen.getByRole('button', { name: 'Retry saving note' }));
    expect(draft.retry).toHaveBeenCalledOnce();
  });

  it('renders an actionable cached-note load error and observes its retry', async () => {
    const user = userEvent.setup();
    const { controller, drafts } = renderApp();
    emit(controller, supportedSession());
    await settleReact();
    const draft = drafts[0];

    if (draft === undefined) {
      throw new Error('Expected the supported page draft runtime.');
    }

    emitDraft(draft, {
      status: 'load-error',
      error: {
        message:
          'PagePerch could not load this note from local storage. Retry.',
      },
    });

    expect(screen.getByRole('alert')).toHaveTextContent(
      'could not load this note from local storage',
    );
    expect(
      screen.queryByTestId('fake-page-note-editor'),
    ).not.toBeInTheDocument();

    await user.click(
      screen.getByRole('button', { name: 'Retry loading note' }),
    );
    expect(draft.retry).toHaveBeenCalledOnce();
  });

  it('uses editor callbacks for error feedback without duplicating the editor loading announcement or claiming a save', async () => {
    const user = userEvent.setup();
    const { controller, drafts } = renderApp();
    emit(controller, supportedSession());
    await settleReact();
    const draft = drafts[0];

    if (draft === undefined) {
      throw new Error('Expected the supported page draft runtime.');
    }

    emitDraft(draft, readyDraftState());
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Editor loading' }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByText('Saved locally')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Editor error' }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'could not open the local note editor',
    );
    expect(draft.contentChanged).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Editor ready' }));
    expect(
      screen.queryByText(/could not open the local note editor/u),
    ).not.toBeInTheDocument();
  });

  it('updates same-key metadata without remounting or reloading the editor owner', async () => {
    const { controller, drafts, createDraftRuntime, registerPendingSave } =
      renderApp();
    emit(controller, supportedSession());
    await settleReact();
    const draft = drafts[0];

    if (draft === undefined) {
      throw new Error('Expected the supported page draft runtime.');
    }

    emitDraft(draft, readyDraftState());
    const editor = screen.getByTestId('fake-page-note-editor');

    emit(
      controller,
      supportedSession({
        representativeUrl: 'https://example.com/path?a=1#new',
        title: 'Updated same page',
      }),
    );
    await settleReact();

    expect(screen.getByTestId('fake-page-note-editor')).toBe(editor);
    expect(createDraftRuntime).toHaveBeenCalledOnce();
    expect(registerPendingSave).toHaveBeenCalledOnce();
    expect(draft.start).toHaveBeenCalledOnce();
    expect(draft.updatePageContext).toHaveBeenCalledWith(
      expect.objectContaining({
        representativeUrl: 'https://example.com/path?a=1#new',
        activeTabTitle: 'Updated same page',
      }),
    );
  });

  it('awaits lossless old-owner stop and unregister before creating a different page owner', async () => {
    const stop = deferred<void>();
    const runtimes: FakeDraftRuntime[] = [];
    const createDraftRuntime: CreatePageNoteDraftRuntime = (
      context,
      emitState,
    ) => {
      const runtime = new FakeDraftRuntime(context, emitState);
      if (runtimes.length === 0) {
        runtime.stop.mockReturnValue(stop.promise);
      }
      runtimes.push(runtime);

      return runtime;
    };
    const draftPorts = createDraftTestPorts({ createDraftRuntime });
    const { controller } = renderApp({ draftPorts });
    emit(controller, supportedSession());
    await settleReact();
    const first = runtimes[0];

    if (first === undefined) {
      throw new Error('Expected the first page owner.');
    }

    const firstFlush = deferred<void>();
    first.flushPendingSave.mockReturnValueOnce(firstFlush.promise);
    const firstHandler = draftPorts.currentPendingHandler();
    if (firstHandler === undefined) {
      throw new Error('Expected the first pending-save registration.');
    }
    const forwardedFirstFlush = firstHandler();
    expect(forwardedFirstFlush).toBe(firstFlush.promise);
    expect(first.flushPendingSave).toHaveBeenCalledOnce();
    firstFlush.resolve();
    await forwardedFirstFlush;

    emitDraft(first, readyDraftState());
    emit(
      controller,
      supportedSession({
        title: 'Second page',
        representativeUrl: 'https://example.com/second',
        identity: {
          canonicalUrl: 'https://example.com/second',
          isRoot: false,
          origin: 'https://example.com',
          pageKey: 'B'.repeat(43),
          pathname: '/second',
        },
      }),
    );
    await settleReact();

    expect(first.stop).toHaveBeenCalledOnce();
    expect(runtimes).toHaveLength(1);
    expect(draftPorts.unregisters[0]).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('Loading cached note');

    emitDraft(
      first,
      readyDraftState({
        initialContentHtml: '<p>Stale first owner</p>',
      }),
    );
    expect(
      screen.queryByText('<p>Stale first owner</p>'),
    ).not.toBeInTheDocument();

    stop.resolve();
    await settleReact();

    expect(draftPorts.unregisters[0]).toHaveBeenCalledOnce();
    expect(runtimes).toHaveLength(2);
    const second = runtimes[1];
    expect(second?.start).toHaveBeenCalledOnce();
    const secondHandler = draftPorts.currentPendingHandler();
    expect(secondHandler).toBeDefined();
    expect(secondHandler).not.toBe(firstHandler);
    await secondHandler?.();
    expect(second?.flushPendingSave).toHaveBeenCalledOnce();
    expect(first.flushPendingSave).toHaveBeenCalledOnce();
  });

  it('keeps the retained page owner mounted when the outer session reports a pending-flush error', async () => {
    const { controller, drafts } = renderApp();
    emit(controller, supportedSession());
    await settleReact();
    const draft = drafts[0];

    if (draft === undefined) {
      throw new Error('Expected the supported page draft runtime.');
    }

    emitDraft(draft, readyDraftState());
    const editor = screen.getByTestId('fake-page-note-editor');
    emit(controller, {
      status: 'error',
      reason: 'pending-save-flush-failed',
      message: 'Save the previous note before switching pages.',
      tabId: 2,
    });
    await settleReact();

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Save the previous note before switching pages.',
    );
    expect(screen.getByTestId('fake-page-note-editor')).toBe(editor);
    expect(draft.stop).not.toHaveBeenCalled();
  });

  it('creates, starts, and registers one logical draft runtime through StrictMode and stops before unregistering on unmount', async () => {
    const {
      controller,
      drafts,
      createDraftRuntime,
      registerPendingSave,
      unregisters,
      unmount,
    } = renderApp({ strict: true });
    emit(controller, supportedSession());
    await settleReact();

    expect(createDraftRuntime).toHaveBeenCalledOnce();
    expect(registerPendingSave).toHaveBeenCalledOnce();
    expect(drafts[0]?.start).toHaveBeenCalledOnce();

    unmount();
    await settleReact();
    expect(drafts[0]?.stop).toHaveBeenCalledOnce();
    expect(unregisters[0]).toHaveBeenCalledOnce();
    expect(drafts[0]?.stop.mock.invocationCallOrder[0]).toBeLessThan(
      unregisters[0]?.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('recovers from draft factory, registration, and start failures without throwing the tree', async () => {
    const user = userEvent.setup();
    const created: FakeDraftRuntime[] = [];
    let factoryAttempts = 0;
    const createDraftRuntime: CreatePageNoteDraftRuntime = (
      context,
      emitState,
    ) => {
      factoryAttempts += 1;
      if (factoryAttempts === 1) {
        throw new Error('factory failed');
      }

      const runtime = new FakeDraftRuntime(context, emitState);
      created.push(runtime);

      return runtime;
    };
    const factoryPorts = createDraftTestPorts({ createDraftRuntime });
    const factoryApp = renderApp({ draftPorts: factoryPorts });
    emit(factoryApp.controller, supportedSession());
    await settleReact();

    expect(screen.getByRole('alert')).toHaveTextContent(
      'could not prepare this local note',
    );
    await user.click(screen.getByRole('button', { name: 'Retry local note' }));
    await settleReact();
    expect(factoryPorts.createDraftRuntime).toHaveBeenCalledTimes(2);
    factoryApp.unmount();
    await settleReact();

    let registrationAttempts = 0;
    const registrationPorts = createDraftTestPorts({
      registerPendingSave: () => {
        registrationAttempts += 1;
        if (registrationAttempts === 1) {
          throw new Error('registration failed');
        }

        return vi.fn();
      },
    });
    const registrationApp = renderApp({ draftPorts: registrationPorts });
    emit(registrationApp.controller, supportedSession());
    await settleReact();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'could not prepare this local note',
    );
    expect(registrationPorts.drafts[0]?.stop).toHaveBeenCalledOnce();

    await user.click(screen.getByRole('button', { name: 'Retry local note' }));
    await settleReact();
    expect(registrationPorts.createDraftRuntime).toHaveBeenCalledTimes(2);
    registrationApp.unmount();
    await settleReact();

    let startAttempts = 0;
    const startRuntimes: FakeDraftRuntime[] = [];
    const startPorts = createDraftTestPorts({
      createDraftRuntime: (context, emitState) => {
        const runtime = new FakeDraftRuntime(context, emitState);
        startAttempts += 1;
        if (startAttempts === 1) {
          runtime.start.mockRejectedValue(new Error('start failed'));
        }
        startRuntimes.push(runtime);

        return runtime;
      },
    });
    const startApp = renderApp({ draftPorts: startPorts });
    emit(startApp.controller, supportedSession());
    await settleReact();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'could not prepare this local note',
    );
    expect(startRuntimes[0]?.stop).toHaveBeenCalledOnce();

    await user.click(screen.getByRole('button', { name: 'Retry local note' }));
    await settleReact();
    expect(startPorts.createDraftRuntime).toHaveBeenCalledTimes(2);
  });

  it('retries failed stop and unregister teardown without reusing an invalid owner', async () => {
    const user = userEvent.setup();
    const runtimes: FakeDraftRuntime[] = [];
    let stopAttempts = 0;
    const createDraftRuntime: CreatePageNoteDraftRuntime = (
      context,
      emitState,
    ) => {
      const runtime = new FakeDraftRuntime(context, emitState);
      if (runtimes.length === 0) {
        runtime.stop.mockImplementation(() => {
          stopAttempts += 1;

          return stopAttempts === 1
            ? Promise.reject(new Error('stop failed'))
            : Promise.resolve();
        });
      }
      runtimes.push(runtime);

      return runtime;
    };
    let unregisterAttempts = 0;
    const firstUnregister = vi.fn(() => {
      unregisterAttempts += 1;
      if (unregisterAttempts === 1) {
        throw new Error('unregister failed');
      }
    });
    const registerPendingSave: RegisterPendingPageSave = vi
      .fn()
      .mockReturnValueOnce(firstUnregister)
      .mockReturnValue(vi.fn());
    const draftPorts = createDraftTestPorts({
      createDraftRuntime,
      registerPendingSave,
    });
    const { controller } = renderApp({ draftPorts });
    emit(controller, supportedSession());
    await settleReact();

    emit(
      controller,
      supportedSession({
        title: 'Replacement after failures',
        identity: {
          ...supportedSession().identity,
          canonicalUrl: 'https://example.com/replacement',
          pageKey: 'C'.repeat(43),
          pathname: '/replacement',
        },
      }),
    );
    await settleReact();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'could not finish saving the previous local note',
    );

    await user.click(screen.getByRole('button', { name: 'Retry local note' }));
    await settleReact();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'could not prepare this local note',
    );
    expect(runtimes).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Retry local note' }));
    await settleReact();
    expect(firstUnregister).toHaveBeenCalledTimes(2);
    expect(runtimes).toHaveLength(2);
    expect(runtimes[1]?.start).toHaveBeenCalledOnce();
  });

  it('republishes the same owner after a transient getState failure', async () => {
    const user = userEvent.setup();
    let runtime: FakeDraftRuntime | undefined;
    const draftPorts = createDraftTestPorts({
      createDraftRuntime: (context, emitState) => {
        runtime = new FakeDraftRuntime(context, emitState);
        runtime.getState
          .mockImplementationOnce(() => {
            throw new Error('state unavailable');
          })
          .mockImplementation(() => runtime?.state ?? { status: 'loading' });

        return runtime;
      },
    });
    const { controller } = renderApp({ draftPorts });
    emit(controller, supportedSession());
    await settleReact();

    expect(screen.getByRole('alert')).toHaveTextContent(
      'could not prepare this local note',
    );
    await user.click(screen.getByRole('button', { name: 'Retry local note' }));
    await settleReact();

    expect(draftPorts.createDraftRuntime).toHaveBeenCalledOnce();
    expect(runtime?.start).toHaveBeenCalledOnce();
    expect(screen.getByRole('status')).toHaveTextContent('Loading cached note');
  });

  it('recovers a getState failure after same-key metadata update without replacing the owner', async () => {
    const user = userEvent.setup();
    const { controller, drafts, createDraftRuntime } = renderApp();
    emit(controller, supportedSession());
    await settleReact();
    const runtime = drafts[0];

    if (runtime === undefined) {
      throw new Error('Expected the supported page draft runtime.');
    }

    runtime.getState.mockImplementationOnce(() => {
      throw new Error('state unavailable after metadata');
    });
    emit(
      controller,
      supportedSession({
        title: 'Metadata changed',
        representativeUrl: 'https://example.com/path?a=1#metadata',
      }),
    );
    await settleReact();

    expect(screen.getByRole('alert')).toHaveTextContent(
      'could not prepare this local note',
    );
    await user.click(screen.getByRole('button', { name: 'Retry local note' }));
    await settleReact();

    expect(createDraftRuntime).toHaveBeenCalledOnce();
    expect(runtime.start).toHaveBeenCalledOnce();
    expect(runtime.updatePageContext).toHaveBeenCalledOnce();
    expect(screen.getByRole('status')).toHaveTextContent('Loading cached note');
  });

  it('observes rejected retry callbacks after navigation without stale updates or unhandled rejections', async () => {
    const user = userEvent.setup();
    const retry = deferred<void>();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);

    try {
      const { controller, drafts } = renderApp();
      emit(controller, supportedSession());
      await settleReact();
      const draft = drafts[0];

      if (draft === undefined) {
        throw new Error('Expected the supported page draft runtime.');
      }

      draft.retry.mockReturnValue(retry.promise);
      emitDraft(draft, {
        status: 'load-error',
        error: {
          message:
            'PagePerch could not load this note from local storage. Retry.',
        },
      });
      await user.click(
        screen.getByRole('button', { name: 'Retry loading note' }),
      );

      emit(
        controller,
        supportedSession({
          title: 'Navigated page',
          identity: {
            ...supportedSession().identity,
            canonicalUrl: 'https://example.com/navigated',
            pageKey: 'D'.repeat(43),
            pathname: '/navigated',
          },
        }),
      );
      retry.reject(new Error('late retry failure'));
      await settleReact();

      expect(
        screen.queryByText(
          'PagePerch could not prepare this local note. Retry.',
        ),
      ).not.toBeInTheDocument();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
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
    const draftPorts = createDraftTestPorts();
    const { rerender } = render(
      <SidePanelApp
        createController={firstFactory}
        draftOwnership={draftPorts.ownership}
        Editor={draftPorts.Editor}
        openSettings={openSettings}
      />,
    );

    if (firstController === undefined) {
      throw new Error('Expected the first controller to be created.');
    }

    rerender(
      <SidePanelApp
        createController={secondFactory}
        draftOwnership={draftPorts.ownership}
        Editor={draftPorts.Editor}
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

    const draftPorts = createDraftTestPorts();
    render(
      <SidePanelApp
        createController={createController}
        draftOwnership={draftPorts.ownership}
        Editor={draftPorts.Editor}
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

    const draftPorts = createDraftTestPorts();
    render(
      <SidePanelApp
        createController={createController}
        draftOwnership={draftPorts.ownership}
        Editor={draftPorts.Editor}
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

    const draftPorts = createDraftTestPorts();
    render(
      <SidePanelApp
        createController={createController}
        draftOwnership={draftPorts.ownership}
        Editor={draftPorts.Editor}
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
    const draftPorts = createDraftTestPorts();
    const firstMount = render(
      <SidePanelApp
        createController={createController}
        draftOwnership={draftPorts.ownership}
        Editor={draftPorts.Editor}
        openSettings={vi.fn()}
      />,
    );
    const firstController = controllers[0];

    firstMount.unmount();
    const secondMount = render(
      <SidePanelApp
        createController={createController}
        draftOwnership={draftPorts.ownership}
        Editor={draftPorts.Editor}
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
