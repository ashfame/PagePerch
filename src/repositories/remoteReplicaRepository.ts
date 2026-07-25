import type { NoteRecordV1 } from '../domain/note';

export interface RemoteReplicaRepository {
  get(pageKey: string): Promise<NoteRecordV1 | undefined>;
  put(record: NoteRecordV1): Promise<void>;
  listAll(): Promise<readonly NoteRecordV1[]>;
}
