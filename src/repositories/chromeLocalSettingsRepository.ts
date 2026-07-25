import {
  DEFAULT_SETTINGS_V1,
  SETTINGS_SCHEMA_VERSION,
  type ByosConnectionV1,
  type EditorMode,
  type SettingsRecordV0,
  type SettingsRecordV1,
} from '../domain/settings';
import { IDENTITY_MIGRATION_JOURNAL_STORAGE_KEY } from '../services/identityMigrationPersistence';
import type {
  SettingsConnectionCasResult,
  SettingsRepository,
} from './settingsRepository';
import {
  enqueueStorageOperation,
  resolveChromeLocalStorageArea,
  storageGet,
  storageSet,
  type PromiseChromeStorageArea,
} from './chromeStorage';
import {
  RepositoryPendingIdentityMigrationError,
  RepositoryStoredDataError,
  RepositoryValidationError,
} from './repositoryErrors';
import {
  isSettingsRecordV0,
  isSettingsRecordV1,
  readSchemaVersion,
} from './validation';

export const SETTINGS_STORAGE_KEY = 'pageperch:v1:settings';

function cloneSettings(settings: SettingsRecordV1): SettingsRecordV1 {
  const cloned: SettingsRecordV1 = {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    editorMode: settings.editorMode,
    showRecentNotesOnOrigin: settings.showRecentNotesOnOrigin,
    pageIdentityExclusions: settings.pageIdentityExclusions.map((rule) => ({
      origin: rule.origin,
      parameterNames: [...rule.parameterNames],
    })),
    ...(settings.byosConnection === undefined
      ? {}
      : { byosConnection: { ...settings.byosConnection } }),
  };

  return cloned;
}

function migrateSettingsV0(settings: SettingsRecordV0): SettingsRecordV1 {
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    editorMode: settings.editorMode,
    showRecentNotesOnOrigin: false,
    pageIdentityExclusions: [],
  };
}

function isEditorMode(value: unknown): value is EditorMode {
  return value === 'text-focused-blocks' || value === 'paragraphs-only';
}

function isByosConnection(
  value: unknown,
): value is ByosConnectionV1 | undefined {
  return (
    value === undefined ||
    isSettingsRecordV1({
      ...DEFAULT_SETTINGS_V1,
      byosConnection: value,
    })
  );
}

function isSameConnectionIdentity(
  left: ByosConnectionV1 | undefined,
  right: ByosConnectionV1,
): boolean {
  return (
    left !== undefined &&
    left.accessToken === right.accessToken &&
    left.expiresAt === right.expiresAt &&
    left.connectedAt === right.connectedAt
  );
}

function invalidStoredSettings(value: unknown): RepositoryStoredDataError {
  const schemaVersion = readSchemaVersion(value);
  const isFuture =
    schemaVersion !== undefined && schemaVersion > SETTINGS_SCHEMA_VERSION;

  return new RepositoryStoredDataError(
    isFuture ? 'future-schema' : 'malformed',
    SETTINGS_STORAGE_KEY,
    isFuture
      ? `Stored PagePerch settings use unsupported schema version ${String(schemaVersion)}. Update PagePerch before editing settings; the stored value was left untouched.`
      : 'Stored PagePerch settings are malformed. Recover or clear them explicitly before editing settings; the stored value was left untouched.',
  );
}

export class ChromeLocalSettingsRepository implements SettingsRepository {
  readonly #storageArea: PromiseChromeStorageArea;

  constructor(storageArea?: PromiseChromeStorageArea) {
    this.#storageArea = resolveChromeLocalStorageArea(storageArea);
  }

  async get(): Promise<SettingsRecordV1> {
    return this.#enqueue(async () => {
      const stored = await storageGet(
        this.#storageArea,
        SETTINGS_STORAGE_KEY,
        'get',
      );
      const value = stored[SETTINGS_STORAGE_KEY];

      if (value === undefined) {
        return cloneSettings(DEFAULT_SETTINGS_V1);
      }

      if (isSettingsRecordV1(value)) {
        return cloneSettings(value);
      }

      if (isSettingsRecordV0(value)) {
        // Product decision: only the explicitly understood legacy envelope is upgraded automatically.
        const migrated = migrateSettingsV0(value);
        await storageSet(
          this.#storageArea,
          { [SETTINGS_STORAGE_KEY]: migrated },
          'put',
        );

        return cloneSettings(migrated);
      }

      throw invalidStoredSettings(value);
    });
  }

  async put(settings: SettingsRecordV1): Promise<void> {
    if (!isSettingsRecordV1(settings)) {
      throw new RepositoryValidationError(
        'put',
        'Cannot store invalid PagePerch settings.',
      );
    }

    const settingsSnapshot = cloneSettings(settings);

    return this.#enqueue(async () => {
      const stored = await storageGet(
        this.#storageArea,
        [IDENTITY_MIGRATION_JOURNAL_STORAGE_KEY, SETTINGS_STORAGE_KEY],
        'put',
      );

      if (
        Object.prototype.hasOwnProperty.call(
          stored,
          IDENTITY_MIGRATION_JOURNAL_STORAGE_KEY,
        )
      ) {
        throw new RepositoryPendingIdentityMigrationError('put');
      }

      const existingValue = stored[SETTINGS_STORAGE_KEY];

      if (
        existingValue !== undefined &&
        !isSettingsRecordV0(existingValue) &&
        !isSettingsRecordV1(existingValue)
      ) {
        throw invalidStoredSettings(existingValue);
      }

      await storageSet(
        this.#storageArea,
        { [SETTINGS_STORAGE_KEY]: settingsSnapshot },
        'put',
      );
    });
  }

  async updateEditorMode(editorMode: EditorMode): Promise<SettingsRecordV1> {
    if (!isEditorMode(editorMode)) {
      throw new RepositoryValidationError(
        'put',
        'Cannot store an invalid PagePerch editor mode.',
      );
    }

    return this.#enqueue(async () => {
      const stored = await storageGet(
        this.#storageArea,
        [IDENTITY_MIGRATION_JOURNAL_STORAGE_KEY, SETTINGS_STORAGE_KEY],
        'put',
      );

      if (
        Object.prototype.hasOwnProperty.call(
          stored,
          IDENTITY_MIGRATION_JOURNAL_STORAGE_KEY,
        )
      ) {
        throw new RepositoryPendingIdentityMigrationError('put');
      }

      const existingValue = stored[SETTINGS_STORAGE_KEY];
      let currentSettings: SettingsRecordV1;

      if (existingValue === undefined) {
        currentSettings = cloneSettings(DEFAULT_SETTINGS_V1);
      } else if (isSettingsRecordV1(existingValue)) {
        currentSettings = cloneSettings(existingValue);
      } else if (isSettingsRecordV0(existingValue)) {
        currentSettings = migrateSettingsV0(existingValue);
      } else {
        throw invalidStoredSettings(existingValue);
      }

      const updated = { ...currentSettings, editorMode };
      await storageSet(
        this.#storageArea,
        { [SETTINGS_STORAGE_KEY]: updated },
        'put',
      );

      return cloneSettings(updated);
    });
  }

  async updateShowRecentNotesOnOrigin(
    showRecentNotesOnOrigin: boolean,
  ): Promise<SettingsRecordV1> {
    if (typeof showRecentNotesOnOrigin !== 'boolean') {
      throw new RepositoryValidationError(
        'put',
        'Cannot store an invalid PagePerch recent-notes preference.',
      );
    }

    return this.#enqueue(async () => {
      const stored = await storageGet(
        this.#storageArea,
        [IDENTITY_MIGRATION_JOURNAL_STORAGE_KEY, SETTINGS_STORAGE_KEY],
        'put',
      );

      if (
        Object.prototype.hasOwnProperty.call(
          stored,
          IDENTITY_MIGRATION_JOURNAL_STORAGE_KEY,
        )
      ) {
        throw new RepositoryPendingIdentityMigrationError('put');
      }

      const existingValue = stored[SETTINGS_STORAGE_KEY];
      let currentSettings: SettingsRecordV1;

      if (existingValue === undefined) {
        currentSettings = cloneSettings(DEFAULT_SETTINGS_V1);
      } else if (isSettingsRecordV1(existingValue)) {
        currentSettings = cloneSettings(existingValue);
      } else if (isSettingsRecordV0(existingValue)) {
        currentSettings = migrateSettingsV0(existingValue);
      } else {
        throw invalidStoredSettings(existingValue);
      }

      const updated = { ...currentSettings, showRecentNotesOnOrigin };
      await storageSet(
        this.#storageArea,
        { [SETTINGS_STORAGE_KEY]: updated },
        'put',
      );

      return cloneSettings(updated);
    });
  }

  async updateByosConnection(
    connection: ByosConnectionV1 | undefined,
  ): Promise<SettingsRecordV1> {
    if (!isByosConnection(connection)) {
      throw new RepositoryValidationError(
        'put',
        'Cannot store an invalid PagePerch BYOS connection.',
      );
    }

    const connectionSnapshot =
      connection === undefined ? undefined : { ...connection };

    return this.#enqueue(async () => {
      const stored = await storageGet(
        this.#storageArea,
        [IDENTITY_MIGRATION_JOURNAL_STORAGE_KEY, SETTINGS_STORAGE_KEY],
        'put',
      );

      if (
        Object.prototype.hasOwnProperty.call(
          stored,
          IDENTITY_MIGRATION_JOURNAL_STORAGE_KEY,
        )
      ) {
        throw new RepositoryPendingIdentityMigrationError('put');
      }

      const existingValue = stored[SETTINGS_STORAGE_KEY];
      let currentSettings: SettingsRecordV1;

      if (existingValue === undefined) {
        currentSettings = cloneSettings(DEFAULT_SETTINGS_V1);
      } else if (isSettingsRecordV1(existingValue)) {
        currentSettings = cloneSettings(existingValue);
      } else if (isSettingsRecordV0(existingValue)) {
        currentSettings = migrateSettingsV0(existingValue);
      } else {
        throw invalidStoredSettings(existingValue);
      }

      const updated: SettingsRecordV1 =
        connectionSnapshot === undefined
          ? {
              schemaVersion: currentSettings.schemaVersion,
              editorMode: currentSettings.editorMode,
              showRecentNotesOnOrigin: currentSettings.showRecentNotesOnOrigin,
              pageIdentityExclusions: currentSettings.pageIdentityExclusions,
            }
          : {
              ...currentSettings,
              byosConnection: connectionSnapshot,
            };
      await storageSet(
        this.#storageArea,
        { [SETTINGS_STORAGE_KEY]: updated },
        'put',
      );

      return cloneSettings(updated);
    });
  }

  async updateLastSuccessfulSyncAtIfCurrent(
    expectedConnection: ByosConnectionV1,
    lastSuccessfulSyncAt: string,
  ): Promise<SettingsConnectionCasResult> {
    if (
      !isByosConnection(expectedConnection) ||
      expectedConnection === undefined ||
      !isSettingsRecordV1({
        ...DEFAULT_SETTINGS_V1,
        byosConnection: {
          ...expectedConnection,
          lastSuccessfulSyncAt,
        },
      })
    ) {
      throw new RepositoryValidationError(
        'put',
        'Cannot store invalid PagePerch sync metadata.',
      );
    }

    const expectedSnapshot = { ...expectedConnection };

    return this.#enqueue(async () => {
      const stored = await storageGet(
        this.#storageArea,
        [IDENTITY_MIGRATION_JOURNAL_STORAGE_KEY, SETTINGS_STORAGE_KEY],
        'put',
      );

      if (
        Object.prototype.hasOwnProperty.call(
          stored,
          IDENTITY_MIGRATION_JOURNAL_STORAGE_KEY,
        )
      ) {
        throw new RepositoryPendingIdentityMigrationError('put');
      }

      const existingValue = stored[SETTINGS_STORAGE_KEY];

      const currentSettings = isSettingsRecordV1(existingValue)
        ? existingValue
        : undefined;

      if (currentSettings === undefined) {
        if (existingValue !== undefined && !isSettingsRecordV0(existingValue)) {
          throw invalidStoredSettings(existingValue);
        }

        return 'mismatch';
      }

      const currentConnection = currentSettings.byosConnection;

      if (
        currentConnection === undefined ||
        !isSameConnectionIdentity(currentConnection, expectedSnapshot)
      ) {
        return 'mismatch';
      }

      const updated: SettingsRecordV1 = {
        ...currentSettings,
        byosConnection: {
          ...currentConnection,
          lastSuccessfulSyncAt,
        },
      };
      await storageSet(
        this.#storageArea,
        { [SETTINGS_STORAGE_KEY]: updated },
        'put',
      );

      return 'applied';
    });
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    return enqueueStorageOperation(this.#storageArea, operation);
  }
}
