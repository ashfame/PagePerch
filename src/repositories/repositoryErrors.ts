export type RepositoryOperation = 'delete' | 'get' | 'list' | 'put';

export class RepositoryConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepositoryConfigurationError';
  }
}

export class RepositoryValidationError extends Error {
  readonly operation: RepositoryOperation;

  constructor(operation: RepositoryOperation, message: string) {
    super(message);
    this.name = 'RepositoryValidationError';
    this.operation = operation;
  }
}

export class RepositoryStoredDataError extends Error {
  readonly kind: 'future-schema' | 'malformed';
  readonly storageKey: string;

  constructor(
    kind: 'future-schema' | 'malformed',
    storageKey: string,
    message: string,
  ) {
    super(message);
    this.name = 'RepositoryStoredDataError';
    this.kind = kind;
    this.storageKey = storageKey;
  }
}

export class RepositoryPendingIdentityMigrationError extends Error {
  readonly code = 'pending-identity-migration';
  readonly operation: Extract<RepositoryOperation, 'delete' | 'put'>;

  constructor(operation: Extract<RepositoryOperation, 'delete' | 'put'>) {
    super(
      'PagePerch data cannot be changed while an identity migration is pending. Retry after the migration finishes.',
    );
    this.name = 'RepositoryPendingIdentityMigrationError';
    this.operation = operation;
  }
}

export class RepositoryStorageError extends Error {
  readonly operation: RepositoryOperation;

  constructor(
    operation: RepositoryOperation,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'RepositoryStorageError';
    this.operation = operation;
  }
}
