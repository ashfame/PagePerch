import { NOTE_SCHEMA_VERSION, type NoteRecordV1 } from '../domain/note';
import {
  SETTINGS_LEGACY_SCHEMA_VERSION,
  SETTINGS_SCHEMA_VERSION,
  type ByosConnectionV1,
  type EditorMode,
  type SettingsRecordV0,
  type SettingsRecordV1,
} from '../domain/settings';
import type { PageIdentityExclusionRule } from '../domain/pageIdentity';

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: UnknownRecord,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): boolean {
  const allowedKeys = new Set([...requiredKeys, ...optionalKeys]);

  return (
    requiredKeys.every((key) =>
      Object.prototype.hasOwnProperty.call(value, key),
    ) && Object.keys(value).every((key) => allowedKeys.has(key))
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function isPageKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u.test(value)
  );
}

export function isUtcIsoTimestamp(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)
  ) {
    return false;
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.valueOf())) {
    return false;
  }

  const normalized = parsed.toISOString();

  return value.includes('.')
    ? normalized === value
    : normalized.replace('.000Z', 'Z') === value;
}

export function isExactHttpOrigin(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }

  try {
    const parsed = new URL(value);

    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.origin === value &&
      parsed.pathname === '/' &&
      parsed.search === '' &&
      parsed.hash === ''
    );
  } catch {
    return false;
  }
}

function isCanonicalHttpUrlForOrigin(
  value: unknown,
  origin: string,
): value is string {
  if (typeof value !== 'string') {
    return false;
  }

  try {
    const parsed = new URL(value);

    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.origin === origin &&
      !value.includes('#') &&
      !(parsed.search === '' && value.includes('?')) &&
      parsed.href === value
    );
  } catch {
    return false;
  }
}

export function isNoteRecordV1(value: unknown): value is NoteRecordV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      [
        'schemaVersion',
        'pageKey',
        'canonicalUrl',
        'representativeUrl',
        'origin',
        'title',
        'contentHtml',
        'contentHash',
        'savedAt',
        'revisionId',
      ],
      ['deletedAt'],
    ) ||
    value.schemaVersion !== NOTE_SCHEMA_VERSION ||
    !isPageKey(value.pageKey) ||
    !isExactHttpOrigin(value.origin) ||
    !isCanonicalHttpUrlForOrigin(value.canonicalUrl, value.origin) ||
    !isCanonicalHttpUrlForOrigin(value.representativeUrl, value.origin) ||
    typeof value.title !== 'string' ||
    typeof value.contentHtml !== 'string' ||
    !isNonEmptyString(value.contentHash) ||
    !isUtcIsoTimestamp(value.savedAt) ||
    !isNonEmptyString(value.revisionId)
  ) {
    return false;
  }

  return value.deletedAt === undefined || isUtcIsoTimestamp(value.deletedAt);
}

function isEditorMode(value: unknown): value is EditorMode {
  return value === 'text-focused-blocks' || value === 'paragraphs-only';
}

function isPageIdentityExclusionRule(
  value: unknown,
): value is PageIdentityExclusionRule {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['origin', 'parameterNames']) &&
    isExactHttpOrigin(value.origin) &&
    Array.isArray(value.parameterNames) &&
    value.parameterNames.every(isNonEmptyString)
  );
}

function isByosConnectionV1(value: unknown): value is ByosConnectionV1 {
  return (
    isRecord(value) &&
    hasExactKeys(
      value,
      ['accessToken', 'expiresAt', 'connectedAt'],
      ['lastSuccessfulSyncAt'],
    ) &&
    isNonEmptyString(value.accessToken) &&
    isUtcIsoTimestamp(value.expiresAt) &&
    isUtcIsoTimestamp(value.connectedAt) &&
    (value.lastSuccessfulSyncAt === undefined ||
      isUtcIsoTimestamp(value.lastSuccessfulSyncAt))
  );
}

export function isSettingsRecordV1(value: unknown): value is SettingsRecordV1 {
  return (
    isRecord(value) &&
    hasExactKeys(
      value,
      ['schemaVersion', 'editorMode', 'pageIdentityExclusions'],
      ['byosConnection'],
    ) &&
    value.schemaVersion === SETTINGS_SCHEMA_VERSION &&
    isEditorMode(value.editorMode) &&
    Array.isArray(value.pageIdentityExclusions) &&
    value.pageIdentityExclusions.every(isPageIdentityExclusionRule) &&
    (value.byosConnection === undefined ||
      isByosConnectionV1(value.byosConnection))
  );
}

export function isSettingsRecordV0(value: unknown): value is SettingsRecordV0 {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['schemaVersion', 'editorMode']) &&
    value.schemaVersion === SETTINGS_LEGACY_SCHEMA_VERSION &&
    isEditorMode(value.editorMode)
  );
}

export function readSchemaVersion(value: unknown): number | undefined {
  if (!isRecord(value) || typeof value.schemaVersion !== 'number') {
    return undefined;
  }

  return value.schemaVersion;
}
