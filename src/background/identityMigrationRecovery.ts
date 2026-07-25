import { ChromeLocalIdentityMigrationPersistence } from '../repositories/chromeLocalIdentityMigrationPersistence';
import type { PromiseChromeStorageArea } from '../repositories/chromeStorage';
import {
  IdentityMigrationExecutor,
  type IdentityMigrationExecutionOutcome,
} from '../services/identityMigrationExecutor';
import { DefaultPageIdentityService } from '../services/pageIdentity';

interface IdentityMigrationResumer {
  resumePending(): Promise<IdentityMigrationExecutionOutcome>;
}

export interface IdentityMigrationRecoveryTestOptions {
  readonly resumer?: IdentityMigrationResumer;
  readonly storageArea?: PromiseChromeStorageArea;
}

function createProductionResumer(
  storageArea?: PromiseChromeStorageArea,
): IdentityMigrationResumer {
  return new IdentityMigrationExecutor({
    persistence: new ChromeLocalIdentityMigrationPersistence(storageArea),
    pageIdentityService: new DefaultPageIdentityService(),
    clock: () => new Date(),
    operationIdFactory: () => crypto.randomUUID(),
    revisionIdFactory: () => crypto.randomUUID(),
  });
}

export function recoverPendingIdentityMigration(): Promise<IdentityMigrationExecutionOutcome> {
  return createProductionResumer().resumePending();
}

export function recoverPendingIdentityMigrationForTest(
  options: IdentityMigrationRecoveryTestOptions,
): Promise<IdentityMigrationExecutionOutcome> {
  return (
    options.resumer ?? createProductionResumer(options.storageArea)
  ).resumePending();
}
