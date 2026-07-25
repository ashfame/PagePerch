import type { NoteRecordV1 } from '../domain/note';
import {
  DEFAULT_SETTINGS_V1,
  SETTINGS_SCHEMA_VERSION,
  type SettingsRecordV1,
} from '../domain/settings';
import {
  fingerprintIdentityMigrationNote,
  fingerprintIdentityMigrationSettings,
  type IdentityMigrationDestinationWrite,
  type IdentityMigrationExpectedSource,
  type IdentityMigrationTombstoneWrite,
  type PlannedIdentityMigration,
} from '../services/identityMigration';
import {
  IDENTITY_MIGRATION_JOURNAL_STORAGE_KEY,
  IdentityMigrationJournalError,
  IdentityMigrationPersistenceError,
  type IdentityMigrationJournalPhase,
  type IdentityMigrationJournalV1,
  type IdentityMigrationPersistence,
  type IdentityMigrationPlanningSnapshot,
  parseIdentityMigrationJournal,
} from '../services/identityMigrationPersistence';
import {
  getNoteOriginIndexStorageKey,
  getNoteStorageKey,
  isNoteOriginIndexV1,
  NOTE_ORIGIN_INDEX_SCHEMA_VERSION,
  NOTE_STORAGE_KEY_PREFIX,
  type NoteOriginIndexV1,
} from './chromeLocalNoteRepository';
import { SETTINGS_STORAGE_KEY } from './chromeLocalSettingsRepository';
import {
  enqueueStorageOperation,
  resolveChromeLocalStorageArea,
  storageGet,
  storageRemove,
  storageSet,
  type PromiseChromeStorageArea,
} from './chromeStorage';
import { RepositoryStorageError } from './repositoryErrors';
import {
  isNoteRecordV1,
  isSettingsRecordV0,
  isSettingsRecordV1,
} from './validation';

interface StoredSettings {
  readonly exactRequested: boolean;
  readonly fingerprint: string;
  readonly record: SettingsRecordV1;
}

interface StoredNote {
  readonly fingerprint: string;
  readonly record: NoteRecordV1;
}

interface ValidatedOperationState {
  readonly affected: Map<string, StoredNote>;
  readonly allNotes: Map<string, StoredNote>;
  readonly destinationFingerprints: ReadonlyMap<string, string>;
  readonly expectedByKey: ReadonlyMap<string, IdentityMigrationExpectedSource>;
  readonly journal: IdentityMigrationJournalV1;
  readonly settings: StoredSettings;
  readonly tombstoneFingerprints: ReadonlyMap<string, string>;
  readonly index: NoteOriginIndexV1 | undefined;
}

const phaseOrder: Readonly<Record<IdentityMigrationJournalPhase, number>> = {
  planned: 0,
  'destinations-applied': 1,
  'tombstones-applied': 2,
  'settings-applied': 3,
};

function compareCodeUnits(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}

function cloneSettings(settings: SettingsRecordV1): SettingsRecordV1 {
  return {
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
}

function cloneNote(record: NoteRecordV1): NoteRecordV1 {
  return { ...record };
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value;
  }

  for (const child of Object.values(value)) {
    deepFreeze(child);
  }

  return Object.freeze(value);
}

function recoveryError(
  options?: ErrorOptions,
): IdentityMigrationPersistenceError {
  return new IdentityMigrationPersistenceError(
    'recovery-required',
    'Owned migration data is invalid and was left untouched for recovery.',
    options,
  );
}

function conflictError(): IdentityMigrationPersistenceError {
  return new IdentityMigrationPersistenceError(
    'conflict',
    'Identity migration state changed before it could be updated.',
  );
}

function pendingConflictError(): IdentityMigrationPersistenceError {
  return new IdentityMigrationPersistenceError(
    'pending-conflict',
    'Another identity migration is already pending.',
  );
}

function staleJournalError(): IdentityMigrationPersistenceError {
  return new IdentityMigrationPersistenceError(
    'stale-journal',
    'The pending identity migration no longer matches this operation.',
  );
}

function storageFailure(error: unknown): IdentityMigrationPersistenceError {
  return new IdentityMigrationPersistenceError(
    'storage-failure',
    'Identity migration persistence failed; the journal remains resumable.',
    { cause: error },
  );
}

function settingsEqual(
  left: SettingsRecordV1,
  right: SettingsRecordV1,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function journalsReferToSamePlan(
  left: IdentityMigrationJournalV1,
  right: IdentityMigrationJournalV1,
): boolean {
  return (
    left.operationId === right.operationId &&
    JSON.stringify(left.plan) === JSON.stringify(right.plan)
  );
}

function makeOriginIndex(
  origin: string,
  pageKeys: readonly string[],
): NoteOriginIndexV1 {
  return {
    schemaVersion: NOTE_ORIGIN_INDEX_SCHEMA_VERSION,
    origin,
    pageKeys: [...pageKeys].sort(compareCodeUnits),
  };
}

function indexEquals(
  index: NoteOriginIndexV1 | undefined,
  expected: NoteOriginIndexV1,
): boolean {
  return (
    index !== undefined &&
    index.origin === expected.origin &&
    index.schemaVersion === expected.schemaVersion &&
    JSON.stringify(index.pageKeys) === JSON.stringify(expected.pageKeys)
  );
}

function withPhase(
  journal: IdentityMigrationJournalV1,
  phase: IdentityMigrationJournalPhase,
): IdentityMigrationJournalV1 {
  const nextPhase =
    phaseOrder[journal.phase] >= phaseOrder[phase] ? journal.phase : phase;

  return deepFreeze({
    schemaVersion: journal.schemaVersion,
    operationId: journal.operationId,
    phase: nextPhase,
    plan: journal.plan,
  });
}

function migrateSettingsV0(value: {
  readonly editorMode: SettingsRecordV1['editorMode'];
}): SettingsRecordV1 {
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    editorMode: value.editorMode,
    pageIdentityExclusions: [],
  };
}

export class ChromeLocalIdentityMigrationPersistence implements IdentityMigrationPersistence {
  readonly #storageArea: PromiseChromeStorageArea;

  constructor(storageArea?: PromiseChromeStorageArea) {
    this.#storageArea = resolveChromeLocalStorageArea(storageArea);
  }

  loadJournal(): Promise<IdentityMigrationJournalV1 | undefined> {
    return this.#enqueue(async () => {
      const stored = await storageGet(
        this.#storageArea,
        IDENTITY_MIGRATION_JOURNAL_STORAGE_KEY,
        'get',
      );
      const value = stored[IDENTITY_MIGRATION_JOURNAL_STORAGE_KEY];

      return value === undefined ? undefined : await this.#parseJournal(value);
    });
  }

  loadPlanningSnapshot(): Promise<IdentityMigrationPlanningSnapshot> {
    return this.#enqueue(async () => {
      const stored = await storageGet(this.#storageArea, null, 'list');

      if (stored[IDENTITY_MIGRATION_JOURNAL_STORAGE_KEY] !== undefined) {
        await this.#parseJournal(
          stored[IDENTITY_MIGRATION_JOURNAL_STORAGE_KEY],
        );
        throw pendingConflictError();
      }

      const rawSettings = stored[SETTINGS_STORAGE_KEY];
      let currentSettings: SettingsRecordV1;

      if (rawSettings === undefined) {
        currentSettings = cloneSettings(DEFAULT_SETTINGS_V1);
      } else if (isSettingsRecordV1(rawSettings)) {
        currentSettings = cloneSettings(rawSettings);
      } else if (isSettingsRecordV0(rawSettings)) {
        currentSettings = migrateSettingsV0(rawSettings);
        await storageSet(
          this.#storageArea,
          { [SETTINGS_STORAGE_KEY]: currentSettings },
          'put',
        );
      } else {
        throw recoveryError();
      }

      const allNotes = await this.#readAllNotes(stored);
      const records = [...allNotes.values()]
        .map(({ record }) => cloneNote(record))
        .sort((left, right) => compareCodeUnits(left.pageKey, right.pageKey));

      return deepFreeze({
        settings: cloneSettings(currentSettings),
        records,
      });
    });
  }

  beginJournal(journal: IdentityMigrationJournalV1): Promise<void> {
    return this.#enqueue(async () => {
      const candidate = await this.#parseJournal(journal);

      if (candidate.phase !== 'planned') {
        throw conflictError();
      }

      const stored = await storageGet(this.#storageArea, null, 'put');
      const existingJournal = stored[IDENTITY_MIGRATION_JOURNAL_STORAGE_KEY];

      if (existingJournal !== undefined) {
        await this.#parseJournal(existingJournal);
        throw pendingConflictError();
      }

      const settings = await this.#readSettings(stored);

      if (
        settings.fingerprint !== candidate.plan.expected.settings.fingerprint
      ) {
        throw conflictError();
      }

      const allNotes = await this.#readAllNotes(stored);
      const expectedByKey = new Map(
        candidate.plan.expected.sources.map(
          (source) => [source.record.pageKey, source] as const,
        ),
      );
      const affected = new Map(
        [...allNotes.entries()].filter(
          ([, note]) => note.record.origin === candidate.plan.change.origin,
        ),
      );

      if (affected.size !== expectedByKey.size) {
        throw conflictError();
      }

      for (const [pageKey, expected] of expectedByKey) {
        if (affected.get(pageKey)?.fingerprint !== expected.fingerprint) {
          throw conflictError();
        }
      }

      for (const { record } of candidate.plan.destinations) {
        if (
          !expectedByKey.has(record.pageKey) &&
          allNotes.has(record.pageKey)
        ) {
          throw conflictError();
        }
      }

      const index = this.#readAffectedIndex(stored, candidate.plan);
      const projectedIndex = makeOriginIndex(candidate.plan.change.origin, [
        ...affected.keys(),
      ]);
      const changes: Record<string, unknown> = {
        [IDENTITY_MIGRATION_JOURNAL_STORAGE_KEY]: candidate,
      };

      if (!indexEquals(index, projectedIndex)) {
        changes[getNoteOriginIndexStorageKey(candidate.plan.change.origin)] =
          projectedIndex;
      }

      await storageSet(this.#storageArea, changes, 'put');
    });
  }

  applyDestinations(
    journal: IdentityMigrationJournalV1,
  ): Promise<IdentityMigrationJournalV1> {
    return this.#applyPhase(journal, 'destinations-applied');
  }

  applyTombstones(
    journal: IdentityMigrationJournalV1,
  ): Promise<IdentityMigrationJournalV1> {
    return this.#applyPhase(journal, 'tombstones-applied');
  }

  applySettings(
    journal: IdentityMigrationJournalV1,
  ): Promise<IdentityMigrationJournalV1> {
    return this.#applyPhase(journal, 'settings-applied');
  }

  finalize(journal: IdentityMigrationJournalV1): Promise<void> {
    return this.#enqueue(async () => {
      const expectedJournal = await this.#parseJournal(journal);
      const stored = await storageGet(this.#storageArea, null, 'delete');
      const state = await this.#validateOperationState(stored, expectedJournal);

      if (
        state.journal.phase !== 'settings-applied' ||
        !state.settings.exactRequested ||
        !this.#allWritesApplied(state)
      ) {
        throw conflictError();
      }

      const projectedIndex = makeOriginIndex(state.journal.plan.change.origin, [
        ...state.affected.keys(),
      ]);

      if (!indexEquals(state.index, projectedIndex)) {
        await storageSet(
          this.#storageArea,
          {
            [getNoteOriginIndexStorageKey(state.journal.plan.change.origin)]:
              projectedIndex,
          },
          'put',
        );
      }

      await storageRemove(
        this.#storageArea,
        IDENTITY_MIGRATION_JOURNAL_STORAGE_KEY,
      );
    });
  }

  #applyPhase(
    journal: IdentityMigrationJournalV1,
    targetPhase: Exclude<IdentityMigrationJournalPhase, 'planned'>,
  ): Promise<IdentityMigrationJournalV1> {
    return this.#enqueue(async () => {
      const expectedJournal = await this.#parseJournal(journal);
      const stored = await storageGet(this.#storageArea, null, 'put');
      const state = await this.#validateOperationState(stored, expectedJournal);
      const changes: Record<string, unknown> = {};

      this.#assertPersistedPhaseIsConsistent(state);

      if (targetPhase === 'destinations-applied') {
        this.#stageWrites(
          state,
          state.journal.plan.destinations,
          state.destinationFingerprints,
          changes,
        );
      } else if (targetPhase === 'tombstones-applied') {
        if (!this.#destinationsApplied(state)) {
          throw conflictError();
        }

        this.#stageWrites(
          state,
          state.journal.plan.sourceTombstones,
          state.tombstoneFingerprints,
          changes,
        );
      } else {
        if (
          !this.#destinationsApplied(state) ||
          !this.#tombstonesApplied(state)
        ) {
          throw conflictError();
        }

        if (!state.settings.exactRequested) {
          changes[SETTINGS_STORAGE_KEY] = state.journal.plan.requestedSettings;
        }
      }

      const nextJournal = withPhase(state.journal, targetPhase);

      if (nextJournal.phase !== state.journal.phase) {
        changes[IDENTITY_MIGRATION_JOURNAL_STORAGE_KEY] = nextJournal;
      }

      const projectedIndex = makeOriginIndex(state.journal.plan.change.origin, [
        ...state.affected.keys(),
      ]);

      if (!indexEquals(state.index, projectedIndex)) {
        changes[
          getNoteOriginIndexStorageKey(state.journal.plan.change.origin)
        ] = projectedIndex;
      }

      if (Object.keys(changes).length > 0) {
        await storageSet(this.#storageArea, changes, 'put');
      }

      return nextJournal;
    });
  }

  #stageWrites(
    state: ValidatedOperationState,
    writes: readonly (
      IdentityMigrationDestinationWrite | IdentityMigrationTombstoneWrite
    )[],
    plannedFingerprints: ReadonlyMap<string, string>,
    changes: Record<string, unknown>,
  ): void {
    for (const { record } of writes) {
      const plannedFingerprint = plannedFingerprints.get(record.pageKey);

      if (plannedFingerprint === undefined) {
        throw recoveryError();
      }

      if (
        state.affected.get(record.pageKey)?.fingerprint === plannedFingerprint
      ) {
        continue;
      }

      changes[getNoteStorageKey(record.pageKey)] = record;
      state.affected.set(record.pageKey, {
        fingerprint: plannedFingerprint,
        record,
      });
      state.allNotes.set(record.pageKey, {
        fingerprint: plannedFingerprint,
        record,
      });
    }
  }

  async #validateOperationState(
    stored: Record<string, unknown>,
    expectedJournal: IdentityMigrationJournalV1,
  ): Promise<ValidatedOperationState> {
    const rawJournal = stored[IDENTITY_MIGRATION_JOURNAL_STORAGE_KEY];

    if (rawJournal === undefined) {
      throw staleJournalError();
    }

    const journal = await this.#parseJournal(rawJournal);

    if (!journalsReferToSamePlan(journal, expectedJournal)) {
      throw staleJournalError();
    }

    const settings = await this.#readSettings(
      stored,
      journal.plan.requestedSettings,
    );
    const expectedSettingsFingerprint =
      journal.plan.expected.settings.fingerprint;
    const requestedSettingsFingerprint =
      await fingerprintIdentityMigrationSettings(
        journal.plan.requestedSettings,
      );

    if (
      settings.fingerprint !== expectedSettingsFingerprint &&
      settings.fingerprint !== requestedSettingsFingerprint
    ) {
      throw conflictError();
    }

    const allNotes = await this.#readAllNotes(stored);
    const expectedByKey = new Map(
      journal.plan.expected.sources.map(
        (source) => [source.record.pageKey, source] as const,
      ),
    );
    const destinationFingerprints = await this.#writeFingerprints(
      journal.plan.destinations,
    );
    const tombstoneFingerprints = await this.#writeFingerprints(
      journal.plan.sourceTombstones,
    );
    const plannedFingerprints = new Map([
      ...destinationFingerprints,
      ...tombstoneFingerprints,
    ]);
    const allowedKeys = new Set([
      ...expectedByKey.keys(),
      ...plannedFingerprints.keys(),
    ]);
    const affected = new Map(
      [...allNotes.entries()].filter(
        ([, note]) => note.record.origin === journal.plan.change.origin,
      ),
    );

    for (const pageKey of affected.keys()) {
      if (!allowedKeys.has(pageKey)) {
        throw conflictError();
      }
    }

    for (const pageKey of allowedKeys) {
      const actual = allNotes.get(pageKey);
      const expected = expectedByKey.get(pageKey);
      const plannedFingerprint = plannedFingerprints.get(pageKey);

      if (actual === undefined) {
        if (expected !== undefined) {
          throw conflictError();
        }

        continue;
      }

      if (
        actual.record.origin !== journal.plan.change.origin ||
        (actual.fingerprint !== expected?.fingerprint &&
          actual.fingerprint !== plannedFingerprint)
      ) {
        throw conflictError();
      }
    }

    return {
      affected,
      allNotes,
      destinationFingerprints,
      expectedByKey,
      journal,
      settings: {
        ...settings,
        exactRequested: settingsEqual(
          settings.record,
          journal.plan.requestedSettings,
        ),
      },
      tombstoneFingerprints,
      index: this.#readAffectedIndex(stored, journal.plan),
    };
  }

  #assertPersistedPhaseIsConsistent(state: ValidatedOperationState): void {
    const persistedOrder = phaseOrder[state.journal.phase];

    if (
      (persistedOrder >= phaseOrder['destinations-applied'] &&
        !this.#destinationsApplied(state)) ||
      (persistedOrder >= phaseOrder['tombstones-applied'] &&
        !this.#tombstonesApplied(state)) ||
      (persistedOrder >= phaseOrder['settings-applied'] &&
        !state.settings.exactRequested)
    ) {
      throw conflictError();
    }
  }

  #destinationsApplied(state: ValidatedOperationState): boolean {
    return this.#writesApplied(state, state.destinationFingerprints);
  }

  #tombstonesApplied(state: ValidatedOperationState): boolean {
    return this.#writesApplied(state, state.tombstoneFingerprints);
  }

  #allWritesApplied(state: ValidatedOperationState): boolean {
    return this.#destinationsApplied(state) && this.#tombstonesApplied(state);
  }

  #writesApplied(
    state: ValidatedOperationState,
    fingerprints: ReadonlyMap<string, string>,
  ): boolean {
    return [...fingerprints].every(
      ([pageKey, fingerprint]) =>
        state.affected.get(pageKey)?.fingerprint === fingerprint,
    );
  }

  async #writeFingerprints(
    writes: readonly (
      IdentityMigrationDestinationWrite | IdentityMigrationTombstoneWrite
    )[],
  ): Promise<ReadonlyMap<string, string>> {
    const fingerprints = new Map<string, string>();

    for (const { record } of writes) {
      fingerprints.set(
        record.pageKey,
        await fingerprintIdentityMigrationNote(record),
      );
    }

    return fingerprints;
  }

  async #readSettings(
    stored: Record<string, unknown>,
    requestedSettings?: SettingsRecordV1,
  ): Promise<StoredSettings> {
    const value = stored[SETTINGS_STORAGE_KEY];
    let record: SettingsRecordV1;

    if (value === undefined) {
      record = cloneSettings(DEFAULT_SETTINGS_V1);
    } else if (isSettingsRecordV1(value)) {
      record = cloneSettings(value);
    } else {
      throw recoveryError();
    }

    return {
      exactRequested:
        requestedSettings !== undefined &&
        settingsEqual(record, requestedSettings),
      fingerprint: await fingerprintIdentityMigrationSettings(record),
      record,
    };
  }

  async #readAllNotes(
    stored: Record<string, unknown>,
  ): Promise<Map<string, StoredNote>> {
    const notes = new Map<string, StoredNote>();
    const entries = Object.entries(stored)
      .filter(([storageKey]) => storageKey.startsWith(NOTE_STORAGE_KEY_PREFIX))
      .sort(([left], [right]) => compareCodeUnits(left, right));

    for (const [storageKey, value] of entries) {
      if (
        !isNoteRecordV1(value) ||
        getNoteStorageKey(value.pageKey) !== storageKey
      ) {
        throw recoveryError();
      }

      let fingerprint: string;

      try {
        fingerprint = await fingerprintIdentityMigrationNote(value);
      } catch (error) {
        throw recoveryError({ cause: error });
      }

      notes.set(value.pageKey, {
        fingerprint,
        record: cloneNote(value),
      });
    }

    return notes;
  }

  #readAffectedIndex(
    stored: Record<string, unknown>,
    plan: PlannedIdentityMigration,
  ): NoteOriginIndexV1 | undefined {
    const storageKey = getNoteOriginIndexStorageKey(plan.change.origin);
    const value = stored[storageKey];

    if (value === undefined) {
      return undefined;
    }

    if (
      !isNoteOriginIndexV1(value, plan.change.origin) ||
      getNoteOriginIndexStorageKey(value.origin) !== storageKey
    ) {
      throw recoveryError();
    }

    return {
      schemaVersion: value.schemaVersion,
      origin: value.origin,
      pageKeys: [...value.pageKeys],
    };
  }

  async #parseJournal(value: unknown): Promise<IdentityMigrationJournalV1> {
    try {
      return await parseIdentityMigrationJournal(value);
    } catch (error) {
      if (error instanceof IdentityMigrationJournalError) {
        throw recoveryError({ cause: error });
      }

      throw error;
    }
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    return enqueueStorageOperation(this.#storageArea, async () => {
      try {
        return await operation();
      } catch (error) {
        if (error instanceof IdentityMigrationPersistenceError) {
          throw error;
        }

        if (error instanceof RepositoryStorageError) {
          throw storageFailure(error);
        }

        throw recoveryError({ cause: error });
      }
    });
  }
}
