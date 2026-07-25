import { describe, expect, it, vi } from 'vitest';

import { InMemoryChromeStorage } from '../../test/inMemoryChromeStorage';
import { ChromeSessionByosPkceRepository } from '../repositories/chromeSessionByosPkceRepository';
import type { ByosPkceSessionV1 } from './byosPkceSession';
import {
  buildByosAuthorizeUrl,
  BYOS_AUTHORIZE_URL,
  BYOS_SCOPE,
  BYOS_TOKEN_URL,
  ByosOAuthClient,
  createS256CodeChallenge,
  type ByosHttpResponse,
  type ByosHttpTransport,
  type ByosIdentityPort,
} from './byosOAuth';

const NOW = '2026-07-25T12:00:00.000Z';
const CLIENT_ID = 'client_public_pageperch';
const REDIRECT_URI = 'https://extension-id.chromiumapp.org/';

function tokenResponse(
  overrides: Record<string, unknown> = {},
): ByosHttpResponse {
  return {
    status: 200,
    body: {
      access_token: 'oauth-access-token',
      token_type: 'bearer',
      expires_in: 3600,
      scope: BYOS_SCOPE,
      ...overrides,
    },
  };
}

function deterministicRandomBytes(): (length: number) => Uint8Array {
  let seed = 0;

  return (length) => {
    const value = new Uint8Array(length);

    for (let index = 0; index < length; index += 1) {
      value[index] = (seed + index) % 256;
    }

    seed += length;
    return value;
  };
}

function oauthHarness(
  options: {
    readonly storage?: InMemoryChromeStorage;
    readonly response?: ByosHttpResponse;
    readonly http?: ByosHttpTransport;
    readonly identity?: ByosIdentityPort;
    readonly randomBytes?: (length: number) => Uint8Array;
  } = {},
) {
  const storage = options.storage ?? new InMemoryChromeStorage();
  const session = new ChromeSessionByosPkceRepository(storage);
  const request = vi.fn(() =>
    Promise.resolve(options.response ?? tokenResponse()),
  );
  const identity: ByosIdentityPort = options.identity ?? {
    getRedirectURL: vi.fn(() => REDIRECT_URI),
    launchWebAuthFlow: vi.fn(() => Promise.reject(new Error('not launched'))),
  };
  const client = new ByosOAuthClient({
    session,
    identity,
    http: options.http ?? { request },
    clock: () => new Date(NOW),
    randomBytes: options.randomBytes ?? deterministicRandomBytes(),
  });

  return { client, identity, request, session, storage };
}

function callback(session: ByosPkceSessionV1, code = 'authorization-code') {
  const url = new URL(session.redirectUri);
  url.searchParams.set('code', code);
  url.searchParams.set('state', session.state);
  return url.href;
}

describe('BYOS OAuth PKCE', () => {
  it('matches the RFC 7636 S256 challenge vector', async () => {
    await expect(
      createS256CodeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
    ).resolves.toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('builds the exact deterministic public-client authorize URL and storage-only scopes', () => {
    const url = buildByosAuthorizeUrl({
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      state: 'state-value',
      codeChallenge: 'challenge-value',
    });

    expect(url).toBe(
      `${BYOS_AUTHORIZE_URL}?response_type=code&client_id=client_public_pageperch&redirect_uri=https%3A%2F%2Fextension-id.chromiumapp.org%2F&scope=storage%3Aapp+storage%3As3&state=state-value&code_challenge=challenge-value&code_challenge_method=S256`,
    );
    expect(url).not.toMatch(
      /client_secret|openid|profile|email|offline_access/u,
    );
  });

  it('persists verifier, state, redirect, and timestamp before browser launch', async () => {
    const { client, identity, session } = oauthHarness();
    const prepared = await client.prepareAuthorization(CLIENT_ID);
    const launch = vi.spyOn(identity, 'launchWebAuthFlow');
    launch.mockImplementationOnce(async (authorizeUrl) => {
      expect(await session.load()).toEqual(prepared.session);
      expect(authorizeUrl).toBe(prepared.authorizeUrl);
      return callback(prepared.session);
    });

    await expect(
      client.launchAuthorization(prepared.authorizeUrl),
    ).resolves.toBe(callback(prepared.session));
    expect(prepared.session.codeVerifier).toHaveLength(43);
    expect(prepared.session.state).toHaveLength(43);
  });

  it('completes from a suspension-like fresh client, exchanges the exact form body, and adjusts expiry early', async () => {
    const storage = new InMemoryChromeStorage();
    const first = oauthHarness({ storage });
    const prepared = await first.client.prepareAuthorization(CLIENT_ID);
    const second = oauthHarness({ storage });
    const connection = await second.client.completeAuthorization(
      CLIENT_ID,
      callback(prepared.session),
    );

    expect(connection).toEqual({
      accessToken: 'oauth-access-token',
      connectedAt: NOW,
      expiresAt: '2026-07-25T12:59:00.000Z',
    });
    expect(second.request).toHaveBeenCalledWith({
      url: BYOS_TOKEN_URL,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `grant_type=authorization_code&client_id=${CLIENT_ID}&redirect_uri=https%3A%2F%2Fextension-id.chromiumapp.org%2F&code=authorization-code&code_verifier=${prepared.session.codeVerifier}`,
    });
    expect(JSON.stringify(connection)).not.toContain('authorization-code');
    expect(JSON.stringify(connection)).not.toContain(
      prepared.session.codeVerifier,
    );
  });

  it.each([
    [
      'state mismatch',
      (session: ByosPkceSessionV1) =>
        callback({ ...session, state: 'C'.repeat(43) }),
      'state-mismatch',
    ],
    [
      'OAuth error callback',
      (session: ByosPkceSessionV1) => {
        const url = new URL(session.redirectUri);
        url.searchParams.set('error', 'access_denied');
        url.searchParams.set('error_description', 'sentinel-private-detail');
        url.searchParams.set('state', session.state);
        return url.href;
      },
      'authorization-failed',
    ],
    [
      'missing code',
      (session: ByosPkceSessionV1) =>
        `${session.redirectUri}?state=${session.state}`,
      'authorization-failed',
    ],
    [
      'duplicate code',
      (session: ByosPkceSessionV1) =>
        `${callback(session)}&code=sentinel-duplicate-code`,
      'authorization-failed',
    ],
    [
      'duplicate state',
      (session: ByosPkceSessionV1) =>
        `${callback(session)}&state=${session.state}`,
      'authorization-failed',
    ],
    [
      'wrong redirect',
      (session: ByosPkceSessionV1) =>
        callback({
          ...session,
          redirectUri: 'https://other.chromiumapp.org/',
        }),
      'authorization-failed',
    ],
  ])('rejects %s before token exchange', async (_label, makeUrl, code) => {
    const test = oauthHarness();
    const prepared = await test.client.prepareAuthorization(CLIENT_ID);

    await expect(
      test.client.completeAuthorization(CLIENT_ID, makeUrl(prepared.session)),
    ).rejects.toMatchObject({ name: 'ByosError', code });
    expect(test.request).not.toHaveBeenCalled();
  });

  it.each([
    ['HTTP failure', { status: 503, body: { secret: 'sentinel-body' } }],
    ['non-object', { status: 200, body: 'sentinel-body' }],
    [
      'extra token field',
      tokenResponse({ id_token: 'sentinel-identity-token' }),
    ],
    ['wrong type', tokenResponse({ token_type: 'mac' })],
    ['short expiry', tokenResponse({ expires_in: 60 })],
    ['fractional expiry', tokenResponse({ expires_in: 3600.5 })],
    ['missing scope', tokenResponse({ scope: 'storage:app' })],
    ['identity scope', tokenResponse({ scope: `${BYOS_SCOPE} openid` })],
  ])('rejects a token %s with a sanitized error', async (_label, response) => {
    const test = oauthHarness({ response });
    const prepared = await test.client.prepareAuthorization(CLIENT_ID);
    let thrown: unknown;

    try {
      await test.client.completeAuthorization(
        CLIENT_ID,
        callback(prepared.session, 'sentinel-authorization-code'),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      name: 'ByosError',
      code: 'token-failed',
    });
    expect(String(thrown)).not.toMatch(
      /sentinel|authorization-code|identity-token/u,
    );
  });

  it('maps transport and randomness failures without exposing their causes', async () => {
    const randomness = oauthHarness({
      randomBytes: () => {
        throw new Error('sentinel-random-source');
      },
    });
    await expect(
      randomness.client.prepareAuthorization(CLIENT_ID),
    ).rejects.toMatchObject({ code: 'randomness-failed' });

    const transport = oauthHarness({
      http: {
        request: () =>
          Promise.reject(
            new Error(
              'sentinel-code sentinel-verifier sentinel-token sentinel-body',
            ),
          ),
      },
    });
    const prepared = await transport.client.prepareAuthorization(CLIENT_ID);
    let thrown: unknown;

    try {
      await transport.client.completeAuthorization(
        CLIENT_ID,
        callback(prepared.session, 'sentinel-code'),
      );
    } catch (error) {
      thrown = error;
    }

    expect(String(thrown)).not.toMatch(
      /sentinel-code|sentinel-verifier|sentinel-token|sentinel-body|sentinel-random-source/u,
    );
  });

  it('clears stale pending authorization and never exchanges its code', async () => {
    const test = oauthHarness();
    const prepared = await test.client.prepareAuthorization(CLIENT_ID);
    const staleClient = new ByosOAuthClient({
      session: test.session,
      identity: test.identity,
      http: { request: test.request },
      clock: () => new Date('2026-07-25T12:11:00.001Z'),
      randomBytes: deterministicRandomBytes(),
    });

    await expect(
      staleClient.completeAuthorization(CLIENT_ID, callback(prepared.session)),
    ).rejects.toMatchObject({ code: 'authorization-failed' });
    await expect(test.session.load()).resolves.toBeUndefined();
    expect(test.request).not.toHaveBeenCalled();
  });
});
