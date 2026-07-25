import type { ByosConnectionV1 } from '../domain/settings';
import type { SettingsRepository } from '../repositories/settingsRepository';
import { byosError, ByosError } from './byosError';
import type {
  ByosClock,
  ByosOAuthClient,
  PreparedByosAuthorization,
} from './byosOAuth';
import type {
  ByosProtocolCredentialProvider,
  ByosProtocolCredentials,
} from './byosProtocolCredentials';

type ByosSettingsPort = Pick<
  SettingsRepository,
  'get' | 'updateByosConnection'
>;

export interface ByosOAuthPort {
  prepareAuthorization(clientId: string): Promise<PreparedByosAuthorization>;
  launchAuthorization(authorizeUrl: string): Promise<string>;
  completeAuthorization(
    clientId: string,
    callbackUrl: string,
  ): Promise<ByosConnectionV1>;
  clearPendingAuthorization(): Promise<void>;
}

export interface ByosCoordinatorDependencies {
  readonly clientId: string | undefined;
  readonly oauth: ByosOAuthPort | ByosOAuthClient;
  readonly settings: ByosSettingsPort;
  readonly credentials: ByosProtocolCredentialProvider;
  readonly clock: ByosClock;
  readonly resumePendingMigration: () => Promise<unknown>;
}

function isSameConnectionIdentity(
  connection: ByosConnectionV1 | undefined,
  expected: ByosConnectionV1,
): boolean {
  return (
    connection !== undefined &&
    connection.accessToken === expected.accessToken &&
    connection.connectedAt === expected.connectedAt &&
    connection.expiresAt === expected.expiresAt
  );
}

export class ByosCoordinator {
  readonly #dependencies: ByosCoordinatorDependencies;
  #connectInFlight: Promise<void> | undefined;
  #lifecycleGeneration = 0;

  constructor(dependencies: ByosCoordinatorDependencies) {
    this.#dependencies = dependencies;
  }

  connect(): Promise<void> {
    if (this.#connectInFlight !== undefined) {
      return this.#connectInFlight;
    }

    const clientId = this.#dependencies.clientId?.trim();

    if (clientId === undefined || clientId === '') {
      return Promise.reject(
        byosError(
          'configuration-required',
          'BYOS connection is unavailable in this build.',
        ),
      );
    }

    const generation = this.#lifecycleGeneration;
    const connection = this.#runConnect(clientId, generation);
    const tracked = connection.finally(() => {
      if (this.#connectInFlight === tracked) {
        this.#connectInFlight = undefined;
      }
    });
    this.#connectInFlight = tracked;

    return tracked;
  }

  async disconnect(): Promise<void> {
    this.#lifecycleGeneration += 1;

    try {
      await this.#dependencies.resumePendingMigration();
      this.#dependencies.credentials.clear();
      await this.#dependencies.oauth.clearPendingAuthorization();
      await this.#dependencies.settings.updateByosConnection(undefined);
    } catch {
      throw byosError(
        'disconnect-failed',
        'BYOS could not be disconnected safely. Retry.',
      );
    }
  }

  async getProtocolCredentials(
    expectedConnection?: ByosConnectionV1,
  ): Promise<ByosProtocolCredentials> {
    const clientId = this.#dependencies.clientId?.trim();

    if (clientId === undefined || clientId === '') {
      throw byosError(
        'configuration-required',
        'BYOS connection is unavailable in this build.',
      );
    }

    let settings;
    let now: Date;

    try {
      [settings, now] = await Promise.all([
        this.#dependencies.settings.get(),
        Promise.resolve(this.#dependencies.clock()),
      ]);
    } catch {
      throw byosError(
        'reconnect-required',
        'Reconnect BYOS before using remote storage.',
      );
    }

    const connection = settings.byosConnection;

    if (
      connection === undefined ||
      (expectedConnection !== undefined &&
        !isSameConnectionIdentity(connection, expectedConnection)) ||
      !(now instanceof Date) ||
      Number.isNaN(now.valueOf()) ||
      new Date(connection.expiresAt).valueOf() <= now.valueOf()
    ) {
      throw byosError(
        'reconnect-required',
        'Reconnect BYOS before using remote storage.',
      );
    }

    try {
      const credentials = await this.#dependencies.credentials.get(
        connection.accessToken,
      );

      if (expectedConnection !== undefined) {
        let latestSettings;

        try {
          latestSettings = await this.#dependencies.settings.get();
        } catch {
          this.#dependencies.credentials.clear();
          throw byosError(
            'reconnect-required',
            'Reconnect BYOS before using remote storage.',
          );
        }

        if (
          !isSameConnectionIdentity(
            latestSettings.byosConnection,
            expectedConnection,
          )
        ) {
          this.#dependencies.credentials.clear();
          throw byosError(
            'reconnect-required',
            'Reconnect BYOS before using remote storage.',
          );
        }
      }

      return credentials;
    } catch (error) {
      if (error instanceof ByosError) {
        throw error;
      }

      throw byosError(
        'credential-failed',
        'BYOS storage credentials could not be issued. Retry.',
      );
    }
  }

  #assertCurrentLifecycle(generation: number): void {
    if (generation !== this.#lifecycleGeneration) {
      throw byosError(
        'authorization-failed',
        'BYOS connection was cancelled safely. Retry.',
      );
    }
  }

  async #runConnect(clientId: string, generation: number): Promise<void> {
    try {
      await this.#dependencies.oauth.clearPendingAuthorization();
      this.#assertCurrentLifecycle(generation);
      const prepared =
        await this.#dependencies.oauth.prepareAuthorization(clientId);
      this.#assertCurrentLifecycle(generation);
      const callbackUrl = await this.#dependencies.oauth.launchAuthorization(
        prepared.authorizeUrl,
      );
      this.#assertCurrentLifecycle(generation);
      const connection = await this.#dependencies.oauth.completeAuthorization(
        clientId,
        callbackUrl,
      );
      this.#assertCurrentLifecycle(generation);
      await this.#dependencies.settings.updateByosConnection(connection);
      this.#assertCurrentLifecycle(generation);
      await this.#dependencies.oauth.clearPendingAuthorization();
      this.#assertCurrentLifecycle(generation);
    } catch (error) {
      if (generation !== this.#lifecycleGeneration) {
        try {
          await this.#dependencies.oauth.clearPendingAuthorization();
        } catch {
          throw byosError(
            'session-failed',
            'BYOS authorization cleanup failed. Retry.',
          );
        }

        throw byosError(
          'authorization-failed',
          'BYOS connection was cancelled safely. Retry.',
        );
      }

      try {
        await this.#dependencies.oauth.clearPendingAuthorization();
      } catch {
        throw byosError(
          'session-failed',
          'BYOS authorization cleanup failed. Retry.',
        );
      }

      if (error instanceof ByosError) {
        throw error;
      }

      throw byosError(
        'authorization-failed',
        'BYOS connection failed safely. Retry.',
      );
    }
  }
}
