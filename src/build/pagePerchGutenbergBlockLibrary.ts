// @ts-expect-error WordPress does not publish declarations for block-library subpaths.
import * as importedParagraph from '@wordpress/block-library/build-module/paragraph/index.js';
// @ts-expect-error WordPress does not publish declarations for block-library subpaths.
import * as importedHeading from '@wordpress/block-library/build-module/heading/index.js';
// @ts-expect-error WordPress does not publish declarations for block-library subpaths.
import * as importedList from '@wordpress/block-library/build-module/list/index.js';
// @ts-expect-error WordPress does not publish declarations for block-library subpaths.
import * as importedListItem from '@wordpress/block-library/build-module/list-item/index.js';
// @ts-expect-error WordPress does not publish declarations for block-library subpaths.
import * as importedQuote from '@wordpress/block-library/build-module/quote/index.js';
// @ts-expect-error WordPress does not publish declarations for block-library subpaths.
import * as importedCode from '@wordpress/block-library/build-module/code/index.js';
// @ts-expect-error WordPress does not publish declarations for block-library subpaths.
import * as importedPreformatted from '@wordpress/block-library/build-module/preformatted/index.js';
// @ts-expect-error WordPress does not publish declarations for block-library subpaths.
import * as importedSeparator from '@wordpress/block-library/build-module/separator/index.js';
// @ts-expect-error WordPress ships declarations without exposing them in its package metadata.
import * as wordpressBlocks from '@wordpress/blocks';

import {
  PAGEPERCH_CORE_BLOCK_NAMES,
  assertExactGutenbergRegistry,
} from './pagePerchGutenbergRegistry';

interface InitializableBlock {
  readonly name: string;
  readonly init: () => unknown;
}

interface WordPressBlocksRegistryApi {
  readonly setDefaultBlockName: (name: string) => void;
}

const paragraph = importedParagraph as unknown as InitializableBlock;
const heading = importedHeading as unknown as InitializableBlock;
const list = importedList as unknown as InitializableBlock;
const listItem = importedListItem as unknown as InitializableBlock;
const quote = importedQuote as unknown as InitializableBlock;
const code = importedCode as unknown as InitializableBlock;
const preformatted = importedPreformatted as unknown as InitializableBlock;
const separator = importedSeparator as unknown as InitializableBlock;
const { setDefaultBlockName } =
  wordpressBlocks as unknown as WordPressBlocksRegistryApi;

export const PAGEPERCH_CORE_BLOCKS = [
  paragraph,
  heading,
  list,
  listItem,
  quote,
  code,
  preformatted,
  separator,
] as const satisfies readonly InitializableBlock[];

assertExactGutenbergRegistry(
  PAGEPERCH_CORE_BLOCKS.map(({ name }) => name),
  PAGEPERCH_CORE_BLOCK_NAMES,
  'block',
);

export function __experimentalGetCoreBlocks(): InitializableBlock[] {
  return [...PAGEPERCH_CORE_BLOCKS];
}

export function registerCoreBlocks(
  blocks: readonly InitializableBlock[] = PAGEPERCH_CORE_BLOCKS,
): void {
  for (const block of blocks) {
    block.init();
  }

  setDefaultBlockName(paragraph.name);
}
