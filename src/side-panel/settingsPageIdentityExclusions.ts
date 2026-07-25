import type { PageIdentityExclusionRule } from '../domain/pageIdentity';
import type { SettingsRepository } from '../repositories/settingsRepository';
import type { ActivePageSettings } from './activePageSession';

type SettingsReader = Pick<SettingsRepository, 'get'>;

export class SettingsPageIdentityExclusions implements ActivePageSettings {
  readonly #settings: SettingsReader;

  constructor(settings: SettingsReader) {
    this.#settings = settings;
  }

  async getPageIdentityExclusions(): Promise<
    readonly PageIdentityExclusionRule[]
  > {
    const settings = await this.#settings.get();

    return settings.pageIdentityExclusions.map((rule) => ({
      origin: rule.origin,
      parameterNames: [...rule.parameterNames],
    }));
  }
}
