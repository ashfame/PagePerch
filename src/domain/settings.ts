import type { PageIdentityExclusionRule } from './pageIdentity';

export const SETTINGS_SCHEMA_VERSION = 1 as const;
export const SETTINGS_LEGACY_SCHEMA_VERSION = 0 as const;

export type EditorMode = 'text-focused-blocks' | 'paragraphs-only';

export interface ByosConnectionV1 {
  readonly accessToken: string;
  /** The OAuth expiry after applying the early-refresh safety window. */
  readonly expiresAt: string;
  readonly connectedAt: string;
  readonly lastSuccessfulSyncAt?: string;
}

export interface SettingsRecordV1 {
  readonly schemaVersion: typeof SETTINGS_SCHEMA_VERSION;
  readonly editorMode: EditorMode;
  readonly pageIdentityExclusions: readonly PageIdentityExclusionRule[];
  readonly byosConnection?: ByosConnectionV1;
}

/**
 * The only legacy settings shape supported by the v1 migration. Unknown legacy
 * shapes are preserved for explicit recovery instead of being guessed at.
 */
export interface SettingsRecordV0 {
  readonly schemaVersion: typeof SETTINGS_LEGACY_SCHEMA_VERSION;
  readonly editorMode: EditorMode;
}

export const DEFAULT_SETTINGS_V1: SettingsRecordV1 = Object.freeze({
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  editorMode: 'text-focused-blocks',
  pageIdentityExclusions: Object.freeze([]),
});
