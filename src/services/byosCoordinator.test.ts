import { describe, expect, it, vi } from 'vitest';

import type { ByosConnectionV1, SettingsRecordV1 } from '../domain/settings';
import {
  ChromeLocalSettingsRepository,
  SETTINGS_STORAGE_KEY,
} from '../repositories/chromeLocalSettingsRepository';
import { ChromeSessionByosPkceRepository } from '../repositories/chromeSessionByosPkceRepository';
import { IDENTITY_MIGRATION_JOURNAL_STORAGE_KEY } from './identityMigrationPersistence';
import { InMemoryChromeStorage } from '../../test/inMemoryChromeStorage';
import {
  ByosCoordinator,
  type ByosCoordinatorDependencies,
} from './byosCoordinator';
import type { ByosProtocolCredentials } from './byosProtocolCredentials';

const NOW = '2026-07-25T12:00:00.000Z';

function connection(
  overrides: Partial<ByosConnectionV1> = {},
): ByosConnectionV1 {
  return {
    accessToken: 'oauth-access-token',
    connectedAt: NOW,
    expiresAt: '2026-07-25T13:00:00.000Z',
    ...overrides,
  };
}

function settings(overrides: Partial<SettingsRecordV1> = {}): SettingsRecordV1 {
  return {
    schemaVersion: 1,
    editorMode: 'text-focused-blocks',
    showRecentNotesOnOrigin: false,
    pageIdentityExclusions: [],
    ...overrides,
  };
}

function protocolCredentials(): ByosProtocolCredentials {
  return {
    accessKeyId: 'access-key',
    secretAccessKey: 'one-time-secret',
    bucket: 'bucket-alias',
    credentialId: 'credential-id',
    expiresAt: '2026-07-25T12:45:00.000Z',
  };
}

function coordinatorHarness(
  overrides: Partial<ByosCoordinatorDependencies> = {},
  initialSettings: SettingsRecordV1 = settings(),
) {
  let stored = structuredClone(initialSettings);
  const oauth = {
    clearPendingAuthorization: vi.fn(() => Promise.resolve()),
    prepareAuthorization: vi.fn(() =>
      Promise.resolve({
        authorizeUrl: 'https://byos.ashfame.com/oauth2/auth?redacted',
        session: {
          schemaVersion: 1 as const,
          codeVerifier: 'A'.repeat(43),
          state: 'B'.repeat(43),
          redirectUri: 'https://extension-id.chromiumapp.org/',
          createdAt: NOW,
        },
      }),
    ),
    launchAuthorization: vi.fn(() =>
      Promise.resolve(
        'https://extension-id.chromiumapp.org/?code=redacted&state=redacted',
      ),
    ),
    completeAuthorization: vi.fn(() => Promise.resolve(connection())),
  };
  const settingsPort = {
    get: vi.fn(() => Promise.resolve(structuredClone(stored))),
    updateByosConnection: vi.fn((value: ByosConnectionV1 | undefined) => {
      stored =
        value === undefined
          ? {
              schemaVersion: stored.schemaVersion,
              editorMode: stored.editorMode,
              showRecentNotesOnOrigin: stored.showRecentNotesOnOrigin,
              pageIdentityExclusions: stored.pageIdentityExclusions,
            }
          : { ...stored, byosConnection: { ...value } };
      return Promise.resolve(structuredClone(stored));
    }),
  };
  const credentials = {
    get: vi.fn(() => Promise.resolve(protocolCredentials())),
    clear: vi.fn(),
  };
  const resumePendingMigration = vi.fn(() => Promise.resolve());
  const dependencies: ByosCoordinatorDependencies = {
    clientId: 'client-public',
    oauth,
    settings: settingsPort,
    credentials,
    clock: () => new Date(NOW),
    resumePendingMigration,
    ...overrides,
  };

  return {
    coordinator: new ByosCoordinator(dependencies),
    credentials,
    oauth,
    resumePendingMigration,
    settingsPort,
  };
}

describe('ByosCoordinator', () => {
  it('rejects a missing public client ID before every side effect', async () => {
    const test = coordinatorHarness({ clientId: '   ' });

    await expect(test.coordinator.connect()).rejects.toMatchObject({
      name: 'ByosError',
      code: 'configuration-required',
    });
    expect(test.oauth.clearPendingAuthorization).not.toHaveBeenCalled();
    expect(test.oauth.prepareAuthorization).not.toHaveBeenCalled();
    expect(test.settingsPort.updateByosConnection).not.toHaveBeenCalled();
  });

  it('runs connect as one single-flight authorization and clears transient state after storing', async () => {
    let releasePrepare: (() => void) | undefined;
    const prepareGate = new Promise<void>((resolve) => {
      releasePrepare = resolve;
    });
    const test = coordinatorHarness();
    test.oauth.prepareAuthorization.mockImplementationOnce(async () => {
      await prepareGate;
      return {
        authorizeUrl: 'https://byos.ashfame.com/oauth2/auth?redacted',
        session: {
          schemaVersion: 1,
          codeVerifier: 'A'.repeat(43),
          state: 'B'.repeat(43),
          redirectUri: 'https://extension-id.chromiumapp.org/',
          createdAt: NOW,
        },
      };
    });

    const first = test.coordinator.connect();
    const second = test.coordinator.connect();
    expect(first).toBe(second);
    releasePrepare?.();
    await expect(Promise.all([first, second])).resolves.toEqual([
      undefined,
      undefined,
    ]);

    expect(test.oauth.prepareAuthorization).toHaveBeenCalledOnce();
    expect(test.oauth.launchAuthorization).toHaveBeenCalledOnce();
    expect(test.oauth.completeAuthorization).toHaveBeenCalledOnce();
    expect(test.settingsPort.updateByosConnection).toHaveBeenCalledWith(
      connection(),
    );
    expect(test.oauth.clearPendingAuthorization).toHaveBeenCalledTimes(2);
  });

  it('cleans failed authorization state and exposes only a sanitized typed error', async () => {
    const test = coordinatorHarness();
    test.oauth.launchAuthorization.mockRejectedValueOnce(
      new Error(
        'sentinel-code sentinel-verifier sentinel-token https://private.example/callback',
      ),
    );
    let thrown: unknown;

    try {
      await test.coordinator.connect();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      name: 'ByosError',
      code: 'authorization-failed',
    });
    expect(String(thrown)).not.toMatch(/sentinel|private\.example|verifier/u);
    expect(test.oauth.clearPendingAuthorization).toHaveBeenCalledTimes(2);
    expect(test.settingsPort.updateByosConnection).not.toHaveBeenCalled();
    await expect(test.coordinator.connect()).resolves.toBeUndefined();
  });

  it('invalidates a delayed connect without waiting and never resurrects the connection', async () => {
    let resolveCompletion: ((connection: ByosConnectionV1) => void) | undefined;
    const completion = new Promise<ByosConnectionV1>((resolve) => {
      resolveCompletion = resolve;
    });
    const test = coordinatorHarness(
      {},
      settings({
        byosConnection: connection({ accessToken: 'old-access-token' }),
      }),
    );
    test.oauth.completeAuthorization.mockReturnValueOnce(completion);

    const connecting = test.coordinator.connect();
    const settled = connecting.then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    );
    await vi.waitFor(() => {
      expect(test.oauth.completeAuthorization).toHaveBeenCalledOnce();
    });

    await expect(test.coordinator.disconnect()).resolves.toBeUndefined();
    expect(test.settingsPort.updateByosConnection).toHaveBeenCalledTimes(1);
    expect(test.settingsPort.updateByosConnection).toHaveBeenLastCalledWith(
      undefined,
    );

    resolveCompletion?.(
      connection({
        accessToken: 'sentinel-late-access-token',
        connectedAt: '2026-07-25T12:05:00.000Z',
      }),
    );
    const { error } = await settled;

    expect(error).toMatchObject({
      name: 'ByosError',
      code: 'authorization-failed',
    });
    expect(String(error)).not.toContain('sentinel-late-access-token');
    await expect(test.settingsPort.get()).resolves.toEqual(settings());
    expect(test.settingsPort.updateByosConnection).toHaveBeenCalledTimes(1);
  });

  it('clears a PKCE session saved by prepare after disconnect has returned', async () => {
    let enterPrepare: (() => void) | undefined;
    let releasePrepare: (() => void) | undefined;
    const prepareEntered = new Promise<void>((resolve) => {
      enterPrepare = resolve;
    });
    const prepareGate = new Promise<void>((resolve) => {
      releasePrepare = resolve;
    });
    const sessionStorage = new InMemoryChromeStorage();
    const sessionRepository = new ChromeSessionByosPkceRepository(
      sessionStorage,
    );
    const settingsStorage = new InMemoryChromeStorage({
      [SETTINGS_STORAGE_KEY]: settings({ byosConnection: connection() }),
    });
    const settingsRepository = new ChromeLocalSettingsRepository(
      settingsStorage,
    );
    const preparedSession = {
      schemaVersion: 1 as const,
      codeVerifier: 'A'.repeat(43),
      state: 'B'.repeat(43),
      redirectUri: 'https://extension-id.chromiumapp.org/',
      createdAt: NOW,
    };
    const oauth = {
      clearPendingAuthorization: vi.fn(() => sessionRepository.clear()),
      prepareAuthorization: vi.fn(async () => {
        enterPrepare?.();
        await prepareGate;
        await sessionRepository.save(preparedSession);

        return {
          authorizeUrl: 'https://byos.ashfame.com/oauth2/auth?redacted',
          session: preparedSession,
        };
      }),
      launchAuthorization: vi.fn(() =>
        Promise.resolve(
          'https://extension-id.chromiumapp.org/?code=redacted&state=redacted',
        ),
      ),
      completeAuthorization: vi.fn(() => Promise.resolve(connection())),
    };
    const coordinator = new ByosCoordinator({
      clientId: 'client-public',
      oauth,
      settings: settingsRepository,
      credentials: {
        get: vi.fn(() => Promise.resolve(protocolCredentials())),
        clear: vi.fn(),
      },
      clock: () => new Date(NOW),
      resumePendingMigration: () => Promise.resolve(),
    });
    const connecting = coordinator.connect();
    const settled = connecting.then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    );

    await prepareEntered;
    await expect(coordinator.disconnect()).resolves.toBeUndefined();
    await expect(sessionRepository.load()).resolves.toBeUndefined();
    expect(coordinator.connect()).toBe(connecting);

    releasePrepare?.();
    const { error } = await settled;

    expect(error).toMatchObject({
      name: 'ByosError',
      code: 'authorization-failed',
    });
    expect(oauth.launchAuthorization).not.toHaveBeenCalled();
    expect(oauth.completeAuthorization).not.toHaveBeenCalled();
    expect(oauth.clearPendingAuthorization).toHaveBeenCalledTimes(3);
    await expect(sessionRepository.load()).resolves.toBeUndefined();
    await expect(settingsRepository.get()).resolves.toEqual(settings());
  });

  it('sanitizes failed final cleanup after a connect is invalidated', async () => {
    let resolveCompletion: ((connection: ByosConnectionV1) => void) | undefined;
    const completion = new Promise<ByosConnectionV1>((resolve) => {
      resolveCompletion = resolve;
    });
    const test = coordinatorHarness();
    test.oauth.completeAuthorization.mockReturnValueOnce(completion);
    const connecting = test.coordinator.connect();
    const settled = connecting.then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    );
    await vi.waitFor(() => {
      expect(test.oauth.completeAuthorization).toHaveBeenCalledOnce();
    });
    await test.coordinator.disconnect();
    test.oauth.clearPendingAuthorization.mockRejectedValueOnce(
      new Error('sentinel-verifier sentinel-state'),
    );

    resolveCompletion?.(connection());
    const { error } = await settled;

    expect(error).toMatchObject({
      name: 'ByosError',
      code: 'session-failed',
    });
    expect(String(error)).not.toMatch(/sentinel|verifier|state/u);
    await expect(test.settingsPort.get()).resolves.toEqual(settings());
  });

  it('disconnects only after migration recovery and leaves note storage untouched', async () => {
    const noteKey = `pageperch:v1:notes:${'A'.repeat(43)}`;
    const note = { private: 'local note remains untouched' };
    const storage = new InMemoryChromeStorage({
      [SETTINGS_STORAGE_KEY]: settings({ byosConnection: connection() }),
      [IDENTITY_MIGRATION_JOURNAL_STORAGE_KEY]: { pending: true },
      [noteKey]: note,
    });
    const repository = new ChromeLocalSettingsRepository(storage);
    const events: string[] = [];
    const oauth = {
      clearPendingAuthorization: vi.fn(() => {
        events.push('session');
        return Promise.resolve();
      }),
      prepareAuthorization: vi.fn(),
      launchAuthorization: vi.fn(),
      completeAuthorization: vi.fn(),
    };
    const credentials = {
      get: vi.fn(() => Promise.resolve(protocolCredentials())),
      clear: vi.fn(() => {
        events.push('credentials');
      }),
    };
    const coordinator = new ByosCoordinator({
      clientId: 'client-public',
      oauth,
      settings: repository,
      credentials,
      clock: () => new Date(NOW),
      resumePendingMigration: async () => {
        events.push('recovery');
        await storage.remove(IDENTITY_MIGRATION_JOURNAL_STORAGE_KEY);
      },
    });

    await coordinator.disconnect();

    expect(events).toEqual(['recovery', 'credentials', 'session']);
    expect(storage.snapshot()).toEqual({
      [SETTINGS_STORAGE_KEY]: settings(),
      [noteKey]: note,
    });
  });

  it('keeps disconnect retryable when recovery or session cleanup fails', async () => {
    const recovery = coordinatorHarness();
    recovery.resumePendingMigration.mockRejectedValueOnce(
      new Error('sentinel-recovery'),
    );
    await expect(recovery.coordinator.disconnect()).rejects.toMatchObject({
      code: 'disconnect-failed',
    });
    expect(recovery.credentials.clear).not.toHaveBeenCalled();
    expect(recovery.settingsPort.updateByosConnection).not.toHaveBeenCalled();
    await expect(recovery.coordinator.disconnect()).resolves.toBeUndefined();

    const session = coordinatorHarness();
    session.oauth.clearPendingAuthorization.mockRejectedValueOnce(
      new Error('sentinel-session'),
    );
    await expect(session.coordinator.disconnect()).rejects.toMatchObject({
      code: 'disconnect-failed',
    });
    expect(session.settingsPort.updateByosConnection).not.toHaveBeenCalled();
    await expect(session.coordinator.disconnect()).resolves.toBeUndefined();
  });

  it('retries a failed final settings removal without resurrecting the connection', async () => {
    const test = coordinatorHarness(
      {},
      settings({ byosConnection: connection() }),
    );
    test.settingsPort.updateByosConnection.mockRejectedValueOnce(
      new Error('sentinel-settings-failure'),
    );

    await expect(test.coordinator.disconnect()).rejects.toMatchObject({
      name: 'ByosError',
      code: 'disconnect-failed',
    });
    await expect(test.settingsPort.get()).resolves.toMatchObject({
      byosConnection: connection(),
    });

    await expect(test.coordinator.disconnect()).resolves.toBeUndefined();
    await expect(test.settingsPort.get()).resolves.toEqual(settings());
    expect(test.settingsPort.updateByosConnection).toHaveBeenNthCalledWith(
      1,
      undefined,
    );
    expect(test.settingsPort.updateByosConnection).toHaveBeenNthCalledWith(
      2,
      undefined,
    );
  });

  it('rejects protocol credentials when the client is disabled before every side effect', async () => {
    const get = vi.fn(() =>
      Promise.resolve(settings({ byosConnection: connection() })),
    );
    const updateByosConnection = vi.fn(() => Promise.resolve(settings()));
    const clock = vi.fn(() => new Date(NOW));
    const test = coordinatorHarness({
      clientId: '   ',
      settings: { get, updateByosConnection },
      clock,
    });

    await expect(
      test.coordinator.getProtocolCredentials(),
    ).rejects.toMatchObject({
      name: 'ByosError',
      code: 'configuration-required',
    });
    expect(get).not.toHaveBeenCalled();
    expect(clock).not.toHaveBeenCalled();
    expect(test.credentials.get).not.toHaveBeenCalled();
  });

  it('requires a present unexpired token and delegates usable tokens to the memory provider', async () => {
    const missing = coordinatorHarness();
    await expect(
      missing.coordinator.getProtocolCredentials(),
    ).rejects.toMatchObject({ code: 'reconnect-required' });
    expect(missing.credentials.get).not.toHaveBeenCalled();

    const expired = coordinatorHarness({
      settings: {
        get: () =>
          Promise.resolve(
            settings({
              byosConnection: connection({ expiresAt: NOW }),
            }),
          ),
        updateByosConnection: () => Promise.resolve(settings()),
      },
    });
    await expect(
      expired.coordinator.getProtocolCredentials(),
    ).rejects.toMatchObject({ code: 'reconnect-required' });

    const valid = coordinatorHarness({
      settings: {
        get: () => Promise.resolve(settings({ byosConnection: connection() })),
        updateByosConnection: () => Promise.resolve(settings()),
      },
    });
    await expect(valid.coordinator.getProtocolCredentials()).resolves.toEqual(
      protocolCredentials(),
    );
    expect(valid.credentials.get).toHaveBeenCalledWith('oauth-access-token');
  });

  it('clears credentials when an expected connection changes during issuance', async () => {
    const original = connection();
    const replacement = connection({
      accessToken: 'oauth-access-token-replacement',
      connectedAt: '2026-07-25T12:05:00.000Z',
      expiresAt: '2026-07-25T14:00:00.000Z',
    });
    let releaseCredentials:
      ((credentials: ByosProtocolCredentials) => void) | undefined;
    const issued = new Promise<ByosProtocolCredentials>((resolve) => {
      releaseCredentials = resolve;
    });
    const credentials = {
      get: vi.fn(() => issued),
      clear: vi.fn(),
    };
    const test = coordinatorHarness(
      { credentials },
      settings({ byosConnection: original }),
    );

    const acquiring = test.coordinator.getProtocolCredentials(original);
    await vi.waitFor(() => {
      expect(credentials.get).toHaveBeenCalledWith(original.accessToken);
    });
    await test.settingsPort.updateByosConnection(replacement);
    releaseCredentials?.(protocolCredentials());

    await expect(acquiring).rejects.toMatchObject({
      name: 'ByosError',
      code: 'reconnect-required',
    });
    expect(credentials.clear).toHaveBeenCalledOnce();
  });
});
