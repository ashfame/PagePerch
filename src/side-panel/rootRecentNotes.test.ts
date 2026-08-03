import { describe, expect, it, vi } from 'vitest';

import {
  NOTE_SCHEMA_VERSION,
  type NoteRecordV1,
  type NoteService,
} from '../domain/note';
import type { SupportedActivePageSessionState } from './activePageSession';
import {
  DefaultRootRecentNotesIndex,
  type RootRecentNoteChanges,
  type RootRecentNotesState,
} from './rootRecentNotes';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

function rootSession(
  origin = 'https://example.com',
  pageKey = 'R'.repeat(43),
): SupportedActivePageSessionState {
  return {
    status: 'supported',
    tabId: 1,
    representativeUrl: `${origin}/`,
    title: 'Origin root',
    identity: {
      canonicalUrl: `${origin}/`,
      isRoot: true,
      origin,
      pageKey,
      pathname: '/',
    },
  };
}

function nonRootSession(
  canonicalUrl = 'https://example.com/article',
  pageKey = 'N'.repeat(43),
): SupportedActivePageSessionState {
  const url = new URL(canonicalUrl);

  return {
    ...rootSession(url.origin),
    representativeUrl: canonicalUrl,
    identity: {
      ...rootSession(url.origin).identity,
      canonicalUrl,
      isRoot: false,
      pageKey,
      pathname: url.pathname,
    },
  };
}

function note(
  pageKey: string,
  overrides: Partial<NoteRecordV1> = {},
): NoteRecordV1 {
  return {
    schemaVersion: NOTE_SCHEMA_VERSION,
    pageKey,
    canonicalUrl: `https://example.com/${pageKey}`,
    representativeUrl: `https://example.com/${pageKey}?tracking=1`,
    origin: 'https://example.com',
    title: `Note ${pageKey}`,
    contentHtml: '<!-- wp:paragraph --><p>Note</p><!-- /wp:paragraph -->',
    contentHash: 'hash',
    savedAt: '2026-07-25T08:00:00.000Z',
    revisionId: `revision-${pageKey}`,
    ...overrides,
  };
}

function createChanges() {
  const subscriptions: Array<{
    active: boolean;
    listener: () => void;
    origin: string;
    unsubscribe: ReturnType<typeof vi.fn>;
  }> = [];
  const subscribe = vi.fn<RootRecentNoteChanges['subscribe']>(
    (origin, listener) => {
      const subscription = {
        active: true,
        listener,
        origin,
        unsubscribe: vi.fn(),
      };
      subscription.unsubscribe.mockImplementation(() => {
        subscription.active = false;
      });
      subscriptions.push(subscription);

      return subscription.unsubscribe;
    },
  );

  return {
    changes: { subscribe } satisfies RootRecentNoteChanges,
    emit(index: number): void {
      const subscription = subscriptions[index];

      if (subscription?.active) {
        subscription.listener();
      }
    },
    subscribe,
    subscriptions,
  };
}

function createHarness() {
  const listRecentByOrigin = vi.fn<NoteService['listRecentByOrigin']>(() =>
    Promise.resolve([]),
  );
  const changes = createChanges();
  const states: Array<RootRecentNotesState | undefined> = [];
  const index = new DefaultRootRecentNotesIndex(
    { listRecentByOrigin },
    changes.changes,
  );
  const connection = index.connect((state) => {
    states.push(state);
  });

  return {
    changes,
    connection,
    index,
    listRecentByOrigin,
    states,
  };
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 16; turn += 1) {
    await Promise.resolve();
  }
}

function latestReady(
  states: readonly (RootRecentNotesState | undefined)[],
): Extract<RootRecentNotesState, { status: 'ready' }> {
  const state = states.at(-1);

  if (state?.status !== 'ready') {
    throw new Error('Expected the latest recent-note state to be ready.');
  }

  return state;
}

describe('DefaultRootRecentNotesIndex loading', () => {
  it('queries the exact root origin, preserves service order, excludes invalid/current/deleted entries, and publishes immutable snapshots', async () => {
    const harness = createHarness();
    const root = rootSession();
    const first = note('A'.repeat(43), { title: 'First' });
    const second = note('B'.repeat(43), { title: 'Second' });
    const deleted = note('D'.repeat(43), {
      deletedAt: '2026-07-25T09:00:00.000Z',
    });
    const wrongRecordOrigin = note('O'.repeat(43), {
      origin: 'https://other.example',
    });
    const wrongCanonicalOrigin = note('C'.repeat(43), {
      canonicalUrl: 'https://other.example/cross-origin',
    });
    const malformed = note('M'.repeat(43), {
      canonicalUrl: 'not a URL',
    });
    const records = [
      note(root.identity.pageKey),
      first,
      deleted,
      wrongRecordOrigin,
      wrongCanonicalOrigin,
      malformed,
      second,
    ];
    harness.listRecentByOrigin.mockResolvedValueOnce(records);

    harness.connection.setSession(root);
    expect(harness.states.at(-1)).toEqual({
      pageKey: root.identity.pageKey,
      status: 'loading',
    });
    await settle();

    expect(harness.listRecentByOrigin).toHaveBeenCalledOnce();
    expect(harness.listRecentByOrigin).toHaveBeenCalledWith(
      root.identity.origin,
    );
    expect(harness.changes.subscribe).toHaveBeenCalledWith(
      root.identity.origin,
      expect.any(Function),
    );
    const state = latestReady(harness.states);
    expect(state.entries.map((entry) => entry.pageKey)).toEqual([
      first.pageKey,
      second.pageKey,
    ]);
    expect(state.entries[0]).not.toBe(first);
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.entries)).toBe(true);
    expect(Object.isFrozen(state.entries[0])).toBe(true);

    records.reverse();
    (first as { title: string }).title = 'Mutated';
    expect(state.entries.map((entry) => entry.title)).toEqual([
      'First',
      'Second',
    ]);
  });

  it('lists only true same-origin pathname descendants for a non-root page', async () => {
    const harness = createHarness();
    const current = nonRootSession(
      'https://example.com/WordPress/wordpress-playground/pull/4095?view=summary',
    );
    const directChild = note('A'.repeat(43), {
      canonicalUrl:
        'https://example.com/WordPress/wordpress-playground/pull/4095/changes',
      title: 'Changes',
    });
    const deepChild = note('B'.repeat(43), {
      canonicalUrl:
        'https://example.com/WordPress/wordpress-playground/pull/4095/commits/one?diff=split',
      title: 'Commit',
    });
    const samePathQuery = note('Q'.repeat(43), {
      canonicalUrl:
        'https://example.com/WordPress/wordpress-playground/pull/4095?view=files',
    });
    const boundaryCollision = note('C'.repeat(43), {
      canonicalUrl:
        'https://example.com/WordPress/wordpress-playground/pull/40950/changes',
    });
    const sibling = note('S'.repeat(43), {
      canonicalUrl:
        'https://example.com/WordPress/wordpress-playground/pull/4094',
    });
    const crossOrigin = note('O'.repeat(43), {
      canonicalUrl:
        'https://other.example/WordPress/wordpress-playground/pull/4095/changes',
      origin: 'https://other.example',
    });
    const malformed = note('M'.repeat(43), {
      canonicalUrl: 'not a URL',
    });
    const deletedChild = note('D'.repeat(43), {
      canonicalUrl:
        'https://example.com/WordPress/wordpress-playground/pull/4095/deleted',
      deletedAt: '2026-07-25T09:00:00.000Z',
    });
    harness.listRecentByOrigin.mockResolvedValueOnce([
      note(current.identity.pageKey, {
        canonicalUrl: current.identity.canonicalUrl,
      }),
      directChild,
      samePathQuery,
      boundaryCollision,
      deepChild,
      sibling,
      crossOrigin,
      malformed,
      deletedChild,
    ]);

    harness.connection.setSession(current);
    await settle();

    expect(harness.listRecentByOrigin).toHaveBeenCalledWith(
      current.identity.origin,
    );
    expect(harness.changes.subscribe).toHaveBeenCalledWith(
      current.identity.origin,
      expect.any(Function),
    );
    expect(
      latestReady(harness.states).entries.map((entry) => entry.pageKey),
    ).toEqual([directChild.pageKey, deepChild.pageKey]);
  });

  it('lists a lowercase GitHub repository note under its mixed-case organization page', async () => {
    const harness = createHarness();
    const current = {
      ...nonRootSession('https://github.com/automattic'),
      representativeUrl: 'https://github.com/Automattic',
    };
    const repository = note('A'.repeat(43), {
      canonicalUrl: 'https://github.com/automattic/chatrix',
      origin: 'https://github.com',
      representativeUrl: 'https://github.com/automattic/chatrix',
      title: 'Chatrix note',
    });
    const differentlyCasedCurrentPage = note('B'.repeat(43), {
      canonicalUrl: 'https://github.com/Automattic',
      origin: 'https://github.com',
      representativeUrl: 'https://github.com/Automattic',
    });
    harness.listRecentByOrigin.mockResolvedValueOnce([
      differentlyCasedCurrentPage,
      repository,
    ]);

    harness.connection.setSession(current);
    await settle();

    expect(
      latestReady(harness.states).entries.map((entry) => entry.pageKey),
    ).toEqual([repository.pageKey]);
  });

  it('does not query or subscribe without a supported session', async () => {
    const harness = createHarness();

    harness.connection.setSession(undefined);
    await settle();

    expect(harness.listRecentByOrigin).not.toHaveBeenCalled();
    expect(harness.changes.subscribe).not.toHaveBeenCalled();
    expect(harness.states.at(-1)).toBeUndefined();
  });

  it('shows an initial failure and retries both a failed subscription and list', async () => {
    const harness = createHarness();
    harness.changes.subscribe.mockImplementationOnce(() => {
      throw new Error('listener registration failed');
    });
    harness.listRecentByOrigin
      .mockRejectedValueOnce(new Error('list failed'))
      .mockResolvedValueOnce([note('A'.repeat(43))]);

    harness.connection.setSession(rootSession());
    await settle();

    expect(harness.states.at(-1)).toMatchObject({
      status: 'error',
      subscriptionError: true,
    });

    harness.connection.retry();
    await settle();

    expect(harness.changes.subscribe).toHaveBeenCalledTimes(2);
    expect(harness.listRecentByOrigin).toHaveBeenCalledTimes(2);
    expect(latestReady(harness.states)).toMatchObject({
      refreshError: false,
      subscriptionError: false,
    });
  });

  it('treats a non-function subscription cleanup as a retryable subscription failure', async () => {
    const harness = createHarness();
    harness.changes.subscribe.mockReturnValueOnce(undefined as never);
    harness.listRecentByOrigin.mockResolvedValue([note('A'.repeat(43))]);

    harness.connection.setSession(rootSession());
    await settle();

    expect(latestReady(harness.states).subscriptionError).toBe(true);

    harness.connection.retry();
    await settle();

    expect(harness.changes.subscribe).toHaveBeenCalledTimes(2);
    expect(latestReady(harness.states).subscriptionError).toBe(false);
  });

  it('contains an invalid list result as a retryable load failure', async () => {
    const harness = createHarness();
    harness.listRecentByOrigin.mockResolvedValueOnce(null as never);

    harness.connection.setSession(rootSession());
    await settle();

    expect(harness.states.at(-1)?.status).toBe('error');
  });

  it('retains loaded entries through refresh failure and clears the error on retry', async () => {
    const harness = createHarness();
    const first = note('A'.repeat(43));
    const replacement = note('B'.repeat(43));
    harness.listRecentByOrigin
      .mockResolvedValueOnce([first])
      .mockRejectedValueOnce(new Error('refresh failed'))
      .mockResolvedValueOnce([replacement]);
    harness.connection.setSession(rootSession());
    await settle();

    harness.changes.emit(0);
    await settle();

    expect(latestReady(harness.states)).toMatchObject({
      entries: [{ pageKey: first.pageKey }],
      refreshError: true,
      refreshing: false,
    });

    harness.connection.retry();
    expect(latestReady(harness.states)).toMatchObject({
      entries: [{ pageKey: first.pageKey }],
      refreshError: false,
      refreshing: true,
    });
    await settle();

    expect(latestReady(harness.states)).toMatchObject({
      entries: [{ pageKey: replacement.pageKey }],
      refreshError: false,
      refreshing: false,
    });
  });
});

describe('DefaultRootRecentNotesIndex concurrency and lifecycle', () => {
  it('coalesces change/retry bursts and never publishes a late older load', async () => {
    const harness = createHarness();
    const older = deferred<readonly NoteRecordV1[]>();
    const newer = deferred<readonly NoteRecordV1[]>();
    harness.listRecentByOrigin
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    harness.connection.setSession(rootSession());
    await settle();

    harness.changes.emit(0);
    harness.changes.emit(0);
    harness.connection.retry();
    expect(harness.listRecentByOrigin).toHaveBeenCalledOnce();

    older.resolve([note('A'.repeat(43))]);
    await settle();

    expect(harness.listRecentByOrigin).toHaveBeenCalledTimes(2);
    expect(
      harness.states.some(
        (state) =>
          state?.status === 'ready' &&
          state.entries[0]?.pageKey === 'A'.repeat(43),
      ),
    ).toBe(false);

    newer.resolve([note('B'.repeat(43))]);
    await settle();

    expect(latestReady(harness.states).entries[0]?.pageKey).toBe(
      'B'.repeat(43),
    );
  });

  it('discards a late old-root load and tears down before loading the replacement root', async () => {
    const harness = createHarness();
    const oldLoad = deferred<readonly NoteRecordV1[]>();
    const newLoad = deferred<readonly NoteRecordV1[]>();
    harness.listRecentByOrigin
      .mockReturnValueOnce(oldLoad.promise)
      .mockReturnValueOnce(newLoad.promise);
    const oldRoot = rootSession('https://old.example', 'O'.repeat(43));
    const newRoot = rootSession('https://new.example', 'N'.repeat(43));

    harness.connection.setSession(oldRoot);
    await settle();
    harness.connection.setSession(newRoot);
    await settle();

    expect(
      harness.changes.subscriptions[0]?.unsubscribe,
    ).toHaveBeenCalledOnce();
    expect(harness.listRecentByOrigin).toHaveBeenNthCalledWith(
      2,
      newRoot.identity.origin,
    );

    oldLoad.resolve([
      note('A'.repeat(43), {
        canonicalUrl: `${oldRoot.identity.origin}/old`,
        origin: oldRoot.identity.origin,
      }),
    ]);
    await settle();
    expect(harness.states.at(-1)).toMatchObject({
      pageKey: newRoot.identity.pageKey,
      status: 'loading',
    });

    newLoad.resolve([
      note('B'.repeat(43), {
        canonicalUrl: `${newRoot.identity.origin}/new`,
        origin: newRoot.identity.origin,
      }),
    ]);
    await settle();
    expect(latestReady(harness.states)).toMatchObject({
      pageKey: newRoot.identity.pageKey,
      entries: [{ pageKey: 'B'.repeat(43) }],
    });
  });

  it('stops idempotently, suppresses stale change signals, and tolerates removal failure', async () => {
    const harness = createHarness();
    harness.connection.setSession(rootSession());
    await settle();
    const subscription = harness.changes.subscriptions[0];
    subscription?.unsubscribe.mockImplementationOnce(() => {
      subscription.active = false;
      throw new Error('listener removal failed');
    });

    harness.connection.disconnect();
    await settle();
    harness.connection.disconnect();
    subscription?.listener();
    await settle();

    expect(subscription?.unsubscribe).toHaveBeenCalledOnce();
    expect(harness.listRecentByOrigin).toHaveBeenCalledOnce();
  });

  it('reuses one logical root cycle through a StrictMode-style immediate reconnect', async () => {
    const harness = createHarness();
    harness.connection.setSession(rootSession());
    await settle();
    harness.connection.disconnect();
    const secondStates: Array<RootRecentNotesState | undefined> = [];
    const secondConnection = harness.index.connect((state) => {
      secondStates.push(state);
    });
    secondConnection.setSession(rootSession());
    await settle();

    expect(harness.listRecentByOrigin).toHaveBeenCalledOnce();
    expect(harness.changes.subscribe).toHaveBeenCalledOnce();
    expect(
      harness.changes.subscriptions[0]?.unsubscribe,
    ).not.toHaveBeenCalled();
    expect(secondStates.at(-1)?.status).toBe('ready');
  });
});
