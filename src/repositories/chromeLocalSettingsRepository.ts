import {
  DEFAULT_SETTINGS_V1,
  SETTINGS_SCHEMA_VERSION,
  type SettingsRecordV0,
  type SettingsRecordV1,
} from '../domain/settings';
import { IDENTITY_MIGRATION_JOURNAL_STORAGE_KEY } from '../services/identityMigrationPersistence';
import type { SettingsRepository } from './settingsRepository';
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
    pageIdentityExclusions: [],
  };
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

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    return enqueueStorageOperation(this.#storageArea, operation);
  }
}
