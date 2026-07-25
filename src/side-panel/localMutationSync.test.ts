import { describe, expect, it, vi } from 'vitest';

import type { NoteRecordV1 } from '../domain/note';
import {
  createLocalMutationSyncObserver,
  type LocalMutationSyncDependencies,
} from './localMutationSync';

const NOW = '2026-07-25T12:00:00.000Z';
const RECORD: NoteRecordV1 = {
  schemaVersion: 1,
  pageKey: 'A'.repeat(43),
  canonicalUrl: 'https://example.com/page',
  representativeUrl: 'https://example.com/page',
  origin: 'https://example.com',
  title: 'Private note title',
  contentHtml: '<!-- wp:paragraph --><p>Private body</p><!-- /wp:paragraph -->',
  contentHash: `${'H'.repeat(42)}U`,
  savedAt: NOW,
  revisionId: 'revision-a',
};

function harness(overrides: Partial<LocalMutationSyncDependencies> = {}) {
  const events: string[] = [];
  const get = vi.fn(() =>
    Promise.resolve({
      schemaVersion: 1 as const,
      editorMode: 'text-focused-blocks' as const,
      pageIdentityExclusions: [],
      byosConnection: {
        accessToken: 'oauth-token',
        connectedAt: '2026-07-25T10:00:00.000Z',
        expiresAt: '2026-07-25T13:00:00.000Z',
      },
    }),
  );
  const enqueue = vi.fn(() => {
    events.push('enqueue');
    return Promise.resolve({
      pageKey: RECORD.pageKey,
      revisionId: RECORD.revisionId,
      attemptCount: 0,
      nextAttemptAt: NOW,
    });
  });
  const request = vi.fn(() => {
    events.push('message');
    return Promise.resolve({
      status: 'synced' as const,
      uploaded: 1,
      downloaded: 0,
      unchanged: 0,
      conflicts: 0,
      failed: 0,
      pending: 0,
    });
  });
  const dependencies: LocalMutationSyncDependencies = {
    config: { clientId: 'public-client', enabled: true },
    settings: { get },
    queue: { enqueue },
    messages: { request },
    ...overrides,
  };

  return {
    dependencies,
    enqueue,
    events,
    get,
    observer: createLocalMutationSyncObserver(dependencies),
    request,
  };
}

describe('local mutation sync observer', () => {
  it('checks a usable connection, durably enqueues the revision, then messages the worker', async () => {
    const test = harness();

    await test.observer(RECORD);

    expect(test.enqueue).toHaveBeenCalledWith(
      RECORD.pageKey,
      RECORD.revisionId,
    );
    expect(test.request).toHaveBeenCalledWith('local-mutation');
    expect(test.events).toEqual(['enqueue', 'message']);
  });

  it('leaves the durable queue successful when worker messaging fails', async () => {
    const request = vi.fn(() =>
      Promise.reject(
        new Error('oauth token URL title https://private.example'),
      ),
    );
    const test = harness({ messages: { request } });

    await expect(test.observer(RECORD)).resolves.toBeUndefined();
    expect(test.enqueue).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledOnce();
  });

  it('does not wait for remote synchronization after the durable queue write', async () => {
    const request = vi.fn(
      () =>
        new Promise<never>(() => {
          // A worker request may remain open for the duration of network synchronization.
        }),
    );
    const test = harness({ messages: { request } });

    await expect(test.observer(RECORD)).resolves.toBeUndefined();
    expect(test.enqueue).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledOnce();
  });

  it.each([
    [
      'unavailable build',
      {
        config: { clientId: undefined, enabled: false },
      },
    ],
    [
      'disconnected settings',
      {
        settings: {
          get: () =>
            Promise.resolve({
              schemaVersion: 1 as const,
              editorMode: 'text-focused-blocks' as const,
              pageIdentityExclusions: [],
            }),
        },
      },
    ],
  ] as const)('does not enqueue for %s', async (_label, overrides) => {
    const test = harness(overrides);

    await test.observer(RECORD);

    expect(test.enqueue).not.toHaveBeenCalled();
    expect(test.request).not.toHaveBeenCalled();
  });

  it('keeps durable unsynced intent when the stored OAuth token is expired', async () => {
    const test = harness({
      settings: {
        get: () =>
          Promise.resolve({
            schemaVersion: 1 as const,
            editorMode: 'text-focused-blocks' as const,
            pageIdentityExclusions: [],
            byosConnection: {
              accessToken: 'oauth-token',
              connectedAt: '2026-07-25T10:00:00.000Z',
              expiresAt: NOW,
            },
          }),
      },
    });

    await test.observer(RECORD);

    expect(test.enqueue).toHaveBeenCalledWith(
      RECORD.pageKey,
      RECORD.revisionId,
    );
    expect(test.request).toHaveBeenCalledWith('local-mutation');
  });
});
