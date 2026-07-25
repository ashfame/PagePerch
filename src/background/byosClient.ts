import { ChromeSessionByosPkceRepository } from '../repositories/chromeSessionByosPkceRepository';
import { ChromeLocalSettingsRepository } from '../repositories/chromeLocalSettingsRepository';
import { ByosCoordinator } from '../services/byosCoordinator';
import type {
  ByosHttpRequest,
  ByosHttpTransport,
  ByosIdentityPort,
} from '../services/byosOAuth';
import { ByosOAuthClient } from '../services/byosOAuth';
import {
  DefaultByosProtocolCredentialIssuer,
  MemoryByosProtocolCredentialProvider,
} from '../services/byosProtocolCredentials';
import { recoverPendingIdentityMigration } from './identityMigrationRecovery';

export interface ByosClientConfig {
  readonly clientId: string | undefined;
  readonly enabled: boolean;
}

export interface ByosClient {
  readonly config: ByosClientConfig;
  readonly coordinator: ByosCoordinator;
}

export function readByosClientConfig(
  environment: Record<string, unknown> = import.meta.env,
): ByosClientConfig {
  const value = environment.VITE_BYOS_CLIENT_ID;
  const clientId =
    typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

  return Object.freeze({
    clientId,
    enabled: clientId !== undefined,
  });
}

export class ChromeByosIdentityConnector implements ByosIdentityPort {
  getRedirectURL(): string {
    return chrome.identity.getRedirectURL();
  }

  async launchWebAuthFlow(authorizeUrl: string): Promise<string> {
    const callbackUrl = await chrome.identity.launchWebAuthFlow({
      url: authorizeUrl,
      interactive: true,
    });

    if (callbackUrl === undefined) {
      throw new Error('BYOS authorization did not return to PagePerch.');
    }

    return callbackUrl;
  }
}

export class FetchByosHttpConnector implements ByosHttpTransport {
  async request(request: ByosHttpRequest) {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      cache: 'no-store',
      credentials: 'omit',
    });
    let body: unknown;

    try {
      body = await response.json();
    } catch {
      body = undefined;
    }

    return { status: response.status, body };
  }
}

export function createByosClient(
  environment: Record<string, unknown> = import.meta.env,
): ByosClient {
  const config = readByosClientConfig(environment);
  const clock = () => new Date();
  const http = new FetchByosHttpConnector();
  const session = new ChromeSessionByosPkceRepository();
  const oauth = new ByosOAuthClient({
    session,
    identity: new ChromeByosIdentityConnector(),
    http,
    clock,
  });
  const credentials = new MemoryByosProtocolCredentialProvider(
    new DefaultByosProtocolCredentialIssuer(http, clock),
    clock,
  );
  const coordinator = new ByosCoordinator({
    clientId: config.clientId,
    oauth,
    settings: new ChromeLocalSettingsRepository(),
    credentials,
    clock,
    resumePendingMigration: recoverPendingIdentityMigration,
  });

  return Object.freeze({ config, coordinator });
}
