import { describe, expect, it, vi } from 'vitest';

import {
  ChromeCanonicalPageOpener,
  InvalidCanonicalPageUrlError,
  type ChromeCreateTabPort,
} from './chromeCanonicalPageOpener';

function createTabs() {
  const create = vi.fn<ChromeCreateTabPort['create']>(() =>
    Promise.resolve({ id: 7 } as chrome.tabs.Tab),
  );

  return {
    create,
    opener: new ChromeCanonicalPageOpener({ create }),
  };
}

describe('ChromeCanonicalPageOpener', () => {
  it.each(['https://example.com/', 'http://localhost:8080/path?query=value'])(
    'opens canonical HTTP(S) URL %s in a new active tab',
    async (url) => {
      const { create, opener } = createTabs();

      await opener.openCanonicalUrl(url);

      expect(create).toHaveBeenCalledOnce();
      expect(create).toHaveBeenCalledWith({
        active: true,
        url,
      });
    },
  );

  it.each([
    'relative/path',
    'chrome://settings/',
    'https://user@example.com/',
    'https://user:secret@example.com/',
    'https://example.com/path#fragment',
    'https://example.com/path?',
    ' https://example.com/',
    'https://example.com',
  ])('rejects non-canonical or unsafe URL %s before Chrome', async (url) => {
    const { create, opener } = createTabs();

    await expect(opener.openCanonicalUrl(url)).rejects.toBeInstanceOf(
      InvalidCanonicalPageUrlError,
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('observes synchronous and asynchronous Chrome failures', async () => {
    const { create, opener } = createTabs();
    const synchronousFailure = new Error('sync create failure');
    create.mockImplementationOnce(() => {
      throw synchronousFailure;
    });
    await expect(opener.openCanonicalUrl('https://example.com/')).rejects.toBe(
      synchronousFailure,
    );

    const rejectedFailure = new Error('rejected create failure');
    create.mockRejectedValueOnce(rejectedFailure);
    await expect(
      opener.openCanonicalUrl('https://example.com/path'),
    ).rejects.toBe(rejectedFailure);
  });
});
