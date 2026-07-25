import type { NoteRecordV1 } from '../domain/note';
import { IDENTITY_MIGRATION_JOURNAL_STORAGE_KEY } from '../services/identityMigrationPersistence';
import type { NoteRepository } from './noteRepository';
import {
  enqueueStorageOperation,
  resolveChromeLocalStorageArea,
  storageGet,
  storageRemove,
  storageSet,
  type PromiseChromeStorageArea,
} from './chromeStorage';
import {
  RepositoryPendingIdentityMigrationError,
  RepositoryStoredDataError,
  RepositoryValidationError,
  type RepositoryOperation,
} from './repositoryErrors';
import {
  isExactHttpOrigin,
  isNoteRecordV1,
  isPageKey,
  readSchemaVersion,
} from './validation';

export const NOTE_STORAGE_KEY_PREFIX = 'pageperch:v1:notes:';
export const NOTE_ORIGIN_INDEX_KEY_PREFIX = 'pageperch:v1:note-origin-indexes:';

export const NOTE_ORIGIN_INDEX_SCHEMA_VERSION = 1 as const;

export interface NoteOriginIndexV1 {
  readonly schemaVersion: typeof NOTE_ORIGIN_INDEX_SCHEMA_VERSION;
  readonly origin: string;
  readonly pageKeys: readonly string[];
}

export function getNoteStorageKey(pageKey: string): string {
  return `${NOTE_STORAGE_KEY_PREFIX}${pageKey}`;
}

export function getNoteOriginIndexStorageKey(origin: string): string {
  return `${NOTE_ORIGIN_INDEX_KEY_PREFIX}${encodeURIComponent(origin)}`;
}

function cloneNote(record: NoteRecordV1): NoteRecordV1 {
  return { ...record };
}

function cloneIndex(index: NoteOriginIndexV1): NoteOriginIndexV1 {
  return { ...index, pageKeys: [...index.pageKeys] };
}

export function isNoteOriginIndexV1(
  value: unknown,
  expectedOrigin: string,
): value is NoteOriginIndexV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate);

  return (
    keys.length === 3 &&
    keys.every((key) =>
      ['schemaVersion', 'origin', 'pageKeys'].includes(key),
    ) &&
    candidate.schemaVersion === NOTE_ORIGIN_INDEX_SCHEMA_VERSION &&
    isExactHttpOrigin(candidate.origin) &&
    candidate.origin === expectedOrigin &&
    Array.isArray(candidate.pageKeys) &&
    candidate.pageKeys.every(isPageKey) &&
    new Set(candidate.pageKeys).size === candidate.pageKeys.length
  );
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}

function storedDataError(
  storageKey: string,
  value: unknown,
  dataDescription: string,
): RepositoryStoredDataError {
  const schemaVersion = readSchemaVersion(value);
  const isFuture =
    schemaVersion !== undefined &&
    schemaVersion > NOTE_ORIGIN_INDEX_SCHEMA_VERSION;

  return new RepositoryStoredDataError(
    isFuture ? 'future-schema' : 'malformed',
    storageKey,
    isFuture
      ? `${dataDescription} uses unsupported schema version ${String(schemaVersion)} and was left untouched.`
      : `${dataDescription} is malformed and was left untouched for recovery.`,
  );
}

export class ChromeLocalNoteRepository implements NoteRepository {
  readonly #storageArea: PromiseChromeStorageArea;

  constructor(storageArea?: PromiseChromeStorageArea) {
    this.#storageArea = resolveChromeLocalStorageArea(storageArea);
  }

  async get(pageKey: string): Promise<NoteRecordV1 | undefined> {
    this.#assertPageKey(pageKey, 'get');

    return this.#enqueue(async () => {
      const storageKey = getNoteStorageKey(pageKey);
      const stored = await storageGet(this.#storageArea, storageKey, 'get');
      const value = stored[storageKey];

      if (value === undefined) {
        return undefined;
      }

      if (
        !isNoteRecordV1(value) ||
        value.pageKey !== pageKey ||
        getNoteStorageKey(value.pageKey) !== storageKey
      ) {
        throw storedDataError(storageKey, value, 'The stored note record');
      }

      return cloneNote(value);
    });
  }

  async put(record: NoteRecordV1): Promise<void> {
    if (!isNoteRecordV1(record)) {
      throw new RepositoryValidationError(
        'put',
        'Cannot store an invalid NoteRecordV1.',
      );
    }

    const recordSnapshot = cloneNote(record);

    return this.#enqueue(async () => {
      const noteStorageKey = getNoteStorageKey(recordSnapshot.pageKey);
      const existingValues = await storageGet(
        this.#storageArea,
        [IDENTITY_MIGRATION_JOURNAL_STORAGE_KEY, noteStorageKey],
        'put',
      );

      if (
        Object.prototype.hasOwnProperty.call(
          existingValues,
          IDENTITY_MIGRATION_JOURNAL_STORAGE_KEY,
        )
      ) {
        throw new RepositoryPendingIdentityMigrationError('put');
      }

      const existingValue = existingValues[noteStorageKey];
      let existingRecord: NoteRecordV1 | undefined;

      if (existingValue !== undefined) {
        if (
          !isNoteRecordV1(existingValue) ||
          existingValue.pageKey !== recordSnapshot.pageKey
        ) {
          throw storedDataError(
            noteStorageKey,
            existingValue,
            'The existing note record',
          );
        }

        existingRecord = existingValue;
      }

      const origins = new Set([recordSnapshot.origin]);

      if (existingRecord !== undefined) {
        origins.add(existingRecord.origin);
      }

      const indexKeys = [...origins].map(getNoteOriginIndexStorageKey);
      const storedIndexes = await storageGet(
        this.#storageArea,
        indexKeys,
        'put',
      );
      const indexes = new Map<string, NoteOriginIndexV1>();

      for (const origin of origins) {
        const indexStorageKey = getNoteOriginIndexStorageKey(origin);
        const storedIndex = storedIndexes[indexStorageKey];

        if (storedIndex === undefined) {
          indexes.set(origin, {
            schemaVersion: NOTE_ORIGIN_INDEX_SCHEMA_VERSION,
            origin,
            pageKeys: [],
          });
          continue;
        }

        if (!isNoteOriginIndexV1(storedIndex, origin)) {
          throw storedDataError(
            indexStorageKey,
            storedIndex,
            'The existing note origin index',
          );
        }

        indexes.set(origin, cloneIndex(storedIndex));
      }

      const changes: Record<string, unknown> = {
        [noteStorageKey]: recordSnapshot,
      };

      if (
        existingRecord !== undefined &&
        existingRecord.origin !== recordSnapshot.origin
      ) {
        const oldIndex = indexes.get(existingRecord.origin);

        if (oldIndex !== undefined) {
          changes[getNoteOriginIndexStorageKey(existingRecord.origin)] = {
            ...oldIndex,
            pageKeys: oldIndex.pageKeys.filter(
              (pageKey) => pageKey !== recordSnapshot.pageKey,
            ),
          } satisfies NoteOriginIndexV1;
        }
      }

      const newIndex = indexes.get(recordSnapshot.origin);

      if (newIndex === undefined) {
        throw new Error('Expected a note origin index for the record origin.');
      }

      changes[getNoteOriginIndexStorageKey(recordSnapshot.origin)] = {
        ...newIndex,
        pageKeys: [
          ...new Set([...newIndex.pageKeys, recordSnapshot.pageKey]),
        ].sort(),
      } satisfies NoteOriginIndexV1;

      await storageSet(this.#storageArea, changes, 'put');
    });
  }

  async delete(pageKey: string): Promise<void> {
    this.#assertPageKey(pageKey, 'delete');

    return this.#enqueue(async () => {
      const noteStorageKey = getNoteStorageKey(pageKey);
      const stored = await storageGet(
        this.#storageArea,
        [IDENTITY_MIGRATION_JOURNAL_STORAGE_KEY, noteStorageKey],
        'delete',
      );

      if (
        Object.prototype.hasOwnProperty.call(
          stored,
          IDENTITY_MIGRATION_JOURNAL_STORAGE_KEY,
        )
      ) {
        throw new RepositoryPendingIdentityMigrationError('delete');
      }

      const storedRecord = stored[noteStorageKey];

      if (storedRecord === undefined) {
        await this.#removeDanglingIndexMemberships(pageKey);
        return;
      }

      if (!isNoteRecordV1(storedRecord) || storedRecord.pageKey !== pageKey) {
        throw storedDataError(
          noteStorageKey,
          storedRecord,
          'The existing note record',
        );
      }

      const indexStorageKey = getNoteOriginIndexStorageKey(storedRecord.origin);
      const storedIndexValues = await storageGet(
        this.#storageArea,
        indexStorageKey,
        'delete',
      );
      const storedIndex = storedIndexValues[indexStorageKey];

      if (
        storedIndex !== undefined &&
        !isNoteOriginIndexV1(storedIndex, storedRecord.origin)
      ) {
        throw storedDataError(
          indexStorageKey,
          storedIndex,
          'The existing note origin index',
        );
      }

      await storageRemove(this.#storageArea, noteStorageKey);

      if (storedIndex !== undefined) {
        await storageSet(
          this.#storageArea,
          {
            [indexStorageKey]: {
              ...storedIndex,
              pageKeys: storedIndex.pageKeys.filter(
                (indexedPageKey) => indexedPageKey !== pageKey,
              ),
            } satisfies NoteOriginIndexV1,
          },
          'delete',
        );
      }
    });
  }

  async listByOrigin(origin: string): Promise<readonly NoteRecordV1[]> {
    if (!isExactHttpOrigin(origin)) {
      throw new RepositoryValidationError(
        'list',
        'Cannot list notes for an invalid exact HTTP(S) origin.',
      );
    }

    return this.#enqueue(async () => {
      const indexStorageKey = getNoteOriginIndexStorageKey(origin);
      const storedIndexValues = await storageGet(
        this.#storageArea,
        indexStorageKey,
        'list',
      );
      const storedIndex = storedIndexValues[indexStorageKey];

      if (storedIndex === undefined) {
        return [];
      }

      if (!isNoteOriginIndexV1(storedIndex, origin)) {
        throw storedDataError(
          indexStorageKey,
          storedIndex,
          'The stored note origin index',
        );
      }

      const noteStorageKeys = storedIndex.pageKeys
        .map(getNoteStorageKey)
        .sort(compareCodeUnits);

      if (noteStorageKeys.length === 0) {
        return [];
      }

      const storedNotes = await storageGet(
        this.#storageArea,
        noteStorageKeys,
        'list',
      );

      return noteStorageKeys.flatMap((storageKey) => {
        const value = storedNotes[storageKey];

        if (value === undefined) {
          return [];
        }

        if (
          !isNoteRecordV1(value) ||
          getNoteStorageKey(value.pageKey) !== storageKey ||
          value.origin !== origin
        ) {
          throw storedDataError(storageKey, value, 'The indexed note record');
        }

        return [cloneNote(value)];
      });
    });
  }

  async listAll(): Promise<readonly NoteRecordV1[]> {
    return this.#enqueue(async () => {
      const stored = await storageGet(this.#storageArea, null, 'list');

      return Object.entries(stored)
        .filter(([storageKey]) =>
          storageKey.startsWith(NOTE_STORAGE_KEY_PREFIX),
        )
        .sort(([leftKey], [rightKey]) => compareCodeUnits(leftKey, rightKey))
        .map(([storageKey, value]) => {
          if (
            !isNoteRecordV1(value) ||
            getNoteStorageKey(value.pageKey) !== storageKey
          ) {
            throw storedDataError(storageKey, value, 'The stored note record');
          }

          return cloneNote(value);
        });
    });
  }

  #assertPageKey(pageKey: string, operation: RepositoryOperation): void {
    if (!isPageKey(pageKey)) {
      throw new RepositoryValidationError(
        operation,
        'A page key must be exactly 43 base64url characters.',
      );
    }
  }

  async #removeDanglingIndexMemberships(pageKey: string): Promise<void> {
    const stored = await storageGet(this.#storageArea, null, 'delete');
    const changes: Record<string, NoteOriginIndexV1> = {};

    for (const [storageKey, value] of Object.entries(stored)) {
      if (!storageKey.startsWith(NOTE_ORIGIN_INDEX_KEY_PREFIX)) {
        continue;
      }

      let candidateOrigin: string | undefined;

      if (
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value)
      ) {
        const origin = (value as Record<string, unknown>).origin;

        if (typeof origin === 'string') {
          candidateOrigin = origin;
        }
      }

      if (
        candidateOrigin === undefined ||
        !isNoteOriginIndexV1(value, candidateOrigin) ||
        getNoteOriginIndexStorageKey(candidateOrigin) !== storageKey ||
        !value.pageKeys.includes(pageKey)
      ) {
        continue;
      }

      changes[storageKey] = {
        ...value,
        pageKeys: value.pageKeys.filter(
          (indexedPageKey) => indexedPageKey !== pageKey,
        ),
      };
    }

    if (Object.keys(changes).length > 0) {
      await storageSet(this.#storageArea, changes, 'delete');
    }
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    return enqueueStorageOperation(this.#storageArea, operation);
  }
}
