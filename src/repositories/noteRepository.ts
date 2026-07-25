import type { NoteRecordV1 } from '../domain/note';

export type NoteRepositoryConditionalPutResult = 'applied' | 'mismatch';

export interface NoteRepository {
  get(pageKey: string): Promise<NoteRecordV1 | undefined>;
  put(record: NoteRecordV1): Promise<void>;
  /**
   * Atomically replaces an absent record or one exact expected record.
   * This protects local saves from a stale remote-winner reconciliation.
   */
  putIfCurrent(
    expected: NoteRecordV1 | undefined,
    record: NoteRecordV1,
  ): Promise<NoteRepositoryConditionalPutResult>;
  /** Physically removes local infrastructure data. User clears use tombstones. */
  delete(pageKey: string): Promise<void>;
  /** Returns current records including tombstones required by synchronization. */
  listByOrigin(origin: string): Promise<readonly NoteRecordV1[]>;
  /** Returns current records including tombstones required by migrations. */
  listAll(): Promise<readonly NoteRecordV1[]>;
}
