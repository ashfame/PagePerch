import { describe, expect, it, vi } from 'vitest';

import { InMemoryChromeStorage } from '../../test/inMemoryChromeStorage';
import {
  BYOS_PKCE_SESSION_SCHEMA_VERSION,
  BYOS_PKCE_SESSION_STORAGE_KEY,
  parseByosPkceSession,
  type ByosPkceSessionV1,
} from '../services/byosPkceSession';
import { ChromeSessionByosPkceRepository } from './chromeSessionByosPkceRepository';
import { RepositoryConfigurationError } from './repositoryErrors';

function pending(
  overrides: Partial<ByosPkceSessionV1> = {},
): ByosPkceSessionV1 {
  return {
    schemaVersion: BYOS_PKCE_SESSION_SCHEMA_VERSION,
    codeVerifier: 'A'.repeat(43),
    state: 'B'.repeat(43),
    redirectUri: 'https://extension-id.chromiumapp.org/',
    createdAt: '2026-07-25T12:00:00.000Z',
    ...overrides,
  };
}

describe('BYOS PKCE session persistence', () => {
  it('strictly round-trips pending authorization across adapter instances and clears it', async () => {
    const storage = new InMemoryChromeStorage();
    const first = new ChromeSessionByosPkceRepository(storage);
    const session = pending();

    await first.save(session);
    const reloaded = new ChromeSessionByosPkceRepository(storage);
    const loaded = await reloaded.load();

    expect(loaded).toEqual(session);
    expect(Object.isFrozen(loaded)).toBe(true);
    expect(storage.snapshot()).toEqual({
      [BYOS_PKCE_SESSION_STORAGE_KEY]: session,
    });

    await reloaded.clear();
    await expect(first.load()).resolves.toBeUndefined();
    expect(storage.snapshot()).toEqual({});
  });

  it.each([
    ['malformed', { schemaVersion: 1, partial: true }, 'malformed'],
    [
      'future',
      {
        ...pending(),
        schemaVersion: 99,
      },
      'future-schema',
    ],
    [
      'extra field',
      {
        ...pending(),
        authorizationCode: 'must-not-be-stored',
      },
      'malformed',
    ],
  ])('preserves and reports a %s envelope', async (_label, value, kind) => {
    const storage = new InMemoryChromeStorage({
      [BYOS_PKCE_SESSION_STORAGE_KEY]: value,
    });
    const repository = new ChromeSessionByosPkceRepository(storage);

    await expect(repository.load()).rejects.toMatchObject({
      name: 'ByosPkceSessionError',
      kind,
    });
    expect(storage.snapshot()[BYOS_PKCE_SESSION_STORAGE_KEY]).toEqual(value);
    expect(storage.setCalls).toEqual([]);
    expect(storage.removeCalls).toEqual([]);
  });

  it('rejects invalid save input without writing or leaking values in the error', async () => {
    const storage = new InMemoryChromeStorage();
    const repository = new ChromeSessionByosPkceRepository(storage);
    const secret = 'sentinel-verifier';

    await expect(
      repository.save(pending({ codeVerifier: secret })),
    ).rejects.toMatchObject({
      name: 'ByosPkceSessionError',
      kind: 'malformed',
    });
    expect(storage.snapshot()).toEqual({});

    try {
      parseByosPkceSession({ codeVerifier: secret });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });

  it('uses chrome.storage.session by default and fails clearly when unavailable', async () => {
    const storage = new InMemoryChromeStorage();
    vi.stubGlobal('chrome', { storage: { session: storage } });
    const repository = new ChromeSessionByosPkceRepository();

    await repository.save(pending());
    expect(storage.snapshot()).toHaveProperty(BYOS_PKCE_SESSION_STORAGE_KEY);

    vi.stubGlobal('chrome', undefined);
    expect(() => new ChromeSessionByosPkceRepository()).toThrow(
      RepositoryConfigurationError,
    );
  });
});
