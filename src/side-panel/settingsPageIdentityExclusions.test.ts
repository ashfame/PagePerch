import { describe, expect, it, vi } from 'vitest';

import type { SettingsRecordV1 } from '../domain/settings';
import { SettingsPageIdentityExclusions } from './settingsPageIdentityExclusions';

function settings(): SettingsRecordV1 {
  return {
    schemaVersion: 1,
    editorMode: 'text-focused-blocks',
    showRecentNotesOnOrigin: false,
    pageIdentityExclusions: [
      {
        origin: 'https://example.com',
        parameterNames: ['session', 'campaign'],
      },
    ],
  };
}

describe('SettingsPageIdentityExclusions', () => {
  it('returns fresh deep defensive exclusion snapshots', async () => {
    const source = settings();
    const repository = {
      get: vi.fn(() => Promise.resolve(source)),
    };
    const adapter = new SettingsPageIdentityExclusions(repository);
    const first = await adapter.getPageIdentityExclusions();

    expect(first).toEqual(source.pageIdentityExclusions);
    expect(first).not.toBe(source.pageIdentityExclusions);
    expect(first[0]).not.toBe(source.pageIdentityExclusions[0]);
    expect(first[0]?.parameterNames).not.toBe(
      source.pageIdentityExclusions[0]?.parameterNames,
    );

    (first[0]?.parameterNames as string[] | undefined)?.push('mutated');
    expect(source.pageIdentityExclusions[0]?.parameterNames).toEqual([
      'session',
      'campaign',
    ]);
    await expect(adapter.getPageIdentityExclusions()).resolves.toEqual(
      source.pageIdentityExclusions,
    );
    expect(repository.get).toHaveBeenCalledTimes(2);
  });

  it('propagates repository failures', async () => {
    const failure = new Error('settings read failed');
    const adapter = new SettingsPageIdentityExclusions({
      get: vi.fn(() => Promise.reject(failure)),
    });

    await expect(adapter.getPageIdentityExclusions()).rejects.toBe(failure);
  });
});
