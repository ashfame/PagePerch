import type {
  ByosConnectionV1,
  EditorMode,
  SettingsRecordV1,
} from '../domain/settings';

export type SettingsConnectionCasResult = 'applied' | 'mismatch';

export interface SettingsRepository {
  get(): Promise<SettingsRecordV1>;
  put(settings: SettingsRecordV1): Promise<void>;
  updateByosConnection(
    connection: ByosConnectionV1 | undefined,
  ): Promise<SettingsRecordV1>;
  updateLastSuccessfulSyncAtIfCurrent(
    expectedConnection: ByosConnectionV1,
    lastSuccessfulSyncAt: string,
  ): Promise<SettingsConnectionCasResult>;
  updateEditorMode(editorMode: EditorMode): Promise<SettingsRecordV1>;
  updateShowRecentNotesOnOrigin(
    showRecentNotesOnOrigin: boolean,
  ): Promise<SettingsRecordV1>;
}
