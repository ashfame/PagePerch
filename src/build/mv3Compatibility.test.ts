import { describe, expect, it } from 'vitest';

import { replaceLodashGlobalFallback } from './mv3Compatibility';

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
