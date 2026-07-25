import type { SettingsRecordV1 } from '../domain/settings';

export interface SettingsRepository {
  get(): Promise<SettingsRecordV1>;
  put(settings: SettingsRecordV1): Promise<void>;
}
