import { describe, expect, it, vi } from 'vitest';

import {
  ChromeByosIdentityConnector,
  FetchByosHttpConnector,
  readByosClientConfig,
} from './byosClient';

describe('BYOS production client connectors', () => {
  it.each([
    [{}, undefined, false],
    [{ VITE_BYOS_CLIENT_ID: '' }, undefined, false],
    [{ VITE_BYOS_CLIENT_ID: '   ' }, undefined, false],
    [{ VITE_BYOS_CLIENT_ID: ' client-public ' }, 'client-public', true],
  ])(
    'reads public build configuration without throwing',
    (environment, clientId, enabled) => {
      expect(readByosClientConfig(environment)).toEqual({ clientId, enabled });
    },
  );

  it('uses getRedirectURL without a path and launches an interactive Chrome identity flow', async () => {
    const getRedirectURL = vi.fn(() => 'https://extension-id.chromiumapp.org/');
    const launchWebAuthFlow = vi.fn(() =>
      Promise.resolve(
        'https://extension-id.chromiumapp.org/?code=redacted&state=redacted',
      ),
    );
    vi.stubGlobal('chrome', {
      identity: { getRedirectURL, launchWebAuthFlow },
    });
    const connector = new ChromeByosIdentityConnector();

    expect(connector.getRedirectURL()).toBe(
      'https://extension-id.chromiumapp.org/',
    );
    expect(getRedirectURL).toHaveBeenCalledWith();
    await expect(
      connector.launchWebAuthFlow(
        'https://byos.ashfame.com/oauth2/auth?redacted',
      ),
    ).resolves.toContain('extension-id.chromiumapp.org');
    expect(launchWebAuthFlow).toHaveBeenCalledWith({
      url: 'https://byos.ashfame.com/oauth2/auth?redacted',
      interactive: true,
    });
  });

  it('uses fetch without credentials or cache and parses only JSON data', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        status: 200,
        json: () => Promise.resolve({ ok: true }),
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const connector = new FetchByosHttpConnector();

    await expect(
      connector.request({
        url: 'https://byos.ashfame.com/oauth2/token',
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'redacted=form',
      }),
    ).resolves.toEqual({ status: 200, body: { ok: true } });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://byos.ashfame.com/oauth2/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'redacted=form',
        cache: 'no-store',
        credentials: 'omit',
      },
    );
  });
});
