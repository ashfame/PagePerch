import { describe, expect, it } from 'vitest';

import {
  PAGEPERCH_GUTENBERG_PACKAGE_ALIASES,
  assertIsolatedEditorRegistryImports,
} from './gutenbergCompatibility';

const isolatedEditorEntry =
  '/project/node_modules/@automattic/isolated-block-editor/build-module/index.js';
const pinnedRegistryImports = `
import { registerCoreBlocks } from '@wordpress/block-library';
import '@wordpress/format-library';
`;

function matchingAliases(source: string): string[] {
  return PAGEPERCH_GUTENBERG_PACKAGE_ALIASES.filter(({ find }) =>
    find.test(source),
  ).map(({ replacement }) => replacement);
}

describe('PagePerch Gutenberg package aliases', () => {
  it('matches only the two exact registry package imports', () => {
    expect(matchingAliases('@wordpress/block-library')).toHaveLength(1);
    expect(matchingAliases('@wordpress/format-library')).toHaveLength(1);

    for (const source of [
      '@wordpress/block-library/build-module/paragraph/index.js',
      '@wordpress/format-library/build-module/bold/index.js',
      '@wordpress/block-library-extra',
      '@wordpress/format-library/unknown',
    ]) {
      expect(matchingAliases(source)).toEqual([]);
    }
  });

  it('accepts the pinned isolated-editor registry imports', () => {
    expect(() =>
      assertIsolatedEditorRegistryImports(
        pinnedRegistryImports,
        isolatedEditorEntry,
      ),
    ).not.toThrow();
  });

  it.each([
    {
      name: 'missing block-library import',
      source: pinnedRegistryImports.replace(
        "import { registerCoreBlocks } from '@wordpress/block-library';",
        '',
      ),
    },
    {
      name: 'renamed format-library import',
      source: pinnedRegistryImports.replace(
        "import '@wordpress/format-library';",
        "import '@wordpress/format-library/build-module/index.js';",
      ),
    },
    {
      name: 'duplicate block-library import',
      source: `${pinnedRegistryImports}
import { registerCoreBlocks } from '@wordpress/block-library';
`,
    },
  ])('fails closed on upstream registry drift: $name', ({ source }) => {
    expect(() =>
      assertIsolatedEditorRegistryImports(source, isolatedEditorEntry),
    ).toThrow(/expected exactly one pinned isolated-editor registry import/u);
  });

  it('does not apply the pinned-source assertion to unrelated modules', () => {
    expect(() =>
      assertIsolatedEditorRegistryImports(
        'export const unrelated = true;',
        '/project/src/index.ts',
      ),
    ).not.toThrow();
  });
});
