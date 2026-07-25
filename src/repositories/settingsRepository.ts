import type {
  ByosConnectionV1,
  EditorMode,
  SettingsRecordV1,
} from '../domain/settings';

export interface SettingsRepository {
  get(): Promise<SettingsRecordV1>;
  put(settings: SettingsRecordV1): Promise<void>;
  updateByosConnection(
    connection: ByosConnectionV1 | undefined,
  ): Promise<SettingsRecordV1>;
  updateEditorMode(editorMode: EditorMode): Promise<SettingsRecordV1>;
}
