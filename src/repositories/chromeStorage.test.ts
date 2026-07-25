import { describe, expect, it, vi } from 'vitest';

import { InMemoryChromeStorage } from '../../test/inMemoryChromeStorage';
import { ChromeLocalNoteRepository } from './chromeLocalNoteRepository';
import { RepositoryConfigurationError } from './repositoryErrors';

describe('Chrome repository storage selection', () => {
  it('fails clearly when no injected or extension-local storage is available', () => {
    vi.stubGlobal('chrome', undefined);

    expect(() => new ChromeLocalNoteRepository()).toThrow(
      RepositoryConfigurationError,
    );
  });

  it('uses chrome.storage.local by default when the extension API is available', async () => {
    const local = new InMemoryChromeStorage();
    vi.stubGlobal('chrome', { storage: { local } });
    const repository = new ChromeLocalNoteRepository();
    const record = {
      schemaVersion: 1,
      pageKey: `${'D'.repeat(42)}A`,
      canonicalUrl: 'https://example.com/default',
      representativeUrl: 'https://example.com/default',
      origin: 'https://example.com',
      title: 'Default storage',
      contentHtml:
        '<!-- wp:paragraph --><p>Stored locally.</p><!-- /wp:paragraph -->',
      contentHash: 'default-hash',
      savedAt: '2026-07-25T10:00:00Z',
      revisionId: 'default-revision',
    } as const;

    await repository.put(record);

    await expect(repository.get(record.pageKey)).resolves.toEqual(record);
  });

  it('coordinates repository operations through a shared Web Lock when available', async () => {
    const request = vi.fn(
      (
        _name: string,
        _options: LockOptions,
        callback: () => Promise<unknown>,
      ) => callback(),
    );
    vi.stubGlobal('navigator', { locks: { request } });
    const repository = new ChromeLocalNoteRepository(
      new InMemoryChromeStorage(),
    );
    const record = {
      schemaVersion: 1,
      pageKey: `${'L'.repeat(42)}A`,
      canonicalUrl: 'https://example.com/locked',
      representativeUrl: 'https://example.com/locked',
      origin: 'https://example.com',
      title: 'Locked storage',
      contentHtml:
        '<!-- wp:paragraph --><p>Coordinated.</p><!-- /wp:paragraph -->',
      contentHash: 'locked-hash',
      savedAt: '2026-07-25T10:00:00Z',
      revisionId: 'locked-revision',
    } as const;

    await repository.put(record);

    expect(request).toHaveBeenCalledWith(
      'pageperch:v1:chrome-storage-repository-operations',
      { mode: 'exclusive' },
      expect.any(Function),
    );
  });
});
