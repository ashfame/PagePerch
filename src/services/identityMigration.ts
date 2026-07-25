import { NOTE_SCHEMA_VERSION, type NoteRecordV1 } from '../domain/note';
import type {
  BuiltInPageIdentityExclusions,
  PageIdentity,
  PageIdentityExclusionRule,
  PageIdentityService,
} from '../domain/pageIdentity';
import {
  SETTINGS_SCHEMA_VERSION,
  type ByosConnectionV1,
  type SettingsRecordV1,
} from '../domain/settings';
import {
  isExactHttpOrigin,
  isNoteRecordV1,
  isSha256Base64Url,
  isSettingsRecordV1,
  isUtcIsoTimestamp,
} from '../repositories/validation';
import { normalizeGutenbergContent } from './note';
import {
  BUILT_IN_PAGE_IDENTITY_EXCLUSIONS,
  createPageIdentityKey,
} from './pageIdentity';

export const IDENTITY_MIGRATION_PLAN_SCHEMA_VERSION = 1 as const;

export type IdentityMigrationPlanErrorCode =
  | 'dependency-failure'
  | 'hash-failure'
  | 'identity-failure'
  | 'invalid-dependency'
  | 'invalid-plan'
  | 'invalid-record'
  | 'invalid-settings'
  | 'invalid-settings-change'
  | 'mismatched-identity'
  | 'unsupported-identity';

export class IdentityMigrationPlanError extends Error {
  readonly code: IdentityMigrationPlanErrorCode;

  constructor(code: IdentityMigrationPlanErrorCode, message: string) {
    super(message);
    this.name = 'IdentityMigrationPlanError';
    this.code = code;
  }
}

export interface IdentityMigrationPlannerInput {
  readonly currentSettings: SettingsRecordV1;
  readonly requestedSettings: SettingsRecordV1;
  readonly records: readonly NoteRecordV1[];
  readonly clock: () => Date;
  readonly operationIdFactory: () => string;
  readonly revisionIdFactory: () => string;
  readonly pageIdentityService: PageIdentityService;
}

export interface IdentityMigrationExpectedSettings {
  readonly fingerprint: string;
  readonly record: SettingsRecordV1;
}

export interface IdentityMigrationExpectedSource {
  readonly fingerprint: string;
  readonly record: NoteRecordV1;
}

export interface IdentityMigrationDestinationWrite {
  readonly expectedRecordFingerprint: string | null;
  readonly record: NoteRecordV1;
}

export interface IdentityMigrationTombstoneWrite {
  readonly expectedRecordFingerprint: string;
  readonly record: NoteRecordV1;
}

export interface IdentityMigrationChange {
  readonly kind: 'add-parameter-exclusion' | 'remove-parameter-exclusion';
  readonly origin: string;
  readonly parameterName: string;
}

export interface PlannedIdentityMigration {
  readonly schemaVersion: typeof IDENTITY_MIGRATION_PLAN_SCHEMA_VERSION;
  readonly status: 'planned';
  readonly operationId: string;
  readonly phase: 'planned';
  readonly plannedAt: string;
  readonly change: IdentityMigrationChange;
  readonly expected: {
    readonly settings: IdentityMigrationExpectedSettings;
    readonly sources: readonly IdentityMigrationExpectedSource[];
  };
  readonly destinations: readonly IdentityMigrationDestinationWrite[];
  readonly sourceTombstones: readonly IdentityMigrationTombstoneWrite[];
  readonly requestedSettings: SettingsRecordV1;
}

export interface IdentityMigrationNoOp {
  readonly schemaVersion: typeof IDENTITY_MIGRATION_PLAN_SCHEMA_VERSION;
  readonly status: 'no-op';
  readonly reason: 'already-applied';
}

export type IdentityMigrationPlan =
  IdentityMigrationNoOp | PlannedIdentityMigration;

interface IdentifiedRecord {
  readonly record: NoteRecordV1;
  readonly requestedIdentity: PageIdentity;
}

interface DestinationSpec {
  readonly contentHtml: string;
  readonly identity: PageIdentity;
  readonly representativeUrl: string;
  readonly title: string;
}

interface TombstoneSpec {
  readonly source: NoteRecordV1;
}

const IDENTIFIER_MAX_LENGTH = 256;

function fail(code: IdentityMigrationPlanErrorCode, message: string): never {
  throw new IdentityMigrationPlanError(code, message);
}

type UnknownRecord = Record<string, unknown>;

function isUnknownRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: UnknownRecord,
  required: readonly string[],
): boolean {
  return (
    Object.keys(value).length === required.length &&
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}

function cloneByosConnection(
  connection: ByosConnectionV1 | undefined,
): ByosConnectionV1 | undefined {
  if (connection === undefined) {
    return undefined;
  }

  return connection.lastSuccessfulSyncAt === undefined
    ? {
        accessToken: connection.accessToken,
        expiresAt: connection.expiresAt,
        connectedAt: connection.connectedAt,
      }
    : {
        accessToken: connection.accessToken,
        expiresAt: connection.expiresAt,
        connectedAt: connection.connectedAt,
        lastSuccessfulSyncAt: connection.lastSuccessfulSyncAt,
      };
}

function cloneRule(rule: PageIdentityExclusionRule): PageIdentityExclusionRule {
  return {
    origin: rule.origin,
    parameterNames: [...rule.parameterNames],
  };
}

function cloneSettings(settings: SettingsRecordV1): SettingsRecordV1 {
  const byosConnection = cloneByosConnection(settings.byosConnection);
  const clone: SettingsRecordV1 = {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    editorMode: settings.editorMode,
    pageIdentityExclusions: settings.pageIdentityExclusions.map(cloneRule),
    ...(byosConnection === undefined ? {} : { byosConnection }),
  };

  return clone;
}

function cloneNote(record: NoteRecordV1): NoteRecordV1 {
  return {
    schemaVersion: NOTE_SCHEMA_VERSION,
    pageKey: record.pageKey,
    canonicalUrl: record.canonicalUrl,
    representativeUrl: record.representativeUrl,
    origin: record.origin,
    title: record.title,
    contentHtml: record.contentHtml,
    contentHash: record.contentHash,
    savedAt: record.savedAt,
    revisionId: record.revisionId,
    ...(record.deletedAt === undefined ? {} : { deletedAt: record.deletedAt }),
  };
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

function normalizeOrigin(origin: unknown, label: string): string {
  if (
    typeof origin !== 'string' ||
    origin.length === 0 ||
    origin.trim() !== origin
  ) {
    fail('invalid-settings', `${label} must be a non-empty, trimmed origin.`);
  }

  try {
    const parsed = new URL(origin);

    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.pathname !== '/' ||
      origin.includes('?') ||
      origin.includes('#') ||
      parsed.search !== '' ||
      parsed.hash !== ''
    ) {
      fail('invalid-settings', `${label} must be an exact HTTP(S) origin.`);
    }

    return parsed.origin;
  } catch (error) {
    if (error instanceof IdentityMigrationPlanError) {
      throw error;
    }

    return fail(
      'invalid-settings',
      `${label} must be an exact HTTP(S) origin.`,
    );
  }
}

function normalizeBuiltIns(
  serviceBuiltIns: BuiltInPageIdentityExclusions,
): BuiltInPageIdentityExclusions {
  const normalizeList = (value: unknown, label: string): readonly string[] => {
    if (!Array.isArray(value)) {
      fail('invalid-dependency', `${label} must contain non-empty strings.`);
    }

    const entries = value as readonly unknown[];

    if (
      entries.some(
        (entry) =>
          typeof entry !== 'string' ||
          entry.length === 0 ||
          entry.trim() !== entry,
      )
    ) {
      fail('invalid-dependency', `${label} must contain non-empty strings.`);
    }

    return entries.map((entry) => (entry as string).toLowerCase());
  };

  return {
    exactParameterNames: normalizeList(
      serviceBuiltIns.exactParameterNames,
      'Built-in exact exclusions',
    ),
    parameterNamePrefixes: normalizeList(
      serviceBuiltIns.parameterNamePrefixes,
      'Built-in exclusion prefixes',
    ),
  };
}

function isBuiltInParameterName(
  parameterName: string,
  serviceBuiltIns: BuiltInPageIdentityExclusions,
): boolean {
  const exactNames = [
    ...BUILT_IN_PAGE_IDENTITY_EXCLUSIONS.exactParameterNames,
    ...serviceBuiltIns.exactParameterNames,
  ];
  const prefixes = [
    ...BUILT_IN_PAGE_IDENTITY_EXCLUSIONS.parameterNamePrefixes,
    ...serviceBuiltIns.parameterNamePrefixes,
  ];

  return (
    exactNames.some((exactName) => exactName.toLowerCase() === parameterName) ||
    prefixes.some((prefix) => parameterName.startsWith(prefix.toLowerCase()))
  );
}

function normalizeParameterName(
  value: unknown,
  label: string,
  serviceBuiltIns: BuiltInPageIdentityExclusions,
): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail(
      'invalid-settings',
      `${label} must be a non-empty exact query parameter name.`,
    );
  }

  const normalized = value.toLowerCase();

  if (isBuiltInParameterName(normalized, serviceBuiltIns)) {
    fail(
      'invalid-settings',
      `${label} duplicates a built-in page identity exclusion.`,
    );
  }

  return normalized;
}

function normalizeSettings(
  value: SettingsRecordV1,
  label: string,
  serviceBuiltIns: BuiltInPageIdentityExclusions,
): SettingsRecordV1 {
  const candidate: unknown = value;

  if (typeof candidate !== 'object' || candidate === null) {
    fail('invalid-settings', `${label} is not a settings record.`);
  }

  const rawSettings = candidate as Record<string, unknown>;
  const rawRules = rawSettings.pageIdentityExclusions;

  if (!Array.isArray(rawRules)) {
    fail('invalid-settings', `${label} is not a settings record.`);
  }

  const seenOrigins = new Set<string>();
  const rules = (rawRules as readonly unknown[]).map(
    (candidateRule, ruleIndex) => {
      if (typeof candidateRule !== 'object' || candidateRule === null) {
        return fail(
          'invalid-settings',
          `${label} rule ${ruleIndex} must contain at least one parameter name.`,
        );
      }

      const rule = candidateRule as Record<string, unknown>;

      if (
        Object.keys(rule).length !== 2 ||
        !Object.prototype.hasOwnProperty.call(rule, 'origin') ||
        !Object.prototype.hasOwnProperty.call(rule, 'parameterNames') ||
        !Array.isArray(rule.parameterNames)
      ) {
        return fail(
          'invalid-settings',
          `${label} rule ${ruleIndex} must contain a parameterNames array.`,
        );
      }

      const origin = normalizeOrigin(
        rule.origin,
        `${label} rule ${ruleIndex} origin`,
      );

      if (seenOrigins.has(origin)) {
        return fail(
          'invalid-settings',
          `${label} contains duplicate rules for ${origin}.`,
        );
      }

      seenOrigins.add(origin);
      const seenNames = new Set<string>();
      const parameterNames = (rule.parameterNames as unknown[]).map(
        (parameterName: unknown, parameterIndex: number) => {
          const normalized = normalizeParameterName(
            parameterName,
            `${label} rule ${ruleIndex} parameter ${parameterIndex}`,
            serviceBuiltIns,
          );

          if (seenNames.has(normalized)) {
            return fail(
              'invalid-settings',
              `${label} contains a duplicate parameter name for ${origin}.`,
            );
          }

          seenNames.add(normalized);
          return normalized;
        },
      );

      parameterNames.sort(compareCodeUnits);

      return {
        origin,
        parameterNames,
      };
    },
  );

  rules.sort((left, right) => compareCodeUnits(left.origin, right.origin));

  const normalized: SettingsRecordV1 = {
    ...rawSettings,
    pageIdentityExclusions: rules,
  } as unknown as SettingsRecordV1;

  if (!isSettingsRecordV1(normalized)) {
    fail('invalid-settings', `${label} is not a valid v1 settings record.`);
  }

  return cloneSettings(normalized);
}

function settingsCoreFingerprintInput(settings: SettingsRecordV1): string {
  const byos = settings.byosConnection;

  return JSON.stringify({
    schemaVersion: settings.schemaVersion,
    editorMode: settings.editorMode,
    byosConnection:
      byos === undefined
        ? null
        : {
            accessToken: byos.accessToken,
            expiresAt: byos.expiresAt,
            connectedAt: byos.connectedAt,
            lastSuccessfulSyncAt: byos.lastSuccessfulSyncAt ?? null,
          },
  });
}

function settingsFingerprintInput(settings: SettingsRecordV1): string {
  return JSON.stringify({
    schemaVersion: settings.schemaVersion,
    editorMode: settings.editorMode,
    pageIdentityExclusions: settings.pageIdentityExclusions.map((rule) => ({
      origin: rule.origin,
      parameterNames: [...rule.parameterNames],
    })),
    byosConnection:
      settings.byosConnection === undefined
        ? null
        : {
            accessToken: settings.byosConnection.accessToken,
            expiresAt: settings.byosConnection.expiresAt,
            connectedAt: settings.byosConnection.connectedAt,
            lastSuccessfulSyncAt:
              settings.byosConnection.lastSuccessfulSyncAt ?? null,
          },
  });
}

function noteFingerprintInput(record: NoteRecordV1): string {
  return JSON.stringify({
    schemaVersion: record.schemaVersion,
    pageKey: record.pageKey,
    canonicalUrl: record.canonicalUrl,
    representativeUrl: record.representativeUrl,
    origin: record.origin,
    title: record.title,
    contentHtml: record.contentHtml,
    contentHash: record.contentHash,
    savedAt: record.savedAt,
    revisionId: record.revisionId,
    deletedAt: record.deletedAt ?? null,
  });
}

async function hashValue(value: string, purpose: string): Promise<string> {
  try {
    return await createPageIdentityKey(value);
  } catch {
    return fail('hash-failure', `Could not hash ${purpose}.`);
  }
}

async function validateNoteRecord(
  value: unknown,
  label: string,
): Promise<NoteRecordV1> {
  if (!isNoteRecordV1(value)) {
    return fail('invalid-record', `${label} is not a valid v1 note record.`);
  }

  const expectedPageKey = await hashValue(
    value.canonicalUrl,
    `${label} canonical URL`,
  );
  const expectedContentHash = await hashValue(
    value.contentHtml,
    `${label} content`,
  );

  if (
    value.pageKey !== expectedPageKey ||
    value.contentHash !== expectedContentHash
  ) {
    return fail(
      'invalid-record',
      `${label} has a mismatched canonical or content hash.`,
    );
  }

  if (value.deletedAt !== undefined && value.contentHtml !== '') {
    return fail(
      'invalid-record',
      `${label} is a tombstone that still contains live content.`,
    );
  }

  return cloneNote(value);
}

export async function fingerprintIdentityMigrationSettings(
  value: unknown,
): Promise<string> {
  const builtIns = normalizeBuiltIns(BUILT_IN_PAGE_IDENTITY_EXCLUSIONS);
  const normalized = normalizeSettings(
    value as SettingsRecordV1,
    'Settings fingerprint input',
    builtIns,
  );

  return hashValue(
    settingsFingerprintInput(normalized),
    'settings fingerprint input',
  );
}

export async function fingerprintIdentityMigrationNote(
  value: unknown,
): Promise<string> {
  const record = await validateNoteRecord(value, 'Note fingerprint input');

  return hashValue(noteFingerprintInput(record), 'note fingerprint input');
}

interface ExclusionPair {
  readonly origin: string;
  readonly parameterName: string;
}

function exclusionPairs(
  settings: SettingsRecordV1,
): ReadonlyMap<string, ExclusionPair> {
  const pairs = new Map<string, ExclusionPair>();

  for (const rule of settings.pageIdentityExclusions) {
    for (const parameterName of rule.parameterNames) {
      const pair = {
        origin: rule.origin,
        parameterName,
      };
      pairs.set(JSON.stringify([pair.origin, pair.parameterName]), pair);
    }
  }

  return pairs;
}

function deriveChange(
  currentSettings: SettingsRecordV1,
  requestedSettings: SettingsRecordV1,
): IdentityMigrationChange | undefined {
  if (
    settingsCoreFingerprintInput(currentSettings) !==
    settingsCoreFingerprintInput(requestedSettings)
  ) {
    fail(
      'invalid-settings-change',
      'Identity migration cannot change editor mode or BYOS settings.',
    );
  }

  const currentPairs = exclusionPairs(currentSettings);
  const requestedPairs = exclusionPairs(requestedSettings);
  const additions = [...requestedPairs.entries()].filter(
    ([key]) => !currentPairs.has(key),
  );
  const removals = [...currentPairs.entries()].filter(
    ([key]) => !requestedPairs.has(key),
  );

  if (additions.length === 0 && removals.length === 0) {
    return undefined;
  }

  if (additions.length + removals.length !== 1) {
    fail(
      'invalid-settings-change',
      'Identity migration must add or remove exactly one parameter exclusion.',
    );
  }

  const kind =
    additions.length === 1
      ? 'add-parameter-exclusion'
      : 'remove-parameter-exclusion';
  const pairEntry = additions[0] ?? removals[0];

  if (pairEntry === undefined) {
    return fail(
      'invalid-settings-change',
      'Identity migration change could not be determined.',
    );
  }

  const pair = pairEntry[1];

  return {
    kind,
    origin: pair.origin,
    parameterName: pair.parameterName,
  };
}

async function validateRecords(
  records: readonly NoteRecordV1[],
): Promise<readonly NoteRecordV1[]> {
  if (!Array.isArray(records)) {
    return fail('invalid-record', 'Migration records must be an array.');
  }

  const clones: NoteRecordV1[] = [];
  const seenPageKeys = new Set<string>();

  for (const [index, candidate] of records.entries()) {
    const record = await validateNoteRecord(candidate, `Record ${index}`);

    if (seenPageKeys.has(record.pageKey)) {
      return fail(
        'invalid-record',
        `Record ${index} duplicates page key ${record.pageKey}.`,
      );
    }

    seenPageKeys.add(record.pageKey);
    clones.push(record);
  }

  clones.sort((left, right) => compareCodeUnits(left.pageKey, right.pageKey));
  return clones;
}

function validateIdentityShape(identity: unknown): identity is PageIdentity {
  if (
    !isUnknownRecord(identity) ||
    !hasExactKeys(identity, [
      'canonicalUrl',
      'isRoot',
      'origin',
      'pageKey',
      'pathname',
    ])
  ) {
    return false;
  }

  if (
    !isExactHttpOrigin(identity.origin) ||
    typeof identity.canonicalUrl !== 'string' ||
    typeof identity.pageKey !== 'string' ||
    typeof identity.pathname !== 'string' ||
    typeof identity.isRoot !== 'boolean'
  ) {
    return false;
  }

  try {
    const parsed = new URL(identity.canonicalUrl);
    const isRoot =
      parsed.pathname === '/' &&
      parsed.search === '' &&
      identity.canonicalUrl === `${identity.origin}/`;

    return (
      parsed.origin === identity.origin &&
      parsed.username === '' &&
      parsed.password === '' &&
      !identity.canonicalUrl.includes('#') &&
      !(parsed.search === '' && identity.canonicalUrl.includes('?')) &&
      parsed.hash === '' &&
      parsed.href === identity.canonicalUrl &&
      parsed.pathname === identity.pathname &&
      identity.isRoot === isRoot
    );
  } catch {
    return false;
  }
}

async function identify(
  service: PageIdentityService,
  record: NoteRecordV1,
  rules: readonly PageIdentityExclusionRule[],
  phase: 'current' | 'requested',
): Promise<PageIdentity> {
  try {
    const result: unknown = await service.identify(
      record.representativeUrl,
      rules.map(cloneRule),
    );

    if (!isUnknownRecord(result)) {
      return fail(
        'mismatched-identity',
        `Identity service returned a malformed ${phase} result for ${record.pageKey}.`,
      );
    }

    if (result.status === 'unsupported') {
      const isInvalidUrl =
        hasExactKeys(result, ['status', 'reason']) &&
        result.reason === 'invalid-url';
      const isUnsupportedScheme =
        hasExactKeys(result, ['status', 'reason', 'protocol']) &&
        result.reason === 'unsupported-scheme' &&
        typeof result.protocol === 'string';

      if (!isInvalidUrl && !isUnsupportedScheme) {
        return fail(
          'mismatched-identity',
          `Identity service returned a malformed ${phase} result for ${record.pageKey}.`,
        );
      }

      return fail(
        'unsupported-identity',
        `Representative URL for ${record.pageKey} is unsupported under ${phase} settings.`,
      );
    }

    if (
      result.status !== 'supported' ||
      !hasExactKeys(result, ['status', 'identity'])
    ) {
      return fail(
        'mismatched-identity',
        `Identity service returned a malformed ${phase} result for ${record.pageKey}.`,
      );
    }

    const { identity } = result;

    if (!validateIdentityShape(identity)) {
      return fail(
        'mismatched-identity',
        `Identity service returned a malformed ${phase} identity for ${record.pageKey}.`,
      );
    }

    const expectedPageKey = await hashValue(
      identity.canonicalUrl,
      `${phase} identity canonical URL`,
    );

    if (
      identity.pageKey !== expectedPageKey ||
      identity.origin !== record.origin
    ) {
      return fail(
        'mismatched-identity',
        `Identity service returned a mismatched ${phase} identity for ${record.pageKey}.`,
      );
    }

    return {
      canonicalUrl: identity.canonicalUrl,
      isRoot: identity.isRoot,
      origin: identity.origin,
      pageKey: identity.pageKey,
      pathname: identity.pathname,
    };
  } catch (error) {
    if (error instanceof IdentityMigrationPlanError) {
      throw error;
    }

    return fail(
      'identity-failure',
      `Identity service failed for ${record.pageKey} under ${phase} settings.`,
    );
  }
}

function compareSources(left: NoteRecordV1, right: NoteRecordV1): number {
  const savedAtComparison =
    new Date(left.savedAt).valueOf() - new Date(right.savedAt).valueOf();

  if (savedAtComparison !== 0) {
    return savedAtComparison;
  }

  const revisionComparison = compareCodeUnits(
    left.revisionId,
    right.revisionId,
  );

  return revisionComparison === 0
    ? compareCodeUnits(left.pageKey, right.pageKey)
    : revisionComparison;
}

function escapeHtmlText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function mergeCollisionContent(sources: readonly NoteRecordV1[]): string {
  return normalizeGutenbergContent(
    sources
      .map(
        (source) =>
          `<!-- wp:heading -->\n<h2 class="wp-block-heading">Source: ${escapeHtmlText(source.canonicalUrl)}</h2>\n<!-- /wp:heading -->\n\n${normalizeGutenbergContent(source.contentHtml)}`,
      )
      .join('\n\n'),
  );
}

function requireIdentifier(value: unknown, label: string): string {
  if (!isIdentifier(value)) {
    return fail(
      'dependency-failure',
      `${label} must return a non-empty, trimmed identifier no longer than ${IDENTIFIER_MAX_LENGTH} characters.`,
    );
  }

  return value;
}

function getPlannedAt(clock: () => Date): string {
  let value: Date;

  try {
    value = clock();
  } catch {
    return fail('dependency-failure', 'Migration clock failed.');
  }

  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    return fail(
      'dependency-failure',
      'Migration clock returned an invalid date.',
    );
  }

  return value.toISOString();
}

function getIdentifier(factory: () => string, label: string): string {
  try {
    return requireIdentifier(factory(), label);
  } catch (error) {
    if (error instanceof IdentityMigrationPlanError) {
      throw error;
    }

    return fail('dependency-failure', `${label} failed.`);
  }
}

function assertDependencies(input: IdentityMigrationPlannerInput): void {
  if (
    typeof input !== 'object' ||
    input === null ||
    typeof input.clock !== 'function' ||
    typeof input.operationIdFactory !== 'function' ||
    typeof input.revisionIdFactory !== 'function' ||
    typeof input.pageIdentityService !== 'object' ||
    input.pageIdentityService === null ||
    typeof input.pageIdentityService.identify !== 'function'
  ) {
    fail('invalid-dependency', 'Migration planner dependencies are invalid.');
  }
}

export async function planIdentityMigration(
  input: IdentityMigrationPlannerInput,
): Promise<IdentityMigrationPlan> {
  assertDependencies(input);

  let rawBuiltIns: BuiltInPageIdentityExclusions;

  try {
    rawBuiltIns = input.pageIdentityService.builtInExclusions;
  } catch {
    return fail(
      'invalid-dependency',
      'Could not read built-in identity exclusions.',
    );
  }

  if (typeof rawBuiltIns !== 'object' || rawBuiltIns === null) {
    return fail(
      'invalid-dependency',
      'Built-in identity exclusions are invalid.',
    );
  }

  let serviceBuiltIns: BuiltInPageIdentityExclusions;

  try {
    serviceBuiltIns = normalizeBuiltIns(rawBuiltIns);
  } catch (error) {
    if (error instanceof IdentityMigrationPlanError) {
      throw error;
    }

    return fail(
      'invalid-dependency',
      'Could not normalize built-in identity exclusions.',
    );
  }
  const currentSettings = normalizeSettings(
    input.currentSettings,
    'Current settings',
    serviceBuiltIns,
  );
  const requestedSettings = normalizeSettings(
    input.requestedSettings,
    'Requested settings',
    serviceBuiltIns,
  );
  const records = await validateRecords(input.records);
  const change = deriveChange(currentSettings, requestedSettings);

  if (change === undefined) {
    return deepFreeze({
      schemaVersion: IDENTITY_MIGRATION_PLAN_SCHEMA_VERSION,
      status: 'no-op',
      reason: 'already-applied',
    });
  }

  const affected = records.filter((record) => record.origin === change.origin);
  const identified: IdentifiedRecord[] = [];

  for (const record of affected) {
    const currentIdentity = await identify(
      input.pageIdentityService,
      record,
      currentSettings.pageIdentityExclusions,
      'current',
    );
    const requestedIdentity = await identify(
      input.pageIdentityService,
      record,
      requestedSettings.pageIdentityExclusions,
      'requested',
    );
    const matchesStored = (identity: PageIdentity): boolean =>
      identity.pageKey === record.pageKey &&
      identity.canonicalUrl === record.canonicalUrl;

    if (!matchesStored(currentIdentity) && !matchesStored(requestedIdentity)) {
      return fail(
        'mismatched-identity',
        `Stored identity for ${record.pageKey} matches neither side of the requested migration.`,
      );
    }

    identified.push({
      record,
      requestedIdentity,
    });
  }

  const liveGroups = new Map<string, IdentifiedRecord[]>();

  for (const entry of identified) {
    if (entry.record.deletedAt !== undefined) {
      continue;
    }

    const group = liveGroups.get(entry.requestedIdentity.pageKey) ?? [];
    group.push(entry);
    liveGroups.set(entry.requestedIdentity.pageKey, group);
  }

  const destinationSpecs: DestinationSpec[] = [];
  const tombstoneSpecs: TombstoneSpec[] = [];
  const sortedDestinationKeys = [...liveGroups.keys()].sort(compareCodeUnits);

  for (const destinationKey of sortedDestinationKeys) {
    const group = liveGroups.get(destinationKey);

    if (group === undefined) {
      continue;
    }

    group.sort((left, right) => compareSources(left.record, right.record));
    const first = group[0];

    if (first === undefined) {
      continue;
    }

    const sources = group.map((entry) => entry.record);
    const titleSource = first.record;
    const representative =
      group.find((entry) => entry.record.pageKey !== destinationKey)?.record ??
      titleSource;
    const identity = first.requestedIdentity;

    if (
      group.some(
        (entry) =>
          entry.requestedIdentity.canonicalUrl !== identity.canonicalUrl ||
          entry.requestedIdentity.origin !== identity.origin,
      )
    ) {
      return fail(
        'mismatched-identity',
        `Identity service returned conflicting destinations for ${destinationKey}.`,
      );
    }

    const changesRecord =
      sources.length > 1 || titleSource.pageKey !== destinationKey;

    if (!changesRecord) {
      continue;
    }

    // The oldest source supplies the stable title, while a stable moving source
    // supplies the representative URL. The latter retains the newly excluded
    // parameter so a later removal can move the combined document without
    // pretending its Gutenberg content can be safely split.
    destinationSpecs.push({
      contentHtml:
        sources.length === 1
          ? normalizeGutenbergContent(representative.contentHtml)
          : mergeCollisionContent(sources),
      identity,
      representativeUrl: representative.representativeUrl,
      title: titleSource.title,
    });

    for (const source of sources) {
      if (source.pageKey !== destinationKey) {
        tombstoneSpecs.push({ source });
      }
    }
  }

  tombstoneSpecs.sort((left, right) =>
    compareCodeUnits(left.source.pageKey, right.source.pageKey),
  );

  const expectedSources: IdentityMigrationExpectedSource[] = [];

  for (const record of affected) {
    expectedSources.push({
      fingerprint: await fingerprintIdentityMigrationNote(record),
      record: cloneNote(record),
    });
  }

  const currentFingerprint =
    await fingerprintIdentityMigrationSettings(currentSettings);
  const plannedAt = getPlannedAt(input.clock);
  const operationId = getIdentifier(
    input.operationIdFactory,
    'Operation ID factory',
  );
  const recordsByKey = new Map(
    records.map((record) => [record.pageKey, record] as const),
  );
  const destinations: IdentityMigrationDestinationWrite[] = [];
  const sourceTombstones: IdentityMigrationTombstoneWrite[] = [];
  const generatedRevisionIds = new Set<string>();

  const nextRevisionId = (): string => {
    const revisionId = getIdentifier(
      input.revisionIdFactory,
      'Revision ID factory',
    );

    if (generatedRevisionIds.has(revisionId)) {
      return fail(
        'dependency-failure',
        'Revision ID factory returned a duplicate identifier.',
      );
    }

    generatedRevisionIds.add(revisionId);
    return revisionId;
  };

  for (const spec of destinationSpecs) {
    const existing = recordsByKey.get(spec.identity.pageKey);
    const candidate: NoteRecordV1 = {
      schemaVersion: NOTE_SCHEMA_VERSION,
      pageKey: spec.identity.pageKey,
      canonicalUrl: spec.identity.canonicalUrl,
      representativeUrl: spec.representativeUrl,
      origin: spec.identity.origin,
      title: spec.title,
      contentHtml: spec.contentHtml,
      contentHash: await hashValue(
        spec.contentHtml,
        `destination ${spec.identity.pageKey} content`,
      ),
      savedAt: plannedAt,
      revisionId: nextRevisionId(),
    };
    const record = await validateNoteRecord(
      candidate,
      `Emitted destination ${spec.identity.pageKey}`,
    );

    destinations.push({
      expectedRecordFingerprint:
        existing === undefined
          ? null
          : await fingerprintIdentityMigrationNote(existing),
      record,
    });
  }

  for (const { source } of tombstoneSpecs) {
    const candidate: NoteRecordV1 = {
      schemaVersion: NOTE_SCHEMA_VERSION,
      pageKey: source.pageKey,
      canonicalUrl: source.canonicalUrl,
      representativeUrl: source.representativeUrl,
      origin: source.origin,
      title: source.title,
      contentHtml: '',
      contentHash: await hashValue('', `tombstone ${source.pageKey} content`),
      savedAt: plannedAt,
      revisionId: nextRevisionId(),
      deletedAt: plannedAt,
    };
    const record = await validateNoteRecord(
      candidate,
      `Emitted tombstone ${source.pageKey}`,
    );

    sourceTombstones.push({
      expectedRecordFingerprint: await fingerprintIdentityMigrationNote(source),
      record,
    });
  }

  return parseIdentityMigrationPlan({
    schemaVersion: IDENTITY_MIGRATION_PLAN_SCHEMA_VERSION,
    status: 'planned',
    operationId,
    phase: 'planned',
    plannedAt,
    change,
    expected: {
      settings: {
        fingerprint: currentFingerprint,
        record: cloneSettings(currentSettings),
      },
      sources: expectedSources,
    },
    destinations,
    sourceTombstones,
    requestedSettings: cloneSettings(requestedSettings),
  });
}

function invalidPlan(message: string): never {
  return fail('invalid-plan', message);
}

function containsAsciiControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);

    if (codeUnit <= 0x1f || codeUnit === 0x7f) {
      return true;
    }
  }

  return false;
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= IDENTIFIER_MAX_LENGTH &&
    value.trim() === value &&
    !containsAsciiControlCharacter(value)
  );
}

function assertStrictlySortedUnique(
  keys: readonly string[],
  label: string,
): void {
  for (let index = 1; index < keys.length; index += 1) {
    const previous = keys[index - 1];
    const current = keys[index];

    if (
      previous === undefined ||
      current === undefined ||
      compareCodeUnits(previous, current) >= 0
    ) {
      invalidPlan(`${label} must be strictly sorted with unique keys.`);
    }
  }
}

function parseCanonicalSettings(
  value: unknown,
  label: string,
): SettingsRecordV1 {
  if (!isSettingsRecordV1(value)) {
    return invalidPlan(`${label} is not a strict v1 settings record.`);
  }

  const normalized = normalizeSettings(
    value,
    label,
    normalizeBuiltIns(BUILT_IN_PAGE_IDENTITY_EXCLUSIONS),
  );

  if (
    settingsFingerprintInput(value) !== settingsFingerprintInput(normalized)
  ) {
    return invalidPlan(`${label} is not canonically normalized.`);
  }

  return normalized;
}

async function parsePlanNote(
  value: unknown,
  label: string,
): Promise<NoteRecordV1> {
  try {
    return await validateNoteRecord(value, label);
  } catch (error) {
    if (
      error instanceof IdentityMigrationPlanError &&
      error.code === 'hash-failure'
    ) {
      throw error;
    }

    return invalidPlan(`${label} is not a valid migration note.`);
  }
}

function parseChange(value: unknown): IdentityMigrationChange {
  if (
    !isUnknownRecord(value) ||
    !hasExactKeys(value, ['kind', 'origin', 'parameterName']) ||
    (value.kind !== 'add-parameter-exclusion' &&
      value.kind !== 'remove-parameter-exclusion') ||
    !isExactHttpOrigin(value.origin)
  ) {
    return invalidPlan('Persisted migration change is malformed.');
  }

  const normalizedParameterName = normalizeParameterName(
    value.parameterName,
    'Persisted migration parameter name',
    normalizeBuiltIns(BUILT_IN_PAGE_IDENTITY_EXCLUSIONS),
  );

  if (normalizedParameterName !== value.parameterName) {
    return invalidPlan('Persisted migration parameter name is not normalized.');
  }

  return {
    kind: value.kind,
    origin: value.origin,
    parameterName: normalizedParameterName,
  };
}

async function parseExpectedSources(
  value: unknown,
  change: IdentityMigrationChange,
): Promise<readonly IdentityMigrationExpectedSource[]> {
  if (!Array.isArray(value)) {
    return invalidPlan('Persisted expected sources must be an array.');
  }

  const sources: IdentityMigrationExpectedSource[] = [];

  for (const [index, candidate] of value.entries()) {
    if (
      !isUnknownRecord(candidate) ||
      !hasExactKeys(candidate, ['fingerprint', 'record']) ||
      !isSha256Base64Url(candidate.fingerprint)
    ) {
      return invalidPlan(`Persisted expected source ${index} is malformed.`);
    }

    const record = await parsePlanNote(
      candidate.record,
      `Persisted expected source ${index}`,
    );
    const fingerprint = await fingerprintIdentityMigrationNote(record);

    if (
      candidate.fingerprint !== fingerprint ||
      record.origin !== change.origin
    ) {
      return invalidPlan(
        `Persisted expected source ${index} has inconsistent metadata.`,
      );
    }

    sources.push({
      fingerprint,
      record,
    });
  }

  assertStrictlySortedUnique(
    sources.map(({ record }) => record.pageKey),
    'Persisted expected sources',
  );
  return sources;
}

async function parseDestinationWrites(
  value: unknown,
  change: IdentityMigrationChange,
  plannedAt: string,
  expectedByKey: ReadonlyMap<string, IdentityMigrationExpectedSource>,
): Promise<readonly IdentityMigrationDestinationWrite[]> {
  if (!Array.isArray(value)) {
    return invalidPlan('Persisted destinations must be an array.');
  }

  const destinations: IdentityMigrationDestinationWrite[] = [];

  for (const [index, candidate] of value.entries()) {
    if (
      !isUnknownRecord(candidate) ||
      !hasExactKeys(candidate, ['expectedRecordFingerprint', 'record']) ||
      (candidate.expectedRecordFingerprint !== null &&
        !isSha256Base64Url(candidate.expectedRecordFingerprint))
    ) {
      return invalidPlan(`Persisted destination ${index} is malformed.`);
    }

    const record = await parsePlanNote(
      candidate.record,
      `Persisted destination ${index}`,
    );
    const expected = expectedByKey.get(record.pageKey);
    const expectedRecordFingerprint = candidate.expectedRecordFingerprint;

    if (
      record.origin !== change.origin ||
      record.deletedAt !== undefined ||
      record.savedAt !== plannedAt ||
      normalizeGutenbergContent(record.contentHtml) !== record.contentHtml ||
      expectedRecordFingerprint !== (expected?.fingerprint ?? null)
    ) {
      return invalidPlan(
        `Persisted destination ${index} has inconsistent metadata.`,
      );
    }

    destinations.push({
      expectedRecordFingerprint,
      record,
    });
  }

  assertStrictlySortedUnique(
    destinations.map(({ record }) => record.pageKey),
    'Persisted destinations',
  );
  return destinations;
}

async function parseTombstoneWrites(
  value: unknown,
  change: IdentityMigrationChange,
  plannedAt: string,
  expectedByKey: ReadonlyMap<string, IdentityMigrationExpectedSource>,
): Promise<readonly IdentityMigrationTombstoneWrite[]> {
  if (!Array.isArray(value)) {
    return invalidPlan('Persisted source tombstones must be an array.');
  }

  const emptyContentHash = await hashValue(
    '',
    'persisted tombstone empty content',
  );
  const tombstones: IdentityMigrationTombstoneWrite[] = [];

  for (const [index, candidate] of value.entries()) {
    if (
      !isUnknownRecord(candidate) ||
      !hasExactKeys(candidate, ['expectedRecordFingerprint', 'record']) ||
      !isSha256Base64Url(candidate.expectedRecordFingerprint)
    ) {
      return invalidPlan(`Persisted tombstone ${index} is malformed.`);
    }

    const record = await parsePlanNote(
      candidate.record,
      `Persisted tombstone ${index}`,
    );
    const expected = expectedByKey.get(record.pageKey);
    const expectedRecordFingerprint = candidate.expectedRecordFingerprint;

    if (
      expected === undefined ||
      expected.record.deletedAt !== undefined ||
      expectedRecordFingerprint !== expected.fingerprint ||
      record.origin !== change.origin ||
      record.deletedAt !== plannedAt ||
      record.savedAt !== plannedAt ||
      record.contentHtml !== '' ||
      record.contentHash !== emptyContentHash ||
      record.schemaVersion !== expected.record.schemaVersion ||
      record.pageKey !== expected.record.pageKey ||
      record.canonicalUrl !== expected.record.canonicalUrl ||
      record.representativeUrl !== expected.record.representativeUrl ||
      record.title !== expected.record.title
    ) {
      return invalidPlan(
        `Persisted tombstone ${index} has inconsistent metadata.`,
      );
    }

    tombstones.push({
      expectedRecordFingerprint,
      record,
    });
  }

  assertStrictlySortedUnique(
    tombstones.map(({ record }) => record.pageKey),
    'Persisted source tombstones',
  );
  return tombstones;
}

async function parseIdentityMigrationPlanUnsafe(
  value: unknown,
): Promise<IdentityMigrationPlan> {
  if (!isUnknownRecord(value)) {
    return invalidPlan('Persisted identity migration must be an object.');
  }

  if (value.schemaVersion !== IDENTITY_MIGRATION_PLAN_SCHEMA_VERSION) {
    return invalidPlan(
      'Persisted identity migration has an unsupported schema version.',
    );
  }

  if (value.status === 'no-op') {
    if (
      !hasExactKeys(value, ['schemaVersion', 'status', 'reason']) ||
      value.reason !== 'already-applied'
    ) {
      return invalidPlan('Persisted identity migration no-op is malformed.');
    }

    return deepFreeze({
      schemaVersion: IDENTITY_MIGRATION_PLAN_SCHEMA_VERSION,
      status: 'no-op',
      reason: 'already-applied',
    });
  }

  if (
    value.status !== 'planned' ||
    !hasExactKeys(value, [
      'schemaVersion',
      'status',
      'operationId',
      'phase',
      'plannedAt',
      'change',
      'expected',
      'destinations',
      'sourceTombstones',
      'requestedSettings',
    ]) ||
    value.phase !== 'planned' ||
    !isIdentifier(value.operationId) ||
    !isUtcIsoTimestamp(value.plannedAt)
  ) {
    return invalidPlan('Persisted planned identity migration is malformed.');
  }

  const operationId = value.operationId;
  const plannedAt = value.plannedAt;
  const change = parseChange(value.change);
  const requestedSettings = parseCanonicalSettings(
    value.requestedSettings,
    'Persisted requested settings',
  );

  if (
    !isUnknownRecord(value.expected) ||
    !hasExactKeys(value.expected, ['settings', 'sources']) ||
    !isUnknownRecord(value.expected.settings) ||
    !hasExactKeys(value.expected.settings, ['fingerprint', 'record']) ||
    !isSha256Base64Url(value.expected.settings.fingerprint)
  ) {
    return invalidPlan('Persisted expected migration state is malformed.');
  }

  const expectedSettings = parseCanonicalSettings(
    value.expected.settings.record,
    'Persisted expected settings',
  );
  const expectedSettingsFingerprint =
    await fingerprintIdentityMigrationSettings(expectedSettings);

  if (value.expected.settings.fingerprint !== expectedSettingsFingerprint) {
    return invalidPlan(
      'Persisted expected settings fingerprint is inconsistent.',
    );
  }

  const derivedChange = deriveChange(expectedSettings, requestedSettings);

  if (
    derivedChange === undefined ||
    derivedChange.kind !== change.kind ||
    derivedChange.origin !== change.origin ||
    derivedChange.parameterName !== change.parameterName
  ) {
    return invalidPlan(
      'Persisted migration change does not match its settings transition.',
    );
  }

  const sources = await parseExpectedSources(value.expected.sources, change);
  const expectedByKey = new Map(
    sources.map((source) => [source.record.pageKey, source] as const),
  );
  const destinations = await parseDestinationWrites(
    value.destinations,
    change,
    plannedAt,
    expectedByKey,
  );
  const sourceTombstones = await parseTombstoneWrites(
    value.sourceTombstones,
    change,
    plannedAt,
    expectedByKey,
  );
  const destinationKeys = new Set(
    destinations.map(({ record }) => record.pageKey),
  );
  const revisionIds = new Set<string>();

  for (const { record } of [...destinations, ...sourceTombstones]) {
    if (
      !isIdentifier(record.revisionId) ||
      revisionIds.has(record.revisionId) ||
      (record.deletedAt !== undefined && destinationKeys.has(record.pageKey))
    ) {
      return invalidPlan(
        'Persisted migration writes contain duplicate keys or revisions.',
      );
    }

    revisionIds.add(record.revisionId);
  }

  return deepFreeze({
    schemaVersion: IDENTITY_MIGRATION_PLAN_SCHEMA_VERSION,
    status: 'planned',
    operationId,
    phase: 'planned',
    plannedAt,
    change,
    expected: {
      settings: {
        fingerprint: expectedSettingsFingerprint,
        record: expectedSettings,
      },
      sources,
    },
    destinations,
    sourceTombstones,
    requestedSettings,
  });
}

export async function parseIdentityMigrationPlan(
  value: unknown,
): Promise<IdentityMigrationPlan> {
  try {
    return await parseIdentityMigrationPlanUnsafe(value);
  } catch (error) {
    if (
      error instanceof IdentityMigrationPlanError &&
      error.code === 'hash-failure'
    ) {
      throw error;
    }

    if (
      error instanceof IdentityMigrationPlanError &&
      error.code === 'invalid-plan'
    ) {
      throw error;
    }

    return invalidPlan('Persisted identity migration failed validation.');
  }
}
