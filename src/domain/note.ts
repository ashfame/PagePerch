import type { PageIdentity } from './pageIdentity';

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

export interface NotePageInput {
  readonly identity: PageIdentity;
  readonly representativeUrl: string;
  readonly activeTabTitle: string;
}

export interface SavePageDraftInput extends NotePageInput {
  readonly contentHtml: string;
}

export interface NoteMutationSavedResult {
  readonly status: 'saved';
  readonly change: 'created' | 'updated' | 'deleted' | 'resurrected';
  readonly record: NoteRecordV1;
}

export interface NoteMutationUnchangedResult {
  readonly status: 'unchanged';
  readonly reason: 'no-record' | 'unchanged' | 'already-deleted';
  readonly record?: NoteRecordV1;
}

export type NoteMutationResult =
  NoteMutationSavedResult | NoteMutationUnchangedResult;

export interface NoteService {
  loadLive(pageKey: string): Promise<NoteRecordV1 | undefined>;
  saveDraft(input: SavePageDraftInput): Promise<NoteMutationResult>;
  clearPage(input: NotePageInput): Promise<NoteMutationResult>;
  listRecentByOrigin(origin: string): Promise<readonly NoteRecordV1[]>;
}
