import type { NoteRecordV1 } from '../domain/note';

export interface NoteRepository {
  get(pageKey: string): Promise<NoteRecordV1 | undefined>;
  put(record: NoteRecordV1): Promise<void>;
  /** Physically removes local infrastructure data. User clears use tombstones. */
  delete(pageKey: string): Promise<void>;
  /** Returns current records including tombstones required by synchronization. */
  listByOrigin(origin: string): Promise<readonly NoteRecordV1[]>;
  /** Returns current records including tombstones required by migrations. */
  listAll(): Promise<readonly NoteRecordV1[]>;
}
