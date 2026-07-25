import type { PageIdentityService } from '../domain/pageIdentity';
import type { SettingsRecordV1 } from '../domain/settings';
import {
  fingerprintIdentityMigrationSettings,
  IdentityMigrationPlanError,
  planIdentityMigration,
} from './identityMigration';
import {
  createIdentityMigrationJournal,
  IdentityMigrationPersistenceError,
  type IdentityMigrationJournalPhase,
  type IdentityMigrationJournalV1,
  type IdentityMigrationPersistence,
} from './identityMigrationPersistence';

export type IdentityMigrationExecutionErrorCode =
  | 'cas-conflict'
  | 'invalid-request'
  | 'pending-conflict'
  | 'persistence-failure'
  | 'planning-failure'
  | 'provenance-failure'
  | 'recovery-required';

export class IdentityMigrationExecutionError extends Error {
  readonly code: IdentityMigrationExecutionErrorCode;

  constructor(
    code: IdentityMigrationExecutionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'IdentityMigrationExecutionError';
    this.code = code;
  }
}

export interface IdentityMigrationExecutorDependencies {
  readonly persistence: IdentityMigrationPersistence;
  readonly pageIdentityService: PageIdentityService;
  readonly clock: () => Date;
  readonly operationIdFactory: () => string;
  readonly revisionIdFactory: () => string;
}

export interface IdentityMigrationAppliedOutcome {
  readonly status: 'applied';
  readonly operationId: string;
}

export interface IdentityMigrationResumedOutcome {
  readonly status: 'resumed';
  readonly operationId: string;
  readonly fromPhase: IdentityMigrationJournalPhase;
}

export interface IdentityMigrationNoOpOutcome {
  readonly status: 'no-op';
  readonly reason: 'already-applied' | 'no-pending-operation';
}

export type IdentityMigrationExecutionOutcome =
  | IdentityMigrationAppliedOutcome
  | IdentityMigrationResumedOutcome
  | IdentityMigrationNoOpOutcome;

function executionError(
  code: IdentityMigrationExecutionErrorCode,
  message: string,
  cause?: unknown,
): IdentityMigrationExecutionError {
  return new IdentityMigrationExecutionError(code, message, {
    cause,
  });
}

function freezeOutcome<T extends IdentityMigrationExecutionOutcome>(
  outcome: T,
): T {
  return Object.freeze(outcome);
}

export class IdentityMigrationExecutor {
  readonly #dependencies: IdentityMigrationExecutorDependencies;

  constructor(dependencies: IdentityMigrationExecutorDependencies) {
    if (
      typeof dependencies !== 'object' ||
      dependencies === null ||
      typeof dependencies.persistence !== 'object' ||
      dependencies.persistence === null ||
      typeof dependencies.persistence.loadJournal !== 'function' ||
      typeof dependencies.persistence.loadPlanningSnapshot !== 'function' ||
      typeof dependencies.persistence.beginJournal !== 'function' ||
      typeof dependencies.persistence.applyDestinations !== 'function' ||
      typeof dependencies.persistence.applyTombstones !== 'function' ||
      typeof dependencies.persistence.applySettings !== 'function' ||
      typeof dependencies.persistence.finalize !== 'function' ||
      typeof dependencies.pageIdentityService !== 'object' ||
      dependencies.pageIdentityService === null ||
      typeof dependencies.pageIdentityService.identify !== 'function' ||
      typeof dependencies.clock !== 'function' ||
      typeof dependencies.operationIdFactory !== 'function' ||
      typeof dependencies.revisionIdFactory !== 'function'
    ) {
      throw executionError(
        'invalid-request',
        'Identity migration executor dependencies are invalid.',
      );
    }

    this.#dependencies = dependencies;
  }

  async start(
    requestedSettings: SettingsRecordV1,
  ): Promise<IdentityMigrationExecutionOutcome> {
    let requestedFingerprint: string;

    try {
      requestedFingerprint =
        await fingerprintIdentityMigrationSettings(requestedSettings);
    } catch (error) {
      throw executionError(
        'invalid-request',
        'The requested identity migration is invalid.',
        error,
      );
    }

    const pending = await this.#loadJournal();

    if (pending !== undefined) {
      let pendingFingerprint: string;

      try {
        pendingFingerprint = await fingerprintIdentityMigrationSettings(
          pending.plan.requestedSettings,
        );
      } catch (error) {
        throw executionError(
          'provenance-failure',
          'The pending identity migration failed provenance verification.',
          error,
        );
      }

      if (pendingFingerprint !== requestedFingerprint) {
        throw executionError(
          'pending-conflict',
          'A different identity migration is already pending.',
        );
      }

      await this.#proveProvenance(pending);
      await this.#continue(pending);
      return freezeOutcome({
        status: 'resumed',
        operationId: pending.operationId,
        fromPhase: pending.phase,
      });
    }

    let snapshot;

    try {
      snapshot = await this.#dependencies.persistence.loadPlanningSnapshot();
    } catch (error) {
      throw this.#mapPersistenceError(error);
    }

    let planned;

    try {
      planned = await planIdentityMigration({
        currentSettings: snapshot.settings,
        requestedSettings,
        records: snapshot.records,
        clock: this.#dependencies.clock,
        operationIdFactory: this.#dependencies.operationIdFactory,
        revisionIdFactory: this.#dependencies.revisionIdFactory,
        pageIdentityService: this.#dependencies.pageIdentityService,
      });
    } catch (error) {
      if (
        error instanceof IdentityMigrationPlanError &&
        (error.code === 'invalid-settings' ||
          error.code === 'invalid-settings-change')
      ) {
        throw executionError(
          'invalid-request',
          'The requested identity migration is invalid.',
          error,
        );
      }

      throw executionError(
        'planning-failure',
        'Identity migration planning failed safely.',
        error,
      );
    }

    if (planned.status === 'no-op') {
      return freezeOutcome({
        status: 'no-op',
        reason: 'already-applied',
      });
    }

    let journal: IdentityMigrationJournalV1;

    try {
      journal = await createIdentityMigrationJournal(planned);
    } catch (error) {
      throw executionError(
        'planning-failure',
        'Identity migration planning failed safely.',
        error,
      );
    }

    try {
      await this.#dependencies.persistence.beginJournal(journal);
    } catch (error) {
      if (
        error instanceof IdentityMigrationPersistenceError &&
        error.code === 'pending-conflict'
      ) {
        throw executionError(
          'pending-conflict',
          'Identity migration start lost a concurrent race.',
          error,
        );
      }

      throw this.#mapPersistenceError(error);
    }

    await this.#proveProvenance(journal);
    await this.#continue(journal);
    return freezeOutcome({
      status: 'applied',
      operationId: journal.operationId,
    });
  }

  async resumePending(): Promise<IdentityMigrationExecutionOutcome> {
    const journal = await this.#loadJournal();

    if (journal === undefined) {
      return freezeOutcome({
        status: 'no-op',
        reason: 'no-pending-operation',
      });
    }

    await this.#proveProvenance(journal);
    await this.#continue(journal);
    return freezeOutcome({
      status: 'resumed',
      operationId: journal.operationId,
      fromPhase: journal.phase,
    });
  }

  async #loadJournal(): Promise<IdentityMigrationJournalV1 | undefined> {
    try {
      return await this.#dependencies.persistence.loadJournal();
    } catch (error) {
      throw this.#mapPersistenceError(error);
    }
  }

  async #proveProvenance(journal: IdentityMigrationJournalV1): Promise<void> {
    const revisionIds = [
      ...journal.plan.destinations.map(({ record }) => record.revisionId),
      ...journal.plan.sourceTombstones.map(({ record }) => record.revisionId),
    ];
    let revisionIndex = 0;

    try {
      const rederived = await planIdentityMigration({
        currentSettings: journal.plan.expected.settings.record,
        requestedSettings: journal.plan.requestedSettings,
        records: journal.plan.expected.sources.map(({ record }) => record),
        clock: () => new Date(journal.plan.plannedAt),
        operationIdFactory: () => journal.operationId,
        revisionIdFactory: () => {
          const revisionId = revisionIds[revisionIndex];
          revisionIndex += 1;

          if (revisionId === undefined) {
            throw new Error('Missing deterministic revision provenance.');
          }

          return revisionId;
        },
        pageIdentityService: this.#dependencies.pageIdentityService,
      });

      if (
        rederived.status !== 'planned' ||
        revisionIndex !== revisionIds.length ||
        JSON.stringify(rederived) !== JSON.stringify(journal.plan)
      ) {
        throw new Error('Migration provenance did not match.');
      }
    } catch (error) {
      throw executionError(
        'provenance-failure',
        'The pending identity migration failed provenance verification.',
        error,
      );
    }
  }

  async #continue(initialJournal: IdentityMigrationJournalV1): Promise<void> {
    let journal = initialJournal;

    try {
      journal = await this.#dependencies.persistence.applyDestinations(journal);
      journal = await this.#dependencies.persistence.applyTombstones(journal);
      journal = await this.#dependencies.persistence.applySettings(journal);
      await this.#dependencies.persistence.finalize(journal);
    } catch (error) {
      throw this.#mapPersistenceError(error);
    }
  }

  #mapPersistenceError(error: unknown): IdentityMigrationExecutionError {
    if (error instanceof IdentityMigrationExecutionError) {
      return error;
    }

    if (error instanceof IdentityMigrationPersistenceError) {
      if (error.code === 'storage-failure') {
        return executionError(
          'persistence-failure',
          'Identity migration storage failed and remains resumable.',
          error,
        );
      }

      if (error.code === 'recovery-required') {
        return executionError(
          'recovery-required',
          'Identity migration data needs explicit recovery.',
          error,
        );
      }

      if (error.code === 'pending-conflict') {
        return executionError(
          'pending-conflict',
          'A different identity migration is already pending.',
          error,
        );
      }

      return executionError(
        'cas-conflict',
        'Identity migration state changed and was left untouched.',
        error,
      );
    }

    return executionError(
      'persistence-failure',
      'Identity migration persistence failed safely.',
      error,
    );
  }
}
