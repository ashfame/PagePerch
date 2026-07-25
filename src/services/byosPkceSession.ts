export const BYOS_PKCE_SESSION_SCHEMA_VERSION = 1 as const;
export const BYOS_PKCE_SESSION_STORAGE_KEY = 'pageperch:v1:byos-pkce';

export interface ByosPkceSessionV1 {
  readonly schemaVersion: typeof BYOS_PKCE_SESSION_SCHEMA_VERSION;
  readonly codeVerifier: string;
  readonly state: string;
  readonly redirectUri: string;
  readonly createdAt: string;
}

export interface ByosPkceSessionStore {
  load(): Promise<ByosPkceSessionV1 | undefined>;
  save(session: ByosPkceSessionV1): Promise<void>;
  clear(): Promise<void>;
}

export class ByosPkceSessionError extends Error {
  readonly kind: 'future-schema' | 'malformed';

  constructor(kind: 'future-schema' | 'malformed') {
    super(
      kind === 'future-schema'
        ? 'The pending BYOS authorization uses an unsupported schema and was left untouched.'
        : 'The pending BYOS authorization is malformed and needs to be restarted.',
    );
    this.name = 'ByosPkceSessionError';
    this.kind = kind;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyTrimmedString(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.trim() === value
  );
}

function isValidRedirectUri(value: unknown): value is string {
  if (!isNonEmptyTrimmedString(value)) {
    return false;
  }

  try {
    const parsed = new URL(value);

    return (
      parsed.protocol === 'https:' &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.search === '' &&
      parsed.hash === '' &&
      parsed.href === value
    );
  } catch {
    return false;
  }
}

function isIsoTimestamp(value: unknown): value is string {
  if (!isNonEmptyTrimmedString(value)) {
    return false;
  }

  const parsed = new Date(value);

  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function isBase64UrlEntropy(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 43 &&
    value.length <= 128 &&
    /^[A-Za-z0-9_-]+$/u.test(value)
  );
}

export function parseByosPkceSession(value: unknown): ByosPkceSessionV1 {
  if (!isRecord(value)) {
    throw new ByosPkceSessionError('malformed');
  }

  if (
    typeof value.schemaVersion === 'number' &&
    value.schemaVersion > BYOS_PKCE_SESSION_SCHEMA_VERSION
  ) {
    throw new ByosPkceSessionError('future-schema');
  }

  const keys = Object.keys(value);

  if (
    keys.length !== 5 ||
    ![
      'schemaVersion',
      'codeVerifier',
      'state',
      'redirectUri',
      'createdAt',
    ].every((key) => Object.prototype.hasOwnProperty.call(value, key)) ||
    value.schemaVersion !== BYOS_PKCE_SESSION_SCHEMA_VERSION ||
    !isBase64UrlEntropy(value.codeVerifier) ||
    !isBase64UrlEntropy(value.state) ||
    !isValidRedirectUri(value.redirectUri) ||
    !isIsoTimestamp(value.createdAt)
  ) {
    throw new ByosPkceSessionError('malformed');
  }

  return Object.freeze({
    schemaVersion: BYOS_PKCE_SESSION_SCHEMA_VERSION,
    codeVerifier: value.codeVerifier,
    state: value.state,
    redirectUri: value.redirectUri,
    createdAt: value.createdAt,
  });
}
