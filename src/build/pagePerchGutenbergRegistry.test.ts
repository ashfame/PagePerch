import { describe, expect, it } from 'vitest';

import {
  PAGEPERCH_CORE_BLOCK_NAMES,
  PAGEPERCH_RICH_TEXT_FORMAT_NAMES,
  PAGEPERCH_UNKNOWN_FORMAT_FALLBACK_TAG_NAMES,
  assertExactGutenbergRegistry,
} from './pagePerchGutenbergRegistry';

describe('minimal PagePerch Gutenberg registries', () => {
  it('pins exactly the eight supported core block names', () => {
    expect(PAGEPERCH_CORE_BLOCK_NAMES).toEqual([
      'core/paragraph',
      'core/heading',
      'core/list',
      'core/list-item',
      'core/quote',
      'core/code',
      'core/preformatted',
      'core/separator',
    ]);
    expect(() =>
      assertExactGutenbergRegistry(
        [...PAGEPERCH_CORE_BLOCK_NAMES],
        PAGEPERCH_CORE_BLOCK_NAMES,
        'block',
      ),
    ).not.toThrow();
  });

  it('pins only approved safe formats and the sanitization fallback', () => {
    expect(PAGEPERCH_RICH_TEXT_FORMAT_NAMES).toEqual([
      'core/bold',
      'core/code',
      'core/italic',
      'core/link',
      'core/strikethrough',
      'core/subscript',
      'core/superscript',
      'core/keyboard',
      'core/unknown',
    ]);
    expect(() =>
      assertExactGutenbergRegistry(
        [...PAGEPERCH_RICH_TEXT_FORMAT_NAMES],
        PAGEPERCH_RICH_TEXT_FORMAT_NAMES,
        'format',
      ),
    ).not.toThrow();
  });

  it('pins non-toolbar semantic tags to the sanitized unknown-format fallback', () => {
    expect(PAGEPERCH_UNKNOWN_FORMAT_FALLBACK_TAG_NAMES).toEqual([
      'b',
      'i',
      'del',
      'mark',
    ]);
    expect(PAGEPERCH_RICH_TEXT_FORMAT_NAMES.at(-1)).toBe('core/unknown');
  });

  it.each([
    {
      name: 'missing entry',
      actual: PAGEPERCH_CORE_BLOCK_NAMES.slice(0, -1),
    },
    {
      name: 'reordered entry',
      actual: [
        PAGEPERCH_CORE_BLOCK_NAMES[1],
        PAGEPERCH_CORE_BLOCK_NAMES[0],
        ...PAGEPERCH_CORE_BLOCK_NAMES.slice(2),
      ],
    },
    {
      name: 'unexpected entry',
      actual: [...PAGEPERCH_CORE_BLOCK_NAMES, 'core/image'],
    },
  ])('fails closed on registry drift: $name', ({ actual }) => {
    expect(() =>
      assertExactGutenbergRegistry(actual, PAGEPERCH_CORE_BLOCK_NAMES, 'block'),
    ).toThrow(/block registry drifted/u);
  });
});
