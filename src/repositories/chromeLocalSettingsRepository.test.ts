import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SETTINGS_V1,
  type ByosConnectionV1,
  type EditorMode,
  type SettingsRecordV1,
} from '../domain/settings';
import { IDENTITY_MIGRATION_JOURNAL_STORAGE_KEY } from '../services/identityMigrationPersistence';
import { InMemoryChromeStorage } from '../../test/inMemoryChromeStorage';
import {
  ChromeLocalSettingsRepository,
  SETTINGS_STORAGE_KEY,
} from './chromeLocalSettingsRepository';
import {
  RepositoryPendingIdentityMigrationError,
  RepositoryStoredDataError,
  RepositoryStorageError,
  RepositoryValidationError,
} from './repositoryErrors';

function settings(overrides: Partial<SettingsRecordV1> = {}): SettingsRecordV1 {
  return {
    schemaVersion: 1,
    editorMode: 'text-focused-blocks',
    pageIdentityExclusions: [],
    ...overrides,
  };
}

describe('ChromeLocalSettingsRepository', () => {
  it('returns useful defaults for absent settings without writing them', async () => {
    const storage = new InMemoryChromeStorage();
    const repository = new ChromeLocalSettingsRepository(storage);

    await expect(repository.get()).resolves.toEqual(DEFAULT_SETTINGS_V1);
    expect(storage.setCalls).toEqual([]);
    expect(storage.snapshot()).toEqual({});
  });

  it('returns a fresh defensive copy of absent defaults', async () => {
    const repository = new ChromeLocalSettingsRepository(
      new InMemoryChromeStorage(),
    );
    const first = await repository.get();

    (first.pageIdentityExclusions as PageIdentityExclusionRuleLike[]).push({
      origin: 'https://mutated.example',
      parameterNames: ['tracking'],
    });

    await expect(repository.get()).resolves.toEqual(DEFAULT_SETTINGS_V1);
  });

  it('migrates the explicit minimal v0 envelope once and persists v1', async () => {
    const storage = new InMemoryChromeStorage({
      [SETTINGS_STORAGE_KEY]: {
        schemaVersion: 0,
        editorMode: 'paragraphs-only',
      },
    });
    const repository = new ChromeLocalSettingsRepository(storage);
    const migrated = settings({ editorMode: 'paragraphs-only' });

    await expect(repository.get()).resolves.toEqual(migrated);
    expect(storage.snapshot()[SETTINGS_STORAGE_KEY]).toEqual(migrated);
    expect(storage.setCalls).toHaveLength(1);

    await expect(repository.get()).resolves.toEqual(migrated);
    expect(storage.setCalls).toHaveLength(1);
  });

  it('preserves v0 settings when migration persistence fails and retries cleanly', async () => {
    const legacy = {
      schemaVersion: 0,
      editorMode: 'paragraphs-only',
    } as const;
    const storage = new InMemoryChromeStorage({
      [SETTINGS_STORAGE_KEY]: legacy,
    });
    const repository = new ChromeLocalSettingsRepository(storage);
    const migrationCause = new Error('quota exceeded');
    storage.failNextSet(migrationCause);

    await expect(repository.get()).rejects.toMatchObject({
      name: 'RepositoryStorageError',
      operation: 'put',
      cause: migrationCause,
    });
    expect(storage.snapshot()[SETTINGS_STORAGE_KEY]).toEqual(legacy);

    await expect(repository.get()).resolves.toEqual(
      settings({ editorMode: 'paragraphs-only' }),
    );
  });

  it.each([
    [
      'a malformed envelope',
      { schemaVersion: 1, editorMode: 'unknown' },
      'malformed',
    ],
    [
      'an unknown legacy envelope',
      { schemaVersion: 0, editorMode: 'paragraphs-only', legacyExtra: true },
      'malformed',
    ],
    [
      'a future envelope',
      { schemaVersion: 2, editorMode: 'future-mode' },
      'future-schema',
    ],
  ] as const)(
    'preserves and reports %s',
    async (_description, storedValue, expectedKind) => {
      const storage = new InMemoryChromeStorage({
        [SETTINGS_STORAGE_KEY]: storedValue,
      });
      const repository = new ChromeLocalSettingsRepository(storage);

      await expect(repository.get()).rejects.toMatchObject({
        name: 'RepositoryStoredDataError',
        kind: expectedKind,
        storageKey: SETTINGS_STORAGE_KEY,
      });
      expect(storage.snapshot()[SETTINGS_STORAGE_KEY]).toEqual(storedValue);
      expect(storage.setCalls).toEqual([]);
    },
  );

  it('round-trips settings and isolates nested input and returned values', async () => {
    const storage = new InMemoryChromeStorage();
    const repository = new ChromeLocalSettingsRepository(storage);
    const original = settings({
      editorMode: 'paragraphs-only',
      pageIdentityExclusions: [
        {
          origin: 'https://example.com',
          parameterNames: ['session', 'campaign'],
        },
      ],
      byosConnection: {
        accessToken: 'oauth-token',
        expiresAt: '2026-08-01T11:59:00.000Z',
        connectedAt: '2026-07-25T10:00:00.000Z',
        lastSuccessfulSyncAt: '2026-07-25T10:10:00Z',
      },
    });

    const pendingPut = repository.put(original);
    (original.pageIdentityExclusions[0]?.parameterNames as string[]).push(
      'mutated-after-put',
    );
    if (original.byosConnection !== undefined) {
      (original.byosConnection as { accessToken: string }).accessToken =
        'mutated-after-put';
    }
    await pendingPut;

    const firstRead = await repository.get();
    expect(firstRead).toEqual(
      settings({
        editorMode: 'paragraphs-only',
        pageIdentityExclusions: [
          {
            origin: 'https://example.com',
            parameterNames: ['session', 'campaign'],
          },
        ],
        byosConnection: {
          accessToken: 'oauth-token',
          expiresAt: '2026-08-01T11:59:00.000Z',
          connectedAt: '2026-07-25T10:00:00.000Z',
          lastSuccessfulSyncAt: '2026-07-25T10:10:00Z',
        },
      }),
    );

    (firstRead.pageIdentityExclusions[0]?.parameterNames as string[]).push(
      'mutated-after-get',
    );
    if (firstRead.byosConnection !== undefined) {
      (firstRead.byosConnection as { accessToken: string }).accessToken =
        'mutated-after-get';
    }

    await expect(repository.get()).resolves.not.toEqual(firstRead);
  });

  it('atomically updates only editor mode on the latest v1 record and returns a defensive clone', async () => {
    const latest = settings({
      pageIdentityExclusions: [
        { origin: 'https://example.com', parameterNames: ['session'] },
      ],
      byosConnection: {
        accessToken: 'latest-token',
        expiresAt: '2026-08-01T11:59:00Z',
        connectedAt: '2026-07-25T10:00:00Z',
        lastSuccessfulSyncAt: '2026-07-25T10:10:00Z',
      },
    });
    const storage = new InMemoryChromeStorage({
      [SETTINGS_STORAGE_KEY]: latest,
    });
    const repository = new ChromeLocalSettingsRepository(storage);
    const updated = await repository.updateEditorMode('paragraphs-only');
    const expected = { ...latest, editorMode: 'paragraphs-only' as const };

    expect(updated).toEqual(expected);
    expect(storage.snapshot()).toEqual({ [SETTINGS_STORAGE_KEY]: expected });
    expect(storage.getCalls).toEqual([
      [IDENTITY_MIGRATION_JOURNAL_STORAGE_KEY, SETTINGS_STORAGE_KEY],
    ]);
    expect(storage.setCalls).toEqual([{ [SETTINGS_STORAGE_KEY]: expected }]);

    (updated.pageIdentityExclusions[0]?.parameterNames as string[]).push(
      'mutated',
    );
    if (updated.byosConnection !== undefined) {
      (updated.byosConnection as { accessToken: string }).accessToken =
        'mutated';
    }
    expect(storage.snapshot()[SETTINGS_STORAGE_KEY]).toEqual(expected);
  });

  it.each([
    ['absent defaults', undefined],
    ['understood v0', { schemaVersion: 0, editorMode: 'text-focused-blocks' }],
  ])(
    'updates editor mode while safely materializing %s',
    async (_label, stored) => {
      const storage = new InMemoryChromeStorage(
        stored === undefined ? {} : { [SETTINGS_STORAGE_KEY]: stored },
      );
      const repository = new ChromeLocalSettingsRepository(storage);

      await expect(
        repository.updateEditorMode('paragraphs-only'),
      ).resolves.toEqual(settings({ editorMode: 'paragraphs-only' }));
      expect(storage.snapshot()[SETTINGS_STORAGE_KEY]).toEqual(
        settings({ editorMode: 'paragraphs-only' }),
      );
      expect(storage.setCalls).toHaveLength(1);
    },
  );

  it('rejects an invalid editor mode before touching storage', async () => {
    const storage = new InMemoryChromeStorage();
    const repository = new ChromeLocalSettingsRepository(storage);

    await expect(
      repository.updateEditorMode('invalid' as EditorMode),
    ).rejects.toBeInstanceOf(RepositoryValidationError);
    expect(storage.getCalls).toEqual([]);
    expect(storage.setCalls).toEqual([]);
  });

  it('atomically connects and disconnects BYOS while preserving the latest editor and exclusion settings', async () => {
    const current = settings({
      editorMode: 'paragraphs-only',
      pageIdentityExclusions: [
        { origin: 'https://example.com', parameterNames: ['session'] },
      ],
    });
    const connection: ByosConnectionV1 = {
      accessToken: 'oauth-token',
      expiresAt: '2026-08-01T11:59:00Z',
      connectedAt: '2026-07-25T10:00:00Z',
    };
    const storage = new InMemoryChromeStorage({
      [SETTINGS_STORAGE_KEY]: current,
    });
    const repository = new ChromeLocalSettingsRepository(storage);
    const connected = await repository.updateByosConnection(connection);

    expect(connected).toEqual({ ...current, byosConnection: connection });
    expect(storage.snapshot()[SETTINGS_STORAGE_KEY]).toEqual(connected);
    (connection as { accessToken: string }).accessToken = 'mutated-input';
    (connected.byosConnection as { accessToken: string }).accessToken =
      'mutated-output';
    expect(
      (storage.snapshot()[SETTINGS_STORAGE_KEY] as SettingsRecordV1)
        .byosConnection?.accessToken,
    ).toBe('oauth-token');

    await expect(repository.updateByosConnection(undefined)).resolves.toEqual(
      current,
    );
    expect(storage.snapshot()).toEqual({ [SETTINGS_STORAGE_KEY]: current });
  });

  it.each([
    ['absent defaults', undefined],
    ['understood v0', { schemaVersion: 0, editorMode: 'paragraphs-only' }],
  ])('connects BYOS while safely materializing %s', async (_label, stored) => {
    const connection: ByosConnectionV1 = {
      accessToken: 'oauth-token',
      expiresAt: '2026-08-01T11:59:00Z',
      connectedAt: '2026-07-25T10:00:00Z',
    };
    const storage = new InMemoryChromeStorage(
      stored === undefined ? {} : { [SETTINGS_STORAGE_KEY]: stored },
    );
    const repository = new ChromeLocalSettingsRepository(storage);
    const expected = settings({
      editorMode:
        stored === undefined ? 'text-focused-blocks' : 'paragraphs-only',
      byosConnection: connection,
    });

    await expect(repository.updateByosConnection(connection)).resolves.toEqual(
      expected,
    );
    expect(storage.snapshot()[SETTINGS_STORAGE_KEY]).toEqual(expected);
  });

  it('rejects invalid settings writes and never persists S3 credentials or account identity', async () => {
    const storage = new InMemoryChromeStorage();
    const repository = new ChromeLocalSettingsRepository(storage);
    const invalid = {
      ...settings(),
      byosConnection: {
        accessToken: 'oauth-token',
        expiresAt: '2026-08-01T11:59:00Z',
        connectedAt: '2026-07-25T10:00:00Z',
        accessKeyId: 's3-key',
        secretAccessKey: 's3-secret',
        bucket: 'private-bucket',
        accountId: 'private-account',
      },
    } as unknown as SettingsRecordV1;

    await expect(repository.put(invalid)).rejects.toBeInstanceOf(
      RepositoryValidationError,
    );
    await expect(
      repository.updateByosConnection(invalid.byosConnection),
    ).rejects.toBeInstanceOf(RepositoryValidationError);
    expect(storage.snapshot()).toEqual({});
    expect(storage.getCalls).toEqual([]);
  });

  it('persists only account-independent OAuth metadata for a valid BYOS connection', async () => {
    const storage = new InMemoryChromeStorage();
    const repository = new ChromeLocalSettingsRepository(storage);

    await repository.put(
      settings({
        byosConnection: {
          accessToken: 'oauth-token',
          expiresAt: '2026-08-01T11:59:00Z',
          connectedAt: '2026-07-25T10:00:00Z',
        },
      }),
    );

    const serialized = JSON.stringify(storage.snapshot());
    expect(serialized).toContain('oauth-token');
    expect(serialized).not.toMatch(
      /accessKeyId|secretAccessKey|bucket|accountId|accountIdentity/u,
    );
  });

  it('does not overwrite malformed or future settings through put or editor-mode update', async () => {
    const future = { schemaVersion: 4, retained: 'recover me' };
    const storage = new InMemoryChromeStorage({
      [SETTINGS_STORAGE_KEY]: future,
    });
    const repository = new ChromeLocalSettingsRepository(storage);

    await expect(repository.put(settings())).rejects.toBeInstanceOf(
      RepositoryStoredDataError,
    );
    await expect(
      repository.updateEditorMode('paragraphs-only'),
    ).rejects.toBeInstanceOf(RepositoryStoredDataError);
    await expect(
      repository.updateByosConnection({
        accessToken: 'oauth-token',
        expiresAt: '2026-08-01T11:59:00Z',
        connectedAt: '2026-07-25T10:00:00Z',
      }),
    ).rejects.toBeInstanceOf(RepositoryStoredDataError);
    expect(storage.snapshot()[SETTINGS_STORAGE_KEY]).toEqual(future);
    expect(storage.setCalls).toEqual([]);
  });

  it.each([
    ['versioned', { schemaVersion: 1, phase: 'planned' }],
    ['malformed', { partial: true }],
    ['future', { schemaVersion: 99, future: true }],
  ])(
    'blocks settings writes for any %s identity migration journal and resumes normal behavior after removal',
    async (_description, journal) => {
      const existing = settings({ editorMode: 'paragraphs-only' });
      const requested = settings({
        pageIdentityExclusions: [
          { origin: 'https://example.com', parameterNames: ['session'] },
        ],
      });
      const storage = new InMemoryChromeStorage({
        [IDENTITY_MIGRATION_JOURNAL_STORAGE_KEY]: journal,
        [SETTINGS_STORAGE_KEY]: existing,
      });
      const repository = new ChromeLocalSettingsRepository(storage);

      await expect(repository.put(requested)).rejects.toMatchObject({
        name: 'RepositoryPendingIdentityMigrationError',
        code: 'pending-identity-migration',
        operation: 'put',
        message:
          'PagePerch data cannot be changed while an identity migration is pending. Retry after the migration finishes.',
      });
      await expect(
        repository.updateEditorMode('text-focused-blocks'),
      ).rejects.toMatchObject({
        name: 'RepositoryPendingIdentityMigrationError',
        code: 'pending-identity-migration',
        operation: 'put',
      });
      await expect(
        repository.updateByosConnection({
          accessToken: 'oauth-token',
          expiresAt: '2026-08-01T11:59:00Z',
          connectedAt: '2026-07-25T10:00:00Z',
        }),
      ).rejects.toMatchObject({
        name: 'RepositoryPendingIdentityMigrationError',
        code: 'pending-identity-migration',
        operation: 'put',
      });
      expect(storage.snapshot()[SETTINGS_STORAGE_KEY]).toEqual(existing);
      expect(storage.setCalls).toEqual([]);
      await expect(repository.get()).resolves.toEqual(existing);

      await storage.remove(IDENTITY_MIGRATION_JOURNAL_STORAGE_KEY);
      storage.resetCalls();

      await expect(
        repository.updateEditorMode('text-focused-blocks'),
      ).resolves.toEqual(settings());
      expect(storage.snapshot()[SETTINGS_STORAGE_KEY]).toEqual(settings());
      expect(storage.setCalls).toHaveLength(1);
    },
  );

  it('exposes a stable typed pending-migration error without accepting sensitive message input', () => {
    const error = new RepositoryPendingIdentityMigrationError('put');

    expect(error).toMatchObject({
      name: 'RepositoryPendingIdentityMigrationError',
      code: 'pending-identity-migration',
      operation: 'put',
    });
    expect(error.message).not.toContain('https://');
  });

  it('serializes concurrent settings writes across repository instances', async () => {
    const storage = new InMemoryChromeStorage();
    const firstRepository = new ChromeLocalSettingsRepository(storage);
    const secondRepository = new ChromeLocalSettingsRepository(storage);
    const first = settings({ editorMode: 'paragraphs-only' });
    const second = settings({
      editorMode: 'text-focused-blocks',
      pageIdentityExclusions: [
        {
          origin: 'https://example.com',
          parameterNames: ['session'],
        },
      ],
    });

    await Promise.all([
      firstRepository.put(first),
      secondRepository.put(second),
    ]);

    await expect(firstRepository.get()).resolves.toEqual(second);
  });

  it('wraps read and write failures and keeps the operation queue usable', async () => {
    const storage = new InMemoryChromeStorage();
    const repository = new ChromeLocalSettingsRepository(storage);

    storage.failNextGet(new Error('profile unavailable'));
    await expect(repository.get()).rejects.toMatchObject({
      name: 'RepositoryStorageError',
      operation: 'get',
    });

    storage.failNextSet(new Error('quota exceeded'));
    await expect(repository.put(settings())).rejects.toBeInstanceOf(
      RepositoryStorageError,
    );
    await expect(
      repository.put(settings({ editorMode: 'paragraphs-only' })),
    ).resolves.toBeUndefined();
    await expect(repository.get()).resolves.toMatchObject({
      editorMode: 'paragraphs-only',
    });
  });
});

interface PageIdentityExclusionRuleLike {
  origin: string;
  parameterNames: string[];
}
