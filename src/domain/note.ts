export const NOTE_SCHEMA_VERSION = 1 as const;

export interface NoteRecordV1 {
  readonly schemaVersion: typeof NOTE_SCHEMA_VERSION;
  readonly pageKey: string;
  readonly canonicalUrl: string;
  readonly representativeUrl: string;
  readonly origin: string;
  readonly title: string;
  readonly contentHtml: string;
  readonly contentHash: string;
  readonly savedAt: string;
  readonly revisionId: string;
  readonly deletedAt?: string;
}
