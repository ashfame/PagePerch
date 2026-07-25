import { describe, expect, it, vi } from 'vitest';

import type {
  NoteMutationResult,
  NoteRecordV1,
  NoteService,
} from '../domain/note';
import type { PageIdentity } from '../domain/pageIdentity';
import {
  PAGE_NOTE_SAVE_DEBOUNCE_MS,
  PageNoteDraftController,
  PageNoteDraftPageKeyError,
  PendingPageSaveCoordinator,
  type PageNoteDraftPageContext,
  type PageNoteDraftScheduler,
  type PageNoteDraftState,
} from './pageNoteDraft';

const PAGE_KEY = 'A'.repeat(42) + 'E';
const OTHER_PAGE_KEY = 'B'.repeat(42) + 'I';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

async function settlePromises(): Promise<void> {
  for (let turn = 0; turn < 12; turn += 1) {
    await Promise.resolve();
  }
}

class FakeScheduler implements PageNoteDraftScheduler {
  #now = 0;
  #nextId = 0;
  readonly delays: number[] = [];
  readonly cleared: number[] = [];
  readonly #tasks = new Map<
    number,
    { readonly dueAt: number; readonly callback: () => void }
  >();

  setTimeout(callback: () => void, delayMs: number): number {
    const id = ++this.#nextId;
    this.delays.push(delayMs);
    this.#tasks.set(id, { dueAt: this.#now + delayMs, callback });

    return id;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === 'number' && this.#tasks.delete(handle)) {
      this.cleared.push(handle);
    }
  }

  advanceBy(durationMs: number): void {
    const target = this.#now + durationMs;

    while (true) {
      const next = [...this.#tasks.entries()]
        .filter(([, task]) => task.dueAt <= target)
        .sort(
          ([leftId, left], [rightId, right]) =>
            left.dueAt - right.dueAt || leftId - rightId,
        )[0];

      if (next === undefined) {
        break;
      }

      const [id, task] = next;
      this.#tasks.delete(id);
      this.#now = task.dueAt;
      task.callback();
    }

    this.#now = target;
  }

  get pendingCount(): number {
    return this.#tasks.size;
  }
}

function identity(overrides: Partial<PageIdentity> = {}): PageIdentity {
  return {
    pageKey: PAGE_KEY,
    canonicalUrl: 'https://example.com/guide',
    origin: 'https://example.com',
    pathname: '/guide',
    isRoot: false,
    ...overrides,
  };
}

function pageContext(
  overrides: Partial<PageNoteDraftPageContext> = {},
): PageNoteDraftPageContext {
  return {
    identity: identity(),
    representativeUrl: 'https://example.com/guide?campaign=summer',
    activeTabTitle: 'Guide',
    ...overrides,
  };
}

function noteRecord(overrides: Partial<NoteRecordV1> = {}): NoteRecordV1 {
  return {
    schemaVersion: 1,
    pageKey: PAGE_KEY,
    canonicalUrl: 'https://example.com/guide',
    representativeUrl: 'https://example.com/guide?campaign=summer',
    origin: 'https://example.com',
    title: 'Guide',
    contentHtml: '<!-- wp:paragraph --><p>Cached</p><!-- /wp:paragraph -->',
    contentHash: 'hash',
    savedAt: '2026-07-25T00:00:00.000Z',
    revisionId: 'revision-1',
    ...overrides,
  };
}

function mutationResult(
  overrides: Partial<NoteMutationResult> = {},
): NoteMutationResult {
  return {
    status: 'saved',
    change: 'updated',
    record: noteRecord(),
    ...overrides,
  } as NoteMutationResult;
}

function createHarness(
  options: {
    readonly loadLive?: NoteService['loadLive'];
    readonly saveDraft?: NoteService['saveDraft'];
    readonly clearPage?: NoteService['clearPage'];
    readonly getSettings?: () => Promise<{
      readonly schemaVersion: 1;
      readonly editorMode: 'text-focused-blocks' | 'paragraphs-only';
      readonly showRecentNotesOnOrigin: boolean;
      readonly pageIdentityExclusions: readonly [];
    }>;
    readonly context?: PageNoteDraftPageContext;
    readonly onEmit?: (state: PageNoteDraftState) => void;
  } = {},
) {
  const scheduler = new FakeScheduler();
  const states: PageNoteDraftState[] = [];
  const loadLive = vi.fn(
    options.loadLive ?? (() => Promise.resolve(undefined)),
  );
  const saveDraft = vi.fn(
    options.saveDraft ?? (() => Promise.resolve(mutationResult())),
  );
  const clearPage = vi.fn(
    options.clearPage ??
      (() =>
        Promise.resolve(
          mutationResult({
            status: 'unchanged',
            reason: 'no-record',
          }),
        )),
  );
  const get = vi.fn(
    options.getSettings ??
      (() =>
        Promise.resolve({
          schemaVersion: 1 as const,
          editorMode: 'text-focused-blocks' as const,
          showRecentNotesOnOrigin: false,
          pageIdentityExclusions: [] as const,
        })),
  );
  const controller = new PageNoteDraftController({
    noteService: { loadLive, saveDraft, clearPage },
    settingsRepository: { get },
    pageContext: options.context ?? pageContext(),
    emitState: (state) => {
      states.push(state);
      options.onEmit?.(state);
    },
    scheduler,
  });

  return {
    controller,
    scheduler,
    states,
    loadLive,
    saveDraft,
    clearPage,
    get,
  };
}

async function startReady(
  harness: ReturnType<typeof createHarness>,
): Promise<void> {
  await harness.controller.start();
  expect(harness.states.at(-1)).toMatchObject({
    status: 'ready',
    save: { phase: 'idle' },
  });
}

describe('PageNoteDraftController loading', () => {
  it('loads note and settings concurrently, dedupes starts, and publishes immutable cached state only after both resolve', async () => {
    const note = deferred<NoteRecordV1 | undefined>();
    const settings = deferred<{
      readonly schemaVersion: 1;
      readonly editorMode: 'paragraphs-only';
      readonly showRecentNotesOnOrigin: boolean;
      readonly pageIdentityExclusions: readonly [];
    }>();
    const harness = createHarness({
      loadLive: () => note.promise,
      getSettings: () => settings.promise,
    });

    const first = harness.controller.start();
    const second = harness.controller.start();

    expect(second).toBe(first);
    expect(harness.loadLive).toHaveBeenCalledWith(PAGE_KEY);
    expect(harness.get).toHaveBeenCalledTimes(1);
    expect(harness.states).toEqual([{ status: 'loading' }]);

    note.resolve(noteRecord());
    await settlePromises();
    expect(harness.states).toEqual([{ status: 'loading' }]);

    settings.resolve({
      schemaVersion: 1,
      editorMode: 'paragraphs-only',
      showRecentNotesOnOrigin: false,
      pageIdentityExclusions: [],
    });
    await first;

    const ready = harness.states.at(-1);
    expect(ready).toEqual({
      status: 'ready',
      initialContentHtml:
        '<!-- wp:paragraph --><p>Cached</p><!-- /wp:paragraph -->',
      editorMode: 'paragraphs-only',
      save: { phase: 'idle' },
    });
    expect(Object.isFrozen(ready)).toBe(true);
    expect(ready?.status === 'ready' && Object.isFrozen(ready.save)).toBe(true);
    expect(harness.controller.getState()).toBe(ready);

    await harness.controller.start();
    expect(harness.loadLive).toHaveBeenCalledTimes(1);
    expect(harness.get).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['missing', undefined],
    [
      'logically deleted',
      noteRecord({ deletedAt: '2026-07-25T01:00:00.000Z' }),
    ],
  ])('loads a %s note as empty content', async (_label, record) => {
    const harness = createHarness({
      loadLive: () => Promise.resolve(record),
    });

    await harness.controller.start();

    expect(harness.states.at(-1)).toMatchObject({
      status: 'ready',
      initialContentHtml: '',
    });
  });

  it('turns synchronous load failures into an actionable state, invokes both sources, and dedupes a successful retry', async () => {
    const failure = new Error('storage unavailable');
    let attempt = 0;
    const harness = createHarness({
      loadLive: () => {
        attempt += 1;

        if (attempt === 1) {
          throw failure;
        }

        return Promise.resolve(noteRecord());
      },
    });

    await harness.controller.start();

    expect(harness.get).toHaveBeenCalledTimes(1);
    expect(harness.states.at(-1)).toEqual({
      status: 'load-error',
      error: {
        message:
          'PagePerch could not load this note from local storage. Retry.',
        detail: 'storage unavailable',
      },
    });
    expect(harness.controller.getState()).toBe(harness.states.at(-1));

    const retry = harness.controller.retry();
    const duplicateRetry = harness.controller.retry();
    expect(duplicateRetry).toBe(retry);
    await retry;

    expect(harness.loadLive).toHaveBeenCalledTimes(2);
    expect(harness.get).toHaveBeenCalledTimes(2);
    expect(harness.states.at(-1)?.status).toBe('ready');
  });

  it('rejects unsupported runtime editor settings without publishing ready', async () => {
    const harness = createHarness({
      getSettings: () =>
        Promise.resolve({
          schemaVersion: 1,
          editorMode: 'unknown' as never,
          showRecentNotesOnOrigin: false,
          pageIdentityExclusions: [],
        }),
    });

    await harness.controller.start();

    expect(harness.states.map((state) => state.status)).toEqual([
      'loading',
      'load-error',
    ]);
    expect(harness.states.at(-1)).toMatchObject({
      error: { detail: 'Local settings contain an unsupported editor mode.' },
    });
  });

  it('suppresses late load success and failure emissions after stop', async () => {
    const note = deferred<NoteRecordV1 | undefined>();
    const harness = createHarness({ loadLive: () => note.promise });
    const start = harness.controller.start();

    void harness.controller.stop();
    note.reject(new Error('late failure'));
    await start;

    expect(harness.states).toEqual([{ status: 'loading' }]);
    await expect(harness.controller.retry()).resolves.toBeUndefined();
    expect(harness.loadLive).toHaveBeenCalledTimes(1);
  });
});

describe('PageNoteDraftController persistence', () => {
  it('waits exactly 750ms after the latest edit, emits saving immediately, and saves a cloned execution context', async () => {
    const context = pageContext();
    const harness = createHarness({ context });
    await startReady(harness);

    harness.controller.contentChanged('<p>First</p>');
    expect(harness.states.at(-1)).toMatchObject({
      status: 'ready',
      save: { phase: 'saving' },
    });
    expect(harness.scheduler.delays).toEqual([PAGE_NOTE_SAVE_DEBOUNCE_MS]);

    harness.scheduler.advanceBy(749);
    await settlePromises();
    expect(harness.saveDraft).not.toHaveBeenCalled();

    (context.identity as { canonicalUrl: string }).canonicalUrl =
      'https://attacker.invalid/';
    harness.scheduler.advanceBy(1);
    await settlePromises();

    expect(harness.saveDraft).toHaveBeenCalledWith({
      identity: identity(),
      representativeUrl: 'https://example.com/guide?campaign=summer',
      activeTabTitle: 'Guide',
      contentHtml: '<p>First</p>',
    });
    expect(harness.states.at(-1)).toMatchObject({
      save: { phase: 'saved-locally' },
    });
  });

  it('coalesces unsent edits and restarts the debounce from the latest callback', async () => {
    const harness = createHarness();
    await startReady(harness);

    harness.controller.contentChanged('<p>One</p>');
    harness.scheduler.advanceBy(500);
    harness.controller.contentChanged('<p>Two</p>');
    harness.scheduler.advanceBy(749);
    await settlePromises();

    expect(harness.saveDraft).not.toHaveBeenCalled();
    expect(harness.scheduler.cleared).toHaveLength(1);

    harness.scheduler.advanceBy(1);
    await settlePromises();

    expect(harness.saveDraft).toHaveBeenCalledTimes(1);
    expect(harness.saveDraft.mock.calls[0]?.[0].contentHtml).toBe('<p>Two</p>');
  });

  it('ignores callbacks identical to the loaded or latest editor content', async () => {
    const cached = noteRecord();
    const harness = createHarness({
      loadLive: () => Promise.resolve(cached),
    });
    await startReady(harness);

    harness.controller.contentChanged(cached.contentHtml);
    expect(harness.scheduler.pendingCount).toBe(0);
    expect(harness.states.at(-1)).toMatchObject({
      save: { phase: 'idle' },
    });

    harness.controller.contentChanged('<p>Actual change</p>');
    harness.controller.contentChanged('<p>Actual change</p>');
    expect(harness.scheduler.delays).toEqual([750]);

    harness.scheduler.advanceBy(750);
    await settlePromises();
    expect(harness.saveDraft).toHaveBeenCalledTimes(1);
  });

  it('routes a literal clear of previously cached content through clearPage', async () => {
    const harness = createHarness({
      loadLive: () => Promise.resolve(noteRecord()),
    });
    await startReady(harness);

    harness.controller.contentChanged('');
    harness.scheduler.advanceBy(750);
    await settlePromises();

    expect(harness.clearPage).toHaveBeenCalledTimes(1);
    expect(harness.saveDraft).not.toHaveBeenCalled();
  });

  it('routes a changed empty Gutenberg representation through clearPage', async () => {
    const harness = createHarness();
    await startReady(harness);

    harness.controller.contentChanged(
      '\r\n <!-- wp:paragraph -->\n<p> </p>\n<!-- /wp:paragraph --> ',
    );
    harness.scheduler.advanceBy(750);
    await settlePromises();

    expect(harness.clearPage).toHaveBeenCalledTimes(1);
    expect(harness.saveDraft).not.toHaveBeenCalled();
  });

  it('keeps a rejected clear pending and retries it through clearPage', async () => {
    const failure = new Error('clear failed');
    const harness = createHarness({
      loadLive: () => Promise.resolve(noteRecord()),
      clearPage: vi
        .fn<NoteService['clearPage']>()
        .mockRejectedValueOnce(failure)
        .mockResolvedValueOnce(
          mutationResult({
            status: 'saved',
            change: 'deleted',
          }),
        ),
    });
    await startReady(harness);

    harness.controller.contentChanged('');
    harness.scheduler.advanceBy(750);
    await settlePromises();
    expect(harness.states.at(-1)).toMatchObject({
      save: {
        phase: 'save-error',
        error: { detail: 'clear failed' },
      },
    });

    await harness.controller.retry();
    expect(harness.clearPage).toHaveBeenCalledTimes(2);
    expect(harness.states.at(-1)).toMatchObject({
      save: { phase: 'saved-locally' },
    });
  });

  it('uses normalization only for routing and leaves nonempty content untouched for NoteService', async () => {
    const harness = createHarness();
    const rawContent = '\r\n  <p>Keep service normalization here</p>  \r\n';
    await startReady(harness);

    harness.controller.contentChanged(rawContent);
    harness.scheduler.advanceBy(750);
    await settlePromises();

    expect(harness.saveDraft.mock.calls[0]?.[0].contentHtml).toBe(rawContent);
  });

  it.each<readonly [string, NoteMutationResult]>([
    ['created', mutationResult({ status: 'saved', change: 'created' })],
    ['updated', mutationResult({ status: 'saved', change: 'updated' })],
    ['deleted', mutationResult({ status: 'saved', change: 'deleted' })],
    ['resurrected', mutationResult({ status: 'saved', change: 'resurrected' })],
    ['no-record', mutationResult({ status: 'unchanged', reason: 'no-record' })],
    [
      'unchanged',
      mutationResult({
        status: 'unchanged',
        reason: 'unchanged',
        record: noteRecord(),
      }),
    ],
    [
      'already-deleted',
      mutationResult({
        status: 'unchanged',
        reason: 'already-deleted',
        record: noteRecord({ deletedAt: '2026-07-25T01:00:00.000Z' }),
      }),
    ],
  ])('maps the %s mutation result to saved-locally', async (_label, result) => {
    const harness = createHarness({
      saveDraft: () => Promise.resolve(result),
    });
    await startReady(harness);

    harness.controller.contentChanged('<p>Changed</p>');
    harness.scheduler.advanceBy(750);
    await settlePromises();

    expect(harness.states.at(-1)).toMatchObject({
      save: { phase: 'saved-locally' },
    });
  });

  it('serializes started writes, keeps a newer draft saving after a stale outcome, and persists it when eligible', async () => {
    const first = deferred<NoteMutationResult>();
    const second = deferred<NoteMutationResult>();
    let activeCalls = 0;
    let maximumActiveCalls = 0;
    let callCount = 0;
    const harness = createHarness({
      saveDraft: () => {
        callCount += 1;
        activeCalls += 1;
        maximumActiveCalls = Math.max(maximumActiveCalls, activeCalls);
        const pending = callCount === 1 ? first : second;

        return pending.promise.finally(() => {
          activeCalls -= 1;
        });
      },
    });
    await startReady(harness);

    harness.controller.contentChanged('<p>First</p>');
    harness.scheduler.advanceBy(750);
    await settlePromises();
    harness.controller.contentChanged('<p>Second</p>');
    harness.scheduler.advanceBy(750);
    await settlePromises();

    expect(harness.saveDraft).toHaveBeenCalledTimes(1);

    first.resolve(mutationResult());
    await settlePromises();

    expect(harness.saveDraft).toHaveBeenCalledTimes(2);
    expect(harness.states.at(-1)).toMatchObject({
      save: { phase: 'saving' },
    });
    expect(maximumActiveCalls).toBe(1);

    second.resolve(mutationResult());
    await settlePromises();
    expect(harness.states.at(-1)).toMatchObject({
      save: { phase: 'saved-locally' },
    });
  });

  it('keeps the latest failure pending, coalesces concurrent retry flushes, and remains retryable', async () => {
    const failure = new Error('disk full');
    const retry = deferred<NoteMutationResult>();
    let attempts = 0;
    const harness = createHarness({
      saveDraft: () => {
        attempts += 1;

        return attempts === 1 ? Promise.reject(failure) : retry.promise;
      },
    });
    await startReady(harness);

    harness.controller.contentChanged('<p>Retry me</p>');
    harness.scheduler.advanceBy(750);
    await settlePromises();

    expect(harness.states.at(-1)).toEqual({
      status: 'ready',
      initialContentHtml: '',
      editorMode: 'text-focused-blocks',
      save: {
        phase: 'save-error',
        error: {
          message: 'PagePerch could not save this note locally. Retry.',
          detail: 'disk full',
        },
      },
    });

    const firstRetry = harness.controller.retry();
    const secondRetry = harness.controller.flushPendingSave();
    expect(secondRetry).toBe(firstRetry);
    await settlePromises();
    expect(harness.saveDraft).toHaveBeenCalledTimes(2);

    retry.resolve(mutationResult());
    await firstRetry;
    expect(harness.states.at(-1)).toMatchObject({
      save: { phase: 'saved-locally' },
    });
  });

  it('does not let a stale failure replace a newer saving state', async () => {
    const first = deferred<NoteMutationResult>();
    const harness = createHarness({
      saveDraft: () => first.promise,
    });
    await startReady(harness);

    harness.controller.contentChanged('<p>First</p>');
    harness.scheduler.advanceBy(750);
    await settlePromises();
    harness.controller.contentChanged('<p>Newer</p>');
    first.reject(new Error('old write failed'));
    await settlePromises();

    expect(harness.states.at(-1)).toMatchObject({
      save: { phase: 'saving' },
    });
  });

  it('updates metadata without saving when idle and resaves the latest draft when metadata changes in flight', async () => {
    const first = deferred<NoteMutationResult>();
    const second = deferred<NoteMutationResult>();
    let calls = 0;
    const harness = createHarness({
      saveDraft: () => {
        calls += 1;

        return calls === 1 ? first.promise : second.promise;
      },
    });
    await startReady(harness);

    harness.controller.updatePageContext(
      pageContext({ activeTabTitle: 'New idle title' }),
    );
    harness.scheduler.advanceBy(750);
    await settlePromises();
    expect(harness.saveDraft).not.toHaveBeenCalled();

    harness.controller.contentChanged('<p>Draft</p>');
    harness.scheduler.advanceBy(750);
    await settlePromises();
    expect(harness.saveDraft.mock.calls[0]?.[0].activeTabTitle).toBe(
      'New idle title',
    );

    const nextContext = pageContext({
      activeTabTitle: 'Newest title',
      representativeUrl: 'https://example.com/guide?campaign=autumn',
    });
    harness.controller.updatePageContext(nextContext);
    (nextContext as { activeTabTitle: string }).activeTabTitle = 'Mutated';
    harness.scheduler.advanceBy(750);
    first.resolve(mutationResult());
    await settlePromises();

    expect(harness.saveDraft).toHaveBeenCalledTimes(2);
    expect(harness.saveDraft.mock.calls[1]?.[0]).toMatchObject({
      activeTabTitle: 'Newest title',
      representativeUrl: 'https://example.com/guide?campaign=autumn',
      contentHtml: '<p>Draft</p>',
    });

    second.resolve(mutationResult());
    await settlePromises();
  });

  it('rejects page-key changes before mutating context', async () => {
    const harness = createHarness();
    await startReady(harness);

    expect(() => {
      harness.controller.updatePageContext(
        pageContext({ identity: identity({ pageKey: OTHER_PAGE_KEY }) }),
      );
    }).toThrow(PageNoteDraftPageKeyError);

    harness.controller.contentChanged('<p>Still original</p>');
    await harness.controller.flushPendingSave();
    expect(harness.saveDraft.mock.calls[0]?.[0].identity.pageKey).toBe(
      PAGE_KEY,
    );
  });

  it('flushes after an in-flight predecessor, loops for edits made during flush, and resolves only at the current version', async () => {
    const first = deferred<NoteMutationResult>();
    const second = deferred<NoteMutationResult>();
    let calls = 0;
    const harness = createHarness({
      saveDraft: () => {
        calls += 1;

        return calls === 1 ? first.promise : second.promise;
      },
    });
    await startReady(harness);

    harness.controller.contentChanged('<p>First</p>');
    harness.scheduler.advanceBy(750);
    await settlePromises();

    const flush = harness.controller.flushPendingSave();
    harness.controller.contentChanged('<p>During flush</p>');
    expect(harness.scheduler.pendingCount).toBe(0);

    first.resolve(mutationResult());
    await settlePromises();
    expect(harness.saveDraft).toHaveBeenCalledTimes(2);

    let settled = false;
    void flush.then(() => {
      settled = true;
    });
    await settlePromises();
    expect(settled).toBe(false);

    second.resolve(mutationResult());
    await flush;
    expect(settled).toBe(true);
    expect(harness.saveDraft.mock.calls[1]?.[0].contentHtml).toBe(
      '<p>During flush</p>',
    );
  });

  it('captures an edit made at flush startup without leaving a timer or duplicate write', async () => {
    const harness = createHarness();
    await startReady(harness);

    harness.controller.contentChanged('<p>Before flush</p>');
    const flush = harness.controller.flushPendingSave();
    harness.controller.contentChanged('<p>At flush boundary</p>');

    expect(harness.scheduler.pendingCount).toBe(0);
    await flush;

    expect(harness.saveDraft).toHaveBeenCalledTimes(1);
    expect(harness.saveDraft.mock.calls[0]?.[0].contentHtml).toBe(
      '<p>At flush boundary</p>',
    );
    expect(harness.scheduler.pendingCount).toBe(0);
  });

  it('loops for an edit emitted at the final persistence-settlement boundary', async () => {
    const first = deferred<NoteMutationResult>();
    const second = deferred<NoteMutationResult>();
    let calls = 0;
    let injectBoundaryEdit = true;
    const controllerRef: { current?: PageNoteDraftController } = {};
    const harness = createHarness({
      saveDraft: () => {
        calls += 1;

        return calls === 1 ? first.promise : second.promise;
      },
      onEmit: (state) => {
        if (
          injectBoundaryEdit &&
          state.status === 'ready' &&
          state.save.phase === 'saved-locally'
        ) {
          injectBoundaryEdit = false;
          controllerRef.current?.contentChanged('<p>Settlement boundary</p>');
        }
      },
    });
    const controller = harness.controller;
    controllerRef.current = controller;
    await startReady(harness);

    controller.contentChanged('<p>Before settlement</p>');
    const flush = controller.flushPendingSave();
    await settlePromises();
    first.resolve(mutationResult());
    await settlePromises();

    expect(harness.saveDraft).toHaveBeenCalledTimes(2);
    expect(harness.saveDraft.mock.calls[1]?.[0].contentHtml).toBe(
      '<p>Settlement boundary</p>',
    );

    second.resolve(mutationResult());
    await flush;
    expect(harness.scheduler.pendingCount).toBe(0);
  });

  it('rejects a current flush failure and retries it once without duplicate writes', async () => {
    const failure = new Error('quota');
    const harness = createHarness({
      saveDraft: vi
        .fn<NoteService['saveDraft']>()
        .mockRejectedValueOnce(failure)
        .mockResolvedValueOnce(mutationResult()),
    });
    await startReady(harness);
    harness.controller.contentChanged('<p>Draft</p>');

    const first = harness.controller.flushPendingSave();
    const duplicate = harness.controller.flushPendingSave();
    expect(duplicate).toBe(first);
    await expect(first).rejects.toBe(failure);
    expect(harness.scheduler.pendingCount).toBe(0);

    await expect(
      harness.controller.flushPendingSave(),
    ).resolves.toBeUndefined();
    expect(harness.saveDraft).toHaveBeenCalledTimes(2);
  });

  it('contains emitState throws across edits and fulfilled or failed persistence without an unhandled rejection', async () => {
    const saveFailure = new Error('expected save rejection');
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    let calls = 0;
    const harness = createHarness({
      saveDraft: () => {
        calls += 1;

        return calls === 1
          ? Promise.resolve(mutationResult())
          : Promise.reject(saveFailure);
      },
      onEmit: () => {
        throw new Error('presentation failed');
      },
    });
    process.on('unhandledRejection', onUnhandled);

    try {
      await harness.controller.start();
      expect(() => {
        harness.controller.contentChanged('<p>Fulfilled</p>');
      }).not.toThrow();
      harness.scheduler.advanceBy(750);
      await settlePromises();
      expect(harness.controller.getState()).toMatchObject({
        save: { phase: 'saved-locally' },
      });

      harness.controller.contentChanged('<p>Rejected</p>');
      harness.scheduler.advanceBy(750);
      await settlePromises();
      await new Promise((resolve) => {
        globalThis.setTimeout(resolve, 0);
      });

      expect(harness.controller.getState()).toMatchObject({
        save: {
          phase: 'save-error',
          error: { detail: 'expected save rejection' },
        },
      });
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('stops losslessly by cancelling debounce, flushing immediately, and blocking later edits and emissions', async () => {
    const save = deferred<NoteMutationResult>();
    const harness = createHarness({ saveDraft: () => save.promise });
    await startReady(harness);

    harness.controller.contentChanged('<p>Unsent</p>');
    const stateCount = harness.states.length;
    const stop = harness.controller.stop();
    const duplicateStop = harness.controller.stop();
    const blockedStart = harness.controller.start();
    harness.controller.contentChanged('<p>Rejected after stop</p>');
    harness.controller.updatePageContext(
      pageContext({ activeTabTitle: 'Rejected metadata' }),
    );
    await settlePromises();

    expect(duplicateStop).toBe(stop);
    expect(blockedStart).toBe(stop);
    expect(harness.scheduler.pendingCount).toBe(0);
    expect(harness.saveDraft).toHaveBeenCalledTimes(1);
    expect(harness.saveDraft.mock.calls[0]?.[0]).toMatchObject({
      contentHtml: '<p>Unsent</p>',
      activeTabTitle: 'Guide',
    });
    expect(harness.states).toHaveLength(stateCount);

    save.resolve(mutationResult());
    await stop;
    expect(harness.controller.stop()).toBe(stop);

    harness.controller.contentChanged('<p>Post-settlement</p>');
    harness.scheduler.advanceBy(750);
    await settlePromises();
    expect(harness.saveDraft).toHaveBeenCalledTimes(1);
    expect(harness.states).toHaveLength(stateCount);
  });

  it('drains an in-flight revision and its eligible successor before replacement ownership can save', async () => {
    const first = deferred<NoteMutationResult>();
    const second = deferred<NoteMutationResult>();
    let calls = 0;
    const harness = createHarness({
      saveDraft: () => {
        calls += 1;

        return calls === 1 ? first.promise : second.promise;
      },
    });
    const replacementSave = vi.fn();
    await startReady(harness);

    harness.controller.contentChanged('<p>N</p>');
    harness.scheduler.advanceBy(750);
    await settlePromises();
    harness.controller.contentChanged('<p>N plus one</p>');
    harness.scheduler.advanceBy(750);
    const stop = harness.controller.stop();
    void stop.then(replacementSave);

    expect(harness.saveDraft).toHaveBeenCalledTimes(1);
    expect(replacementSave).not.toHaveBeenCalled();

    first.resolve(mutationResult());
    await settlePromises();
    expect(harness.saveDraft).toHaveBeenCalledTimes(2);
    expect(harness.saveDraft.mock.calls[1]?.[0].contentHtml).toBe(
      '<p>N plus one</p>',
    );
    expect(replacementSave).not.toHaveBeenCalled();

    second.resolve(mutationResult());
    await stop;
    expect(replacementSave).toHaveBeenCalledTimes(1);
  });

  it('keeps a failed stop blocked and retryable without producing an unhandled rejection', async () => {
    const first = deferred<NoteMutationResult>();
    const second = deferred<NoteMutationResult>();
    const failure = new Error('stop failed');
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    let calls = 0;
    const harness = createHarness({
      saveDraft: () => {
        calls += 1;

        return calls === 1 ? first.promise : second.promise;
      },
    });
    await startReady(harness);
    harness.controller.contentChanged('<p>Must survive</p>');
    process.on('unhandledRejection', onUnhandled);

    try {
      void harness.controller.stop();
      await settlePromises();
      first.reject(failure);
      await settlePromises();
      await new Promise((resolve) => {
        globalThis.setTimeout(resolve, 0);
      });

      expect(unhandled).toEqual([]);
      harness.controller.contentChanged('<p>Blocked after failure</p>');
      const retry = harness.controller.stop();
      await settlePromises();
      expect(harness.saveDraft).toHaveBeenCalledTimes(2);
      expect(harness.saveDraft.mock.calls[1]?.[0].contentHtml).toBe(
        '<p>Must survive</p>',
      );

      second.resolve(mutationResult());
      await retry;
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('does not let start resurrect a controller that is stopping during load', async () => {
    const note = deferred<NoteRecordV1 | undefined>();
    const harness = createHarness({ loadLive: () => note.promise });
    const start = harness.controller.start();
    const stop = harness.controller.stop();
    const blockedStart = harness.controller.start();

    expect(blockedStart).toBe(stop);
    note.resolve(noteRecord());
    await Promise.all([start, stop, blockedStart]);
    await settlePromises();

    expect(harness.loadLive).toHaveBeenCalledTimes(1);
    expect(harness.states).toEqual([{ status: 'loading' }]);
    expect(harness.controller.start()).toBe(stop);
  });
});

describe('PendingPageSaveCoordinator', () => {
  it('resolves with no registration and guards StrictMode-like stale unregister calls', async () => {
    const coordinator = new PendingPageSaveCoordinator();
    await expect(coordinator.flushPendingSave()).resolves.toBeUndefined();

    const first = vi.fn(() => Promise.resolve());
    const second = vi.fn(() => Promise.resolve());
    const unregisterFirst = coordinator.register(first);
    const unregisterSecond = coordinator.register(second);
    unregisterFirst();

    await coordinator.flushPendingSave();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);

    unregisterSecond();
    await coordinator.flushPendingSave();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('uses one serial gate that includes a replacement registered during an in-flight flush', async () => {
    const coordinator = new PendingPageSaveCoordinator();
    const first = deferred<void>();
    const second = deferred<void>();
    const firstHandler = vi.fn(() => first.promise);
    const secondHandler = vi.fn(() => second.promise);
    coordinator.register(firstHandler);

    const firstFlush = coordinator.flushPendingSave();
    const duplicate = coordinator.flushPendingSave();
    expect(duplicate).toBe(firstFlush);
    await settlePromises();
    expect(firstHandler).toHaveBeenCalledTimes(1);

    coordinator.register(secondHandler);
    const afterReplacement = coordinator.flushPendingSave();
    expect(afterReplacement).toBe(firstFlush);
    first.resolve();
    await settlePromises();
    expect(secondHandler).toHaveBeenCalledTimes(1);

    let resolved = false;
    void firstFlush.then(() => {
      resolved = true;
    });
    await settlePromises();
    expect(resolved).toBe(false);

    second.resolve();
    await firstFlush;
    expect(resolved).toBe(true);
  });

  it('propagates synchronous throws and asynchronous rejections and retries each registration', async () => {
    const coordinator = new PendingPageSaveCoordinator();
    const syncFailure = new Error('sync');
    const asyncFailure = new Error('async');
    const syncHandler = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => {
        throw syncFailure;
      })
      .mockResolvedValueOnce();
    coordinator.register(syncHandler);

    await expect(coordinator.flushPendingSave()).rejects.toBe(syncFailure);
    await expect(coordinator.flushPendingSave()).resolves.toBeUndefined();
    expect(syncHandler).toHaveBeenCalledTimes(2);

    const asyncHandler = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(asyncFailure)
      .mockResolvedValueOnce();
    coordinator.register(asyncHandler);

    await expect(coordinator.flushPendingSave()).rejects.toBe(asyncFailure);
    await expect(coordinator.flushPendingSave()).resolves.toBeUndefined();
    expect(asyncHandler).toHaveBeenCalledTimes(2);
  });
});
