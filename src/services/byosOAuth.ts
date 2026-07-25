import type { ByosConnectionV1 } from '../domain/settings';
import { byosError, ByosError } from './byosError';
import {
  BYOS_PKCE_SESSION_SCHEMA_VERSION,
  type ByosPkceSessionStore,
  type ByosPkceSessionV1,
} from './byosPkceSession';

export const BYOS_ORIGIN = 'https://byos.ashfame.com';
export const BYOS_AUTHORIZE_URL = `${BYOS_ORIGIN}/oauth2/auth`;
export const BYOS_TOKEN_URL = `${BYOS_ORIGIN}/oauth2/token`;
export const BYOS_REQUIRED_SCOPES = Object.freeze([
  'storage:app',
  'storage:s3',
] as const);
export const BYOS_SCOPE = BYOS_REQUIRED_SCOPES.join(' ');
export const BYOS_TOKEN_EXPIRY_SKEW_SECONDS = 60;
export const BYOS_PKCE_MAX_AGE_MS = 10 * 60 * 1000;

const forbiddenIdentityScopes = new Set([
  'openid',
  'profile',
  'email',
  'offline_access',
]);

export interface ByosIdentityPort {
  getRedirectURL(): string;
  launchWebAuthFlow(authorizeUrl: string): Promise<string>;
}

export interface ByosHttpRequest {
  readonly url: string;
  readonly method: 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface ByosHttpResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface ByosHttpTransport {
  request(request: ByosHttpRequest): Promise<ByosHttpResponse>;
}

export type ByosRandomBytes = (length: number) => Uint8Array;
export type ByosClock = () => Date;
export type ByosDigest = (value: Uint8Array) => Promise<ArrayBuffer>;

export interface ByosOAuthDependencies {
  readonly session: ByosPkceSessionStore;
  readonly identity: ByosIdentityPort;
  readonly http: ByosHttpTransport;
  readonly clock: ByosClock;
  readonly randomBytes?: ByosRandomBytes;
  readonly digest?: ByosDigest;
}

export interface PreparedByosAuthorization {
  readonly authorizeUrl: string;
  readonly session: ByosPkceSessionV1;
}

function encodeBase64Url(bytes: Uint8Array): string {
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let encoded = '';

  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const combined =
      (first << 16) | ((second ?? 0) << 8) | (third === undefined ? 0 : third);

    encoded += alphabet[(combined >>> 18) & 0x3f];
    encoded += alphabet[(combined >>> 12) & 0x3f];

    if (second !== undefined) {
      encoded += alphabet[(combined >>> 6) & 0x3f];
    }

    if (third !== undefined) {
      encoded += alphabet[combined & 0x3f];
    }
  }

  return encoded;
}

function defaultRandomBytes(length: number): Uint8Array {
  const value = new Uint8Array(length);
  crypto.getRandomValues(value);
  return value;
}

function defaultDigest(value: Uint8Array): Promise<ArrayBuffer> {
  const copy = new Uint8Array(value.length);
  copy.set(value);
  return crypto.subtle.digest('SHA-256', copy);
}

function nonEmptyTrimmed(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.trim() === value
  );
}

function validClockValue(clock: ByosClock): Date {
  let value: Date;

  try {
    value = clock();
  } catch {
    throw byosError(
      'authorization-failed',
      'BYOS authorization could not start. Retry.',
    );
  }

  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw byosError(
      'authorization-failed',
      'BYOS authorization could not start. Retry.',
    );
  }

  return value;
}

function validateClientId(clientId: string): string {
  const normalized = clientId.trim();

  if (normalized === '') {
    throw byosError(
      'configuration-required',
      'BYOS connection is unavailable in this build.',
    );
  }

  return normalized;
}

function validateRedirectUri(value: string): string {
  try {
    const parsed = new URL(value);

    if (
      parsed.protocol !== 'https:' ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.search !== '' ||
      parsed.hash !== '' ||
      parsed.href !== value
    ) {
      throw new Error('invalid');
    }

    return value;
  } catch {
    throw byosError(
      'authorization-failed',
      'BYOS authorization could not start. Retry.',
    );
  }
}

function generateEntropy(randomBytes: ByosRandomBytes): string {
  try {
    const value = randomBytes(32);

    if (!(value instanceof Uint8Array) || value.length !== 32) {
      throw new Error('invalid random output');
    }

    return encodeBase64Url(value);
  } catch {
    throw byosError(
      'randomness-failed',
      'Secure BYOS authorization values could not be generated. Retry.',
    );
  }
}

export async function createS256CodeChallenge(
  codeVerifier: string,
  digest: ByosDigest = defaultDigest,
): Promise<string> {
  if (
    codeVerifier.length < 43 ||
    codeVerifier.length > 128 ||
    !/^[A-Za-z0-9._~-]+$/u.test(codeVerifier)
  ) {
    throw byosError(
      'authorization-failed',
      'BYOS authorization could not start. Retry.',
    );
  }

  try {
    const hashed = await digest(new TextEncoder().encode(codeVerifier));
    return encodeBase64Url(new Uint8Array(hashed));
  } catch {
    throw byosError(
      'authorization-failed',
      'BYOS authorization could not start. Retry.',
    );
  }
}

export function buildByosAuthorizeUrl(input: {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly codeChallenge: string;
}): string {
  const parameters = new URLSearchParams();
  parameters.set('response_type', 'code');
  parameters.set('client_id', validateClientId(input.clientId));
  parameters.set('redirect_uri', validateRedirectUri(input.redirectUri));
  parameters.set('scope', BYOS_SCOPE);
  parameters.set('state', input.state);
  parameters.set('code_challenge', input.codeChallenge);
  parameters.set('code_challenge_method', 'S256');

  return `${BYOS_AUTHORIZE_URL}?${parameters.toString()}`;
}

function callbackAuthorizationCode(
  callbackUrl: string,
  session: ByosPkceSessionV1,
): string {
  let callback: URL;
  let redirect: URL;

  try {
    callback = new URL(callbackUrl);
    redirect = new URL(session.redirectUri);
  } catch {
    throw byosError(
      'authorization-failed',
      'BYOS returned an invalid authorization response. Retry.',
    );
  }

  if (
    callback.origin !== redirect.origin ||
    callback.pathname !== redirect.pathname ||
    callback.username !== '' ||
    callback.password !== '' ||
    callback.hash !== ''
  ) {
    throw byosError(
      'authorization-failed',
      'BYOS returned an invalid authorization response. Retry.',
    );
  }

  const states = callback.searchParams.getAll('state');
  const codes = callback.searchParams.getAll('code');
  const errors = callback.searchParams.getAll('error');
  const errorDescriptions = callback.searchParams.getAll('error_description');

  if (
    states.length !== 1 ||
    !nonEmptyTrimmed(states[0]) ||
    codes.length > 1 ||
    errors.length > 1 ||
    errorDescriptions.length > 1
  ) {
    throw byosError(
      'authorization-failed',
      'BYOS returned an invalid authorization response. Retry.',
    );
  }

  if (states[0] !== session.state) {
    throw byosError(
      'state-mismatch',
      'BYOS authorization state did not match. Restart the connection.',
    );
  }

  if (errors.length === 1) {
    throw byosError(
      'authorization-failed',
      'BYOS authorization was not completed. Retry.',
    );
  }

  if (codes.length !== 1 || !nonEmptyTrimmed(codes[0])) {
    throw byosError(
      'authorization-failed',
      'BYOS returned an invalid authorization response. Retry.',
    );
  }

  return codes[0];
}

function validateTokenResponse(body: unknown, now: Date): ByosConnectionV1 {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw byosError(
      'token-failed',
      'BYOS returned an invalid token response. Reconnect.',
    );
  }

  const value = body as Record<string, unknown>;
  const keys = Object.keys(value);
  const scope =
    typeof value.scope === 'string'
      ? value.scope.split(/\s+/u).filter(Boolean)
      : [];
  const scopeSet = new Set(scope);
  const expiresIn = value.expires_in;

  if (
    keys.length !== 4 ||
    !['access_token', 'token_type', 'expires_in', 'scope'].every((key) =>
      Object.prototype.hasOwnProperty.call(value, key),
    ) ||
    !nonEmptyTrimmed(value.access_token) ||
    typeof value.token_type !== 'string' ||
    value.token_type.toLowerCase() !== 'bearer' ||
    typeof expiresIn !== 'number' ||
    !Number.isFinite(expiresIn) ||
    !Number.isInteger(expiresIn) ||
    expiresIn <= BYOS_TOKEN_EXPIRY_SKEW_SECONDS ||
    scope.length !== BYOS_REQUIRED_SCOPES.length ||
    scopeSet.size !== BYOS_REQUIRED_SCOPES.length ||
    !BYOS_REQUIRED_SCOPES.every((required) => scopeSet.has(required)) ||
    scope.some((candidate) =>
      forbiddenIdentityScopes.has(candidate.toLowerCase()),
    )
  ) {
    throw byosError(
      'token-failed',
      'BYOS returned an invalid token response. Reconnect.',
    );
  }

  const adjustedExpiry = new Date(
    now.valueOf() + (expiresIn - BYOS_TOKEN_EXPIRY_SKEW_SECONDS) * 1000,
  );

  if (adjustedExpiry.valueOf() <= now.valueOf()) {
    throw byosError(
      'token-failed',
      'BYOS returned a token that expires too soon. Reconnect.',
    );
  }

  return Object.freeze({
    accessToken: value.access_token,
    connectedAt: now.toISOString(),
    expiresAt: adjustedExpiry.toISOString(),
  });
}

export class ByosOAuthClient {
  readonly #dependencies: Required<ByosOAuthDependencies>;

  constructor(dependencies: ByosOAuthDependencies) {
    this.#dependencies = {
      ...dependencies,
      randomBytes: dependencies.randomBytes ?? defaultRandomBytes,
      digest: dependencies.digest ?? defaultDigest,
    };
  }

  async prepareAuthorization(
    clientId: string,
  ): Promise<PreparedByosAuthorization> {
    const normalizedClientId = validateClientId(clientId);
    let redirectUri: string;

    try {
      redirectUri = validateRedirectUri(
        this.#dependencies.identity.getRedirectURL(),
      );
    } catch (error) {
      if (error instanceof ByosError) {
        throw error;
      }

      throw byosError(
        'authorization-failed',
        'BYOS authorization could not start. Retry.',
      );
    }

    const codeVerifier = generateEntropy(this.#dependencies.randomBytes);
    const state = generateEntropy(this.#dependencies.randomBytes);
    const codeChallenge = await createS256CodeChallenge(
      codeVerifier,
      this.#dependencies.digest,
    );
    const session = Object.freeze({
      schemaVersion: BYOS_PKCE_SESSION_SCHEMA_VERSION,
      codeVerifier,
      state,
      redirectUri,
      createdAt: validClockValue(this.#dependencies.clock).toISOString(),
    });
    const authorizeUrl = buildByosAuthorizeUrl({
      clientId: normalizedClientId,
      redirectUri,
      state,
      codeChallenge,
    });

    try {
      await this.#dependencies.session.save(session);
    } catch {
      throw byosError(
        'session-failed',
        'BYOS authorization could not be saved safely. Retry.',
      );
    }

    return Object.freeze({ authorizeUrl, session });
  }

  async launchAuthorization(authorizeUrl: string): Promise<string> {
    try {
      const callbackUrl =
        await this.#dependencies.identity.launchWebAuthFlow(authorizeUrl);

      if (!nonEmptyTrimmed(callbackUrl)) {
        throw new Error('missing callback');
      }

      return callbackUrl;
    } catch {
      throw byosError(
        'authorization-failed',
        'BYOS authorization was not completed. Retry.',
      );
    }
  }

  async completeAuthorization(
    clientId: string,
    callbackUrl: string,
  ): Promise<ByosConnectionV1> {
    const normalizedClientId = validateClientId(clientId);
    let session: ByosPkceSessionV1 | undefined;

    try {
      session = await this.#dependencies.session.load();
    } catch {
      throw byosError(
        'session-failed',
        'The pending BYOS authorization could not be read safely. Restart the connection.',
      );
    }

    if (session === undefined) {
      throw byosError(
        'authorization-failed',
        'No pending BYOS authorization was found. Restart the connection.',
      );
    }

    const now = validClockValue(this.#dependencies.clock);
    const createdAt = new Date(session.createdAt).valueOf();

    if (
      createdAt > now.valueOf() + 60_000 ||
      now.valueOf() - createdAt > BYOS_PKCE_MAX_AGE_MS
    ) {
      try {
        await this.#dependencies.session.clear();
      } catch {
        throw byosError(
          'session-failed',
          'The stale BYOS authorization could not be cleared. Retry.',
        );
      }

      throw byosError(
        'authorization-failed',
        'The pending BYOS authorization expired. Restart the connection.',
      );
    }

    const code = callbackAuthorizationCode(callbackUrl, session);
    const form = new URLSearchParams();
    form.set('grant_type', 'authorization_code');
    form.set('client_id', normalizedClientId);
    form.set('redirect_uri', session.redirectUri);
    form.set('code', code);
    form.set('code_verifier', session.codeVerifier);
    let response: ByosHttpResponse;

    try {
      response = await this.#dependencies.http.request({
        url: BYOS_TOKEN_URL,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
      });
    } catch {
      throw byosError('token-failed', 'BYOS token exchange failed. Reconnect.');
    }

    if (response.status !== 200) {
      throw byosError('token-failed', 'BYOS token exchange failed. Reconnect.');
    }

    return validateTokenResponse(response.body, now);
  }

  clearPendingAuthorization(): Promise<void> {
    return this.#dependencies.session.clear();
  }
}
