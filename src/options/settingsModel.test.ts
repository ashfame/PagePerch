import { describe, expect, it } from 'vitest';

import type { SettingsRecordV1 } from '../domain/settings';
import {
  addPageIdentityExclusion,
  OptionsSettingsValidationError,
  removePageIdentityExclusion,
  sortedPageIdentityExclusions,
} from './settingsModel';

const builtIns = {
  exactParameterNames: ['gclid', 'FBCLID'],
  parameterNamePrefixes: ['UTM_'],
} as const;

function settings(overrides: Partial<SettingsRecordV1> = {}): SettingsRecordV1 {
  return {
    schemaVersion: 1,
    editorMode: 'text-focused-blocks',
    pageIdentityExclusions: [],
    ...overrides,
  };
}

describe('options page identity settings model', () => {
  it.each([
    'ftp://example.com',
    'https://user@example.com',
    'https://example.com/',
    'https://example.com/path',
    'https://example.com?query=1',
    'https://example.com#fragment',
    'https://EXAMPLE.com',
  ])('rejects noncanonical exact origin %s', (origin) => {
    expect(() =>
      addPageIdentityExclusion(settings(), origin, 'session', builtIns),
    ).toThrowError(
      expect.objectContaining({
        name: 'OptionsSettingsValidationError',
        code: 'invalid-origin',
      }),
    );
  });

  it('normalizes names to lowercase, adds a second name to one origin rule, and preserves settings metadata', () => {
    const byosConnection = {
      accessToken: 'preserved-token',
      connectedAt: '2026-07-25T10:00:00Z',
      expiresAt: '2026-08-01T10:00:00Z',
    };
    const current = settings({
      editorMode: 'paragraphs-only',
      pageIdentityExclusions: [
        { origin: 'https://example.com', parameterNames: ['zeta'] },
      ],
      byosConnection,
    });
    const requested = addPageIdentityExclusion(
      current,
      ' https://example.com ',
      ' Session ',
      builtIns,
    );

    expect(requested).toEqual({
      ...current,
      pageIdentityExclusions: [
        {
          origin: 'https://example.com',
          parameterNames: ['session', 'zeta'],
        },
      ],
    });
    expect(requested.editorMode).toBe('paragraphs-only');
    expect(requested.byosConnection).toBe(byosConnection);
  });

  it.each(['GCLID', 'fbclid', 'UtM_Campaign'])(
    'rejects built-in exact or prefix match %s case-insensitively',
    (parameterName) => {
      expect(() =>
        addPageIdentityExclusion(
          settings(),
          'https://example.com',
          parameterName,
          builtIns,
        ),
      ).toThrowError(
        expect.objectContaining({
          name: 'OptionsSettingsValidationError',
          code: 'built-in-parameter',
        }),
      );
    },
  );

  it('rejects empty and duplicate origin-parameter pairs after normalization', () => {
    expect(() =>
      addPageIdentityExclusion(
        settings(),
        'https://example.com',
        '   ',
        builtIns,
      ),
    ).toThrowError(expect.objectContaining({ code: 'invalid-parameter' }));

    expect(() =>
      addPageIdentityExclusion(
        settings({
          pageIdentityExclusions: [
            { origin: 'https://example.com', parameterNames: ['session'] },
          ],
        }),
        'https://example.com',
        'SESSION',
        builtIns,
      ),
    ).toThrowError(expect.objectContaining({ code: 'duplicate-parameter' }));
  });

  it('merges repeated origins and sorts origins and parameter names deterministically', () => {
    expect(
      sortedPageIdentityExclusions([
        { origin: 'https://z.example', parameterNames: ['Beta', 'alpha'] },
        { origin: 'https://a.example', parameterNames: ['two'] },
        { origin: 'https://z.example', parameterNames: ['alpha', 'gamma'] },
      ]),
    ).toEqual([
      { origin: 'https://a.example', parameterNames: ['two'] },
      {
        origin: 'https://z.example',
        parameterNames: ['alpha', 'beta', 'gamma'],
      },
    ]);
  });

  it('removes one parameter at a time and drops an empty origin rule', () => {
    const current = settings({
      pageIdentityExclusions: [
        {
          origin: 'https://example.com',
          parameterNames: ['campaign', 'session'],
        },
        { origin: 'https://other.example', parameterNames: ['variant'] },
      ],
    });
    const oneRemoved = removePageIdentityExclusion(
      current,
      'https://example.com',
      'CAMPAIGN',
    );

    expect(oneRemoved.pageIdentityExclusions).toEqual([
      { origin: 'https://example.com', parameterNames: ['session'] },
      { origin: 'https://other.example', parameterNames: ['variant'] },
    ]);
    expect(
      removePageIdentityExclusion(oneRemoved, 'https://example.com', 'session')
        .pageIdentityExclusions,
    ).toEqual([
      { origin: 'https://other.example', parameterNames: ['variant'] },
    ]);
  });

  it('reports a stale removal with a stable typed validation error', () => {
    expect(() =>
      removePageIdentityExclusion(settings(), 'https://example.com', 'session'),
    ).toThrowError(OptionsSettingsValidationError);
  });
});
