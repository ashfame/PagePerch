import type { NoteRecordV1 } from '../domain/note';
import type { SettingsRecordV1 } from '../domain/settings';
import {
  parseIdentityMigrationPlan,
  type PlannedIdentityMigration,
} from './identityMigration';

export const IDENTITY_MIGRATION_JOURNAL_SCHEMA_VERSION = 1 as const;
export const IDENTITY_MIGRATION_JOURNAL_STORAGE_KEY =
  'pageperch:v1:identity-migration-journal';

export type IdentityMigrationJournalPhase =
  | 'planned'
  | 'destinations-applied'
  | 'tombstones-applied'
  | 'settings-applied';

export interface IdentityMigrationJournalV1 {
  readonly schemaVersion: typeof IDENTITY_MIGRATION_JOURNAL_SCHEMA_VERSION;
  readonly operationId: string;
  readonly phase: IdentityMigrationJournalPhase;
  readonly plan: PlannedIdentityMigration;
}

export interface IdentityMigrationPlanningSnapshot {
  readonly settings: SettingsRecordV1;
  readonly records: readonly NoteRecordV1[];
}

export type IdentityMigrationPersistenceErrorCode =
  | 'conflict'
  | 'pending-conflict'
  | 'recovery-required'
  | 'stale-journal'
  | 'storage-failure';

export class IdentityMigrationPersistenceError extends Error {
  readonly code: IdentityMigrationPersistenceErrorCode;

  constructor(
    code: IdentityMigrationPersistenceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'IdentityMigrationPersistenceError';
    this.code = code;
  }
}

export class IdentityMigrationJournalError extends Error {
  readonly kind: 'future-schema' | 'malformed';

  constructor(kind: 'future-schema' | 'malformed') {
    super(
      kind === 'future-schema'
        ? 'The pending identity migration uses an unsupported schema and was left untouched.'
        : 'The pending identity migration is malformed and was left untouched.',
    );
    this.name = 'IdentityMigrationJournalError';
    this.kind = kind;
  }
}

export interface IdentityMigrationPersistence {
  loadJournal(): Promise<IdentityMigrationJournalV1 | undefined>;
  loadPlanningSnapshot(): Promise<IdentityMigrationPlanningSnapshot>;
  beginJournal(journal: IdentityMigrationJournalV1): Promise<void>;
  applyDestinations(
    journal: IdentityMigrationJournalV1,
  ): Promise<IdentityMigrationJournalV1>;
  applyTombstones(
    journal: IdentityMigrationJournalV1,
  ): Promise<IdentityMigrationJournalV1>;
  applySettings(
    journal: IdentityMigrationJournalV1,
  ): Promise<IdentityMigrationJournalV1>;
  finalize(journal: IdentityMigrationJournalV1): Promise<void>;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: UnknownRecord, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function isJournalPhase(
  value: unknown,
): value is IdentityMigrationJournalPhase {
  return (
    value === 'planned' ||
    value === 'destinations-applied' ||
    value === 'tombstones-applied' ||
    value === 'settings-applied'
  );
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

export async function parseIdentityMigrationJournal(
  value: unknown,
): Promise<IdentityMigrationJournalV1> {
  if (!isRecord(value)) {
    throw new IdentityMigrationJournalError('malformed');
  }

  if (
    typeof value.schemaVersion === 'number' &&
    value.schemaVersion > IDENTITY_MIGRATION_JOURNAL_SCHEMA_VERSION
  ) {
    throw new IdentityMigrationJournalError('future-schema');
  }

  if (
    !hasExactKeys(value, ['schemaVersion', 'operationId', 'phase', 'plan']) ||
    value.schemaVersion !== IDENTITY_MIGRATION_JOURNAL_SCHEMA_VERSION ||
    typeof value.operationId !== 'string' ||
    !isJournalPhase(value.phase)
  ) {
    throw new IdentityMigrationJournalError('malformed');
  }

  try {
    const plan = await parseIdentityMigrationPlan(value.plan);

    if (plan.status !== 'planned' || plan.operationId !== value.operationId) {
      throw new IdentityMigrationJournalError('malformed');
    }

    return deepFreeze({
      schemaVersion: IDENTITY_MIGRATION_JOURNAL_SCHEMA_VERSION,
      operationId: plan.operationId,
      phase: value.phase,
      plan,
    });
  } catch (error) {
    if (error instanceof IdentityMigrationJournalError) {
      throw error;
    }

    throw new IdentityMigrationJournalError('malformed');
  }
}

export async function createIdentityMigrationJournal(
  plan: PlannedIdentityMigration,
): Promise<IdentityMigrationJournalV1> {
  return parseIdentityMigrationJournal({
    schemaVersion: IDENTITY_MIGRATION_JOURNAL_SCHEMA_VERSION,
    operationId: plan.operationId,
    phase: 'planned',
    plan,
  });
}
