import { describe, expect, it, vi } from 'vitest';

import {
  createByosClient,
  ChromeByosIdentityConnector,
  FetchByosHttpConnector,
  readByosClientConfig,
} from './byosClient';
import { SETTINGS_STORAGE_KEY } from '../repositories/chromeLocalSettingsRepository';
import { InMemoryChromeStorage } from '../../test/inMemoryChromeStorage';

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

  it('exposes narrow invalidation for its own in-memory protocol credential cache', async () => {
    const local = new InMemoryChromeStorage({
      [SETTINGS_STORAGE_KEY]: {
        schemaVersion: 1,
        editorMode: 'text-focused-blocks',
        showRecentNotesOnOrigin: false,
        pageIdentityExclusions: [],
        byosConnection: {
          accessToken: 'oauth-access-token',
          connectedAt: '2026-07-25T12:00:00.000Z',
          expiresAt: '2099-07-25T13:00:00.000Z',
        },
      },
    });
    vi.stubGlobal('chrome', {
      identity: {
        getRedirectURL: vi.fn(),
        launchWebAuthFlow: vi.fn(),
      },
      storage: {
        local,
        session: new InMemoryChromeStorage(),
      },
    });
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        status: 200,
        json: () =>
          Promise.resolve({
            credential: {
              id: 'credential-1',
              protocol: 's3',
              access_key_id: 'temporary-access-key',
              expires_at: '2099-07-25T13:00:00.000Z',
            },
            grant: {
              protocol: 's3',
              protocol_credential_id: 'credential-1',
              external_alias: 'issued-bucket-alias',
              expires_at: '2099-07-25T12:45:00.000Z',
            },
            access_key_id: 'temporary-access-key',
            secret: 'temporary-secret',
          }),
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = createByosClient({
      VITE_BYOS_CLIENT_ID: 'public-client',
    });

    await client.coordinator.getProtocolCredentials();
    await client.coordinator.getProtocolCredentials();
    expect(fetchMock).toHaveBeenCalledOnce();

    client.invalidateProtocolCredentials();
    await client.coordinator.getProtocolCredentials();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
