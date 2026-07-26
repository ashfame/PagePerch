import { describe, expect, it } from 'vitest';

import {
  replaceIsolatedEditorDeprecatedApis,
  replaceLodashGlobalFallback,
  replaceMv3IncompatibleCode,
} from './mv3Compatibility';

const isolatedVisualEditorPath =
  '/project/node_modules/@automattic/isolated-block-editor/build-module/components/block-editor/visual-editor.js';
const pinnedVisualEditorSource = `
import { BlockList, useSetting, __experimentalRecursionProvider as RecursionProvider, privateApis as blockEditorPrivateApis } from '@wordpress/block-editor';
const globalLayoutSettings = useSetting('layout');
`;

describe('replaceLodashGlobalFallback', () => {
  it('replaces the Lodash Function constructor fallback with the MV3 global', () => {
    const source =
      "var root = freeGlobal || freeSelf || Function('return this')();";

    expect(
      replaceLodashGlobalFallback(
        source,
        '/project/node_modules/lodash/_root.js',
      ),
    ).toBe('var root = freeGlobal || freeSelf || globalThis;');
  });

  it('does not rewrite unrelated modules', () => {
    expect(
      replaceLodashGlobalFallback(
        "Function('return this')();",
        '/project/src/application.ts',
      ),
    ).toBeUndefined();
  });

  it('replaces the same fallback in the bundled lodash.merge entry', () => {
    expect(
      replaceLodashGlobalFallback(
        'var root = freeGlobal || freeSelf || Function("return this")();',
        '/project/node_modules/lodash.merge/index.js',
      ),
    ).toBe('var root = freeGlobal || freeSelf || globalThis;');
  });
});

describe('replaceIsolatedEditorDeprecatedApis', () => {
  it('rewrites the two exact deprecated APIs in the pinned visual editor', () => {
    expect(
      replaceIsolatedEditorDeprecatedApis(
        pinnedVisualEditorSource,
        isolatedVisualEditorPath,
      ),
    ).toBe(`
import { BlockList, useSettings, RecursionProvider, privateApis as blockEditorPrivateApis } from '@wordpress/block-editor';
const [globalLayoutSettings] = useSettings('layout');
`);
  });

  it('does not rewrite the same source outside the exact visual-editor path', () => {
    expect(
      replaceIsolatedEditorDeprecatedApis(
        pinnedVisualEditorSource,
        '/project/src/visual-editor.js',
      ),
    ).toBeUndefined();
  });

  it.each([
    {
      name: 'missing deprecated import',
      source: pinnedVisualEditorSource.replace(
        ', useSetting, __experimentalRecursionProvider as RecursionProvider,',
        ', useSettings, RecursionProvider,',
      ),
    },
    {
      name: 'missing deprecated layout call',
      source: pinnedVisualEditorSource.replace(
        "const globalLayoutSettings = useSetting('layout');",
        "const [globalLayoutSettings] = useSettings('layout');",
      ),
    },
    {
      name: 'duplicate deprecated layout call',
      source: `${pinnedVisualEditorSource}\nconst globalLayoutSettings = useSetting('layout');`,
    },
  ])('fails closed on upstream drift: $name', ({ source }) => {
    expect(() =>
      replaceIsolatedEditorDeprecatedApis(source, isolatedVisualEditorPath),
    ).toThrow(
      /expected exactly one pinned isolated-editor compatibility pattern/u,
    );
  });

  it('preserves the Lodash compatibility transform composition', () => {
    expect(
      replaceMv3IncompatibleCode(
        "var root = Function('return this')();",
        '/project/node_modules/lodash/_root.js',
      ),
    ).toBe('var root = globalThis;');
  });
});
