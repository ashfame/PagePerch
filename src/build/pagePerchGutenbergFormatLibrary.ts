// @ts-expect-error WordPress does not publish declarations for format-library subpaths.
import { bold as importedBold } from '@wordpress/format-library/build-module/bold/index.js';
// @ts-expect-error WordPress does not publish declarations for format-library subpaths.
import { code as importedCode } from '@wordpress/format-library/build-module/code/index.js';
// @ts-expect-error WordPress does not publish declarations for format-library subpaths.
import { italic as importedItalic } from '@wordpress/format-library/build-module/italic/index.js';
// @ts-expect-error WordPress does not publish declarations for format-library subpaths.
import { keyboard as importedKeyboard } from '@wordpress/format-library/build-module/keyboard/index.js';
// @ts-expect-error WordPress does not publish declarations for format-library subpaths.
import { link as importedLink } from '@wordpress/format-library/build-module/link/index.js';
// @ts-expect-error WordPress does not publish declarations for format-library subpaths.
import { strikethrough as importedStrikethrough } from '@wordpress/format-library/build-module/strikethrough/index.js';
// @ts-expect-error WordPress does not publish declarations for format-library subpaths.
import { subscript as importedSubscript } from '@wordpress/format-library/build-module/subscript/index.js';
// @ts-expect-error WordPress does not publish declarations for format-library subpaths.
import { superscript as importedSuperscript } from '@wordpress/format-library/build-module/superscript/index.js';
// @ts-expect-error WordPress does not publish declarations for format-library subpaths.
import { unknown as importedUnknown } from '@wordpress/format-library/build-module/unknown/index.js';
import * as wordpressRichText from '@wordpress/rich-text';

import {
  PAGEPERCH_RICH_TEXT_FORMAT_NAMES,
  assertExactGutenbergRegistry,
} from './pagePerchGutenbergRegistry';

type RichTextFormat = Readonly<Record<string, unknown>> & {
  readonly name: string;
};

interface WordPressRichTextRegistryApi {
  readonly registerFormatType: (
    name: string,
    settings: Readonly<Record<string, unknown>>,
  ) => unknown;
}

const bold = importedBold as unknown as RichTextFormat;
const code = importedCode as unknown as RichTextFormat;
const italic = importedItalic as unknown as RichTextFormat;
const link = importedLink as unknown as RichTextFormat;
const strikethrough = importedStrikethrough as unknown as RichTextFormat;
const subscript = importedSubscript as unknown as RichTextFormat;
const superscript = importedSuperscript as unknown as RichTextFormat;
const keyboard = importedKeyboard as unknown as RichTextFormat;
const unknown = importedUnknown as unknown as RichTextFormat;
const { registerFormatType } =
  wordpressRichText as unknown as WordPressRichTextRegistryApi;

// `core/unknown` is intentional: Gutenberg's sanitized parser uses it to
// materialize approved but non-toolbar tags such as mark, b, i, and del.
// PageNoteEditor remains authoritative for allowed tags, attributes, and URLs.
export const PAGEPERCH_RICH_TEXT_FORMATS = [
  bold,
  code,
  italic,
  link,
  strikethrough,
  subscript,
  superscript,
  keyboard,
  unknown,
] as const satisfies readonly RichTextFormat[];

assertExactGutenbergRegistry(
  PAGEPERCH_RICH_TEXT_FORMATS.map(({ name }) => name),
  PAGEPERCH_RICH_TEXT_FORMAT_NAMES,
  'format',
);

for (const format of PAGEPERCH_RICH_TEXT_FORMATS) {
  registerFormatType(format.name, format);
}
