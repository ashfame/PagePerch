import { byosError } from './byosError';
import {
  BYOS_ORIGIN,
  type ByosClock,
  type ByosHttpResponse,
  type ByosHttpTransport,
} from './byosOAuth';

export const BYOS_PROTOCOL_CREDENTIALS_URL = `${BYOS_ORIGIN}/oauth2/protocol-credentials`;
export const BYOS_PROTOCOL_CREDENTIAL_EXPIRY_SKEW_MS = 60_000;

export interface ByosProtocolCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly bucket: string;
  readonly credentialId: string;
  readonly expiresAt: string;
}

export interface ByosProtocolCredentialIssuer {
  issue(accessToken: string): Promise<ByosProtocolCredentials>;
}

export interface ByosProtocolCredentialProvider {
  get(accessToken: string): Promise<ByosProtocolCredentials>;
  clear(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyTrimmed(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.trim() === value
  );
}

function parseFutureTimestamp(value: unknown, now: Date): number {
  if (!nonEmptyTrimmed(value)) {
    throw byosError(
      'credential-failed',
      'BYOS returned invalid storage credentials. Reconnect.',
    );
  }

  const parsed = new Date(value);

  if (
    Number.isNaN(parsed.valueOf()) ||
    parsed.toISOString() !== value ||
    parsed.valueOf() <= now.valueOf() + BYOS_PROTOCOL_CREDENTIAL_EXPIRY_SKEW_MS
  ) {
    throw byosError(
      'credential-failed',
      'BYOS returned expired storage credentials. Reconnect.',
    );
  }

  return parsed.valueOf();
}

function parseCredentialResponse(
  response: ByosHttpResponse,
  now: Date,
): ByosProtocolCredentials {
  if (response.status !== 200 || !isRecord(response.body)) {
    throw byosError(
      'credential-failed',
      'BYOS storage credential issuance failed. Reconnect.',
    );
  }

  const body = response.body;

  if (
    !isRecord(body.credential) ||
    !isRecord(body.grant) ||
    !nonEmptyTrimmed(body.access_key_id) ||
    !nonEmptyTrimmed(body.secret) ||
    !nonEmptyTrimmed(body.credential.id) ||
    body.credential.protocol !== 's3' ||
    body.credential.access_key_id !== body.access_key_id ||
    body.grant.protocol !== 's3' ||
    !nonEmptyTrimmed(body.grant.protocol_credential_id) ||
    body.grant.protocol_credential_id !== body.credential.id ||
    !nonEmptyTrimmed(body.grant.external_alias) ||
    body.grant.external_alias.includes('/')
  ) {
    throw byosError(
      'credential-failed',
      'BYOS returned invalid storage credentials. Reconnect.',
    );
  }

  const credentialExpiry = parseFutureTimestamp(
    body.credential.expires_at,
    now,
  );
  const grantExpiry = parseFutureTimestamp(body.grant.expires_at, now);
  const expiresAt = new Date(
    Math.min(credentialExpiry, grantExpiry),
  ).toISOString();

  return Object.freeze({
    accessKeyId: body.access_key_id,
    secretAccessKey: body.secret,
    bucket: body.grant.external_alias,
    credentialId: body.credential.id,
    expiresAt,
  });
}

export class DefaultByosProtocolCredentialIssuer implements ByosProtocolCredentialIssuer {
  readonly #http: ByosHttpTransport;
  readonly #clock: ByosClock;

  constructor(http: ByosHttpTransport, clock: ByosClock) {
    this.#http = http;
    this.#clock = clock;
  }

  async issue(accessToken: string): Promise<ByosProtocolCredentials> {
    if (!nonEmptyTrimmed(accessToken)) {
      throw byosError(
        'reconnect-required',
        'Reconnect BYOS before using remote storage.',
      );
    }

    let now: Date;

    try {
      now = this.#clock();
    } catch {
      throw byosError(
        'credential-failed',
        'BYOS storage credentials could not be issued. Retry.',
      );
    }

    if (!(now instanceof Date) || Number.isNaN(now.valueOf())) {
      throw byosError(
        'credential-failed',
        'BYOS storage credentials could not be issued. Retry.',
      );
    }

    let response: ByosHttpResponse;

    try {
      response = await this.#http.request({
        url: BYOS_PROTOCOL_CREDENTIALS_URL,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          protocol: 's3',
          kind: 's3_access_key',
          label: 'PagePerch',
        }),
      });
    } catch {
      throw byosError(
        'credential-failed',
        'BYOS storage credential issuance failed. Reconnect.',
      );
    }

    return parseCredentialResponse(response, now);
  }
}

function cloneCredentials(
  credentials: ByosProtocolCredentials,
): ByosProtocolCredentials {
  return Object.freeze({ ...credentials });
}

export class MemoryByosProtocolCredentialProvider implements ByosProtocolCredentialProvider {
  readonly #issuer: ByosProtocolCredentialIssuer;
  readonly #clock: ByosClock;
  #cached:
    | {
        readonly accessToken: string;
        readonly credentials: ByosProtocolCredentials;
      }
    | undefined;
  #generation = 0;
  #inFlight:
    | {
        readonly accessToken: string;
        readonly promise: Promise<ByosProtocolCredentials>;
      }
    | undefined;

  constructor(issuer: ByosProtocolCredentialIssuer, clock: ByosClock) {
    this.#issuer = issuer;
    this.#clock = clock;
  }

  get(accessToken: string): Promise<ByosProtocolCredentials> {
    let now: Date;

    try {
      now = this.#clock();
    } catch {
      return Promise.reject(
        byosError(
          'credential-failed',
          'BYOS storage credentials could not be issued. Retry.',
        ),
      );
    }

    if (!(now instanceof Date) || Number.isNaN(now.valueOf())) {
      return Promise.reject(
        byosError(
          'credential-failed',
          'BYOS storage credentials could not be issued. Retry.',
        ),
      );
    }

    if (
      this.#cached !== undefined &&
      this.#cached.accessToken === accessToken &&
      new Date(this.#cached.credentials.expiresAt).valueOf() >
        now.valueOf() + BYOS_PROTOCOL_CREDENTIAL_EXPIRY_SKEW_MS
    ) {
      return Promise.resolve(cloneCredentials(this.#cached.credentials));
    }

    if (
      this.#inFlight !== undefined &&
      this.#inFlight.accessToken === accessToken
    ) {
      return this.#inFlight.promise.then(cloneCredentials);
    }

    const generation = this.#generation;
    const rejectIfCleared = (): void => {
      if (this.#generation !== generation) {
        throw byosError(
          'reconnect-required',
          'Reconnect BYOS before using remote storage.',
        );
      }
    };
    const promise = this.#issuer.issue(accessToken).then(
      (credentials) => {
        rejectIfCleared();
        this.#cached = {
          accessToken,
          credentials: cloneCredentials(credentials),
        };

        return cloneCredentials(credentials);
      },
      (error: unknown) => {
        rejectIfCleared();
        throw error;
      },
    );
    this.#inFlight = { accessToken, promise };

    return promise.finally(() => {
      if (this.#inFlight?.promise === promise) {
        this.#inFlight = undefined;
      }
    });
  }

  clear(): void {
    this.#generation += 1;
    this.#cached = undefined;
    this.#inFlight = undefined;
  }
}
