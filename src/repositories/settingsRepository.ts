import type { EditorMode, SettingsRecordV1 } from '../domain/settings';

export interface SettingsRepository {
  get(): Promise<SettingsRecordV1>;
  put(settings: SettingsRecordV1): Promise<void>;
  updateEditorMode(editorMode: EditorMode): Promise<SettingsRecordV1>;
}
