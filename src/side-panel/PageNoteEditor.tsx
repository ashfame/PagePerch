import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
  type ComponentType,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import IsolatedBlockEditor, {
  EditorLoaded,
} from '@automattic/isolated-block-editor';
import '@automattic/isolated-block-editor/build-browser/core.css';
import apiFetch from '@wordpress/api-fetch';
import { parse as parseSerializedBlocks } from '@wordpress/block-serialization-default-parser';
// @ts-expect-error WordPress ships declarations without exposing them in its package metadata.
import * as wordpressBlockEditor from '@wordpress/block-editor';
// @ts-expect-error WordPress ships declarations without exposing them in its package metadata.
import * as wordpressBlocks from '@wordpress/blocks';
import { useRegistry } from '@wordpress/data';
import { RichTextData } from '@wordpress/rich-text';

import type { EditorMode } from '../domain/settings';
import './PageNoteEditor.css';
import {
  PAGE_NOTE_EDITOR_STYLES,
  type PageNoteEditorStyleAsset,
} from './PageNoteEditorStyles';

interface BlockValue {
  readonly name: string;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly innerBlocks: readonly BlockValue[];
  readonly clientId?: string;
}

interface WordPressBlocksApi {
  readonly createBlock: (
    name: string,
    attributes?: Readonly<Record<string, unknown>>,
    innerBlocks?: readonly BlockValue[],
  ) => BlockValue;
  readonly hasBlockSupport: (
    blockName: string,
    feature: 'splitting',
    defaultValue: false,
  ) => boolean;
  readonly pasteHandler: (options: {
    readonly HTML: string;
    readonly plainText?: string;
    readonly mode: 'BLOCKS';
  }) => BlockValue[] | string;
  readonly serialize: (blocks: readonly BlockValue[]) => string;
  readonly switchToBlockType: (
    block: BlockValue,
    blockName: string,
  ) => BlockValue[] | null;
}

interface WordPressBlockEditorApi {
  readonly __unstableEditorStyles?: ComponentType<{
    readonly styles: readonly PageNoteEditorStyleAsset[];
  }>;
}

const {
  createBlock,
  hasBlockSupport,
  pasteHandler,
  serialize,
  switchToBlockType,
} = wordpressBlocks as unknown as WordPressBlocksApi;
const { __unstableEditorStyles: GutenbergEditorStyles } =
  wordpressBlockEditor as unknown as WordPressBlockEditorApi;

type ParseBlocks = (content: string) => unknown;
type HandleRawHtml = (options: { readonly HTML: string }) => unknown;

const LOCAL_API_ERROR_CODE = 'pageperch_local_only';
const LOCAL_API_ERROR_MESSAGE =
  'PagePerch blocks an unhandled WordPress API request in the local note editor.';

// The editor installs preload middleware on this shared singleton; everything
// not satisfied by those local fixtures must fail before window.fetch.
apiFetch.setFetchHandler(() =>
  Promise.reject(
    Object.assign(new Error(LOCAL_API_ERROR_MESSAGE), {
      code: LOCAL_API_ERROR_CODE,
    }),
  ),
);

const TEXT_FOCUSED_BLOCKS = [
  'core/paragraph',
  'core/heading',
  'core/list',
  'core/list-item',
  'core/quote',
  'core/code',
  'core/preformatted',
  'core/separator',
] as const;
const PARAGRAPH_ONLY_BLOCKS = ['core/paragraph'] as const;
const EMPTY_ITEMS = Object.freeze([]) as readonly never[];
const NO_LINK_SUGGESTIONS = (): readonly never[] => EMPTY_ITEMS;
const MAX_BLOCK_DEPTH = 32;
const MAX_BLOCK_COUNT = 2_000;
const VISIBLE_ATTRIBUTE_KEYS = new Set([
  'content',
  'value',
  'citation',
  'caption',
  'alt',
  'title',
  'description',
  'text',
  'label',
  'summary',
  'innerHTML',
  'html',
]);
const NON_VISIBLE_ATTRIBUTE_KEYS = new Set([
  'anchor',
  'className',
  'eventHandler',
  'href',
  'id',
  'linkTarget',
  'metadata',
  'providerNameSlug',
  'rel',
  'src',
  'style',
  'url',
]);
const SAFE_INLINE_TAGS = new Set([
  'strong',
  'b',
  'em',
  'i',
  's',
  'del',
  'mark',
  'code',
  'kbd',
  'sub',
  'sup',
]);
const UNSAFE_ELEMENT_PATTERN =
  /<(script|style|template|iframe|object|embed|svg|math)\b[^>]*(?:>[\s\S]*?(?:<\/\1\s*>|$)|$)/giu;
const HTML_COMMENT_PATTERN = /<!--[\s\S]*?-->/gu;
const HTML_TAG_PATTERN = /<\/?([a-z][a-z0-9-]*)\b[^>]*>/giu;
const BLOCK_BREAK_PATTERN =
  /<\/?(?:address|article|aside|blockquote|br|div|figcaption|figure|h[1-6]|header|li|main|ol|p|pre|section|table|td|th|tr|ul)\b[^>]*>/giu;
const INTERACTIVE_EDITOR_TARGET_SELECTOR = [
  '[contenteditable="true"]',
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  '[role="button"]',
  '[role="checkbox"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="radio"]',
  '[role="switch"]',
  '.block-editor-block-contextual-toolbar',
  '.block-editor-block-list__block',
  '.block-editor-block-popover',
  '.block-editor-block-toolbar',
  '.block-editor-button-block-appender',
  '.block-editor-inserter',
  '.block-editor-link-control',
  '.components-popover',
].join(',');
const BLANK_EDITOR_SPACE_SELECTOR = [
  '.page-note-editor__canvas',
  '.page-note-editor__isolated',
  '.iso-editor',
  '.edit-post-layout',
  '.interface-interface-skeleton',
  '.interface-interface-skeleton__body',
  '.interface-interface-skeleton__editor',
  '.interface-interface-skeleton__content',
  '.components-navigate-regions',
  '.edit-post-visual-editor',
  '.edit-post-visual-editor__content-area',
  '.editor-styles-wrapper',
  '.block-editor-writing-flow',
  '.block-editor-block-list__layout.is-root-container',
].join(',');

class UnsafeStoredContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeStoredContentError';
  }
}

function countSerializedBlocks(
  blocks: ReturnType<typeof parseSerializedBlocks>,
  depth = 0,
  count = { value: 0 },
): boolean {
  if (depth > MAX_BLOCK_DEPTH) {
    throw new UnsafeStoredContentError(
      'The serialized note exceeds the safe block nesting limit.',
    );
  }

  let containsNamedBlock = false;

  for (const block of blocks) {
    count.value += 1;

    if (count.value > MAX_BLOCK_COUNT) {
      throw new UnsafeStoredContentError(
        'The serialized note exceeds the safe block count limit.',
      );
    }

    const containsNamedInnerBlock = countSerializedBlocks(
      block.innerBlocks,
      depth + 1,
      count,
    );
    containsNamedBlock =
      block.blockName !== null || containsNamedInnerBlock || containsNamedBlock;
  }

  return containsNamedBlock;
}

// The direct default parser owns recognition of Gutenberg's block-comment
// grammar. @wordpress/blocks materializes blocks only after this bounded pass.
// eslint-disable-next-line react-refresh/only-export-components
export function isSerializedGutenbergDocument(content: string): boolean {
  return countSerializedBlocks(parseSerializedBlocks(content));
}

function decodeHtmlEntities(value: string): string {
  const namedEntities: Readonly<Record<string, string>> = {
    amp: '&',
    apos: "'",
    bsol: '\\',
    colon: ':',
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
  };

  return value.replace(
    /&(?:#(\d+)|#x([\da-f]+)|([a-z]+));/giu,
    (
      entity,
      decimal: string | undefined,
      hexadecimal: string | undefined,
      name: string | undefined,
    ) => {
      if (name !== undefined) {
        return namedEntities[name.toLowerCase()] ?? entity;
      }

      const codePoint = Number.parseInt(
        decimal ?? hexadecimal ?? '',
        decimal === undefined ? 16 : 10,
      );

      return Number.isSafeInteger(codePoint) &&
        codePoint > 0 &&
        codePoint <= 0x10ffff &&
        !(codePoint >= 0xd800 && codePoint <= 0xdfff)
        ? String.fromCodePoint(codePoint)
        : '\uFFFD';
    },
  );
}

function escapeHtmlText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtmlText(value).replaceAll('`', '&#096;');
}

function removeUnsafeElements(value: string): string {
  return value
    .replace(UNSAFE_ELEMENT_PATTERN, ' ')
    .replace(HTML_COMMENT_PATTERN, ' ');
}

function extractVisibleText(value: string): string {
  return decodeHtmlEntities(
    removeUnsafeElements(value)
      .replace(BLOCK_BREAK_PATTERN, ' ')
      .replace(HTML_TAG_PATTERN, ' '),
  )
    .replace(/\s+/gu, ' ')
    .trim();
}

function readRichTextValue(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }

  return value instanceof RichTextData ? value.toHTMLString() : undefined;
}

function extractSafeHref(tag: string): string | null {
  const match = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/iu.exec(
    tag,
  );
  const href = decodeHtmlEntities(
    match?.[1] ?? match?.[2] ?? match?.[3] ?? '',
  ).trim();

  // Browsers normalize backslashes inconsistently around authority boundaries,
  // so reject them before applying the explicit local link allowlist.
  if (href.includes('\\')) {
    return null;
  }

  const canonicalHref = [...href]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 0x20 && codePoint !== 0x7f;
    })
    .join('');

  if (
    !/^(?:https?:|mailto:|tel:|#|\/(?!\/)|\?|\.{1,2}\/)/iu.test(canonicalHref)
  ) {
    return null;
  }

  return href;
}

function sanitizeRichText(value: string): string {
  let openAnchorCount = 0;

  return removeUnsafeElements(value).replace(
    HTML_TAG_PATTERN,
    (tag, rawName: string) => {
      const name = rawName.toLowerCase();
      const isClosing = /^<\//u.test(tag);

      if (name === 'br') {
        return isClosing ? '' : '<br>';
      }

      if (name === 'a') {
        if (isClosing) {
          if (openAnchorCount === 0) {
            return '';
          }

          openAnchorCount -= 1;
          return '</a>';
        }

        const href = extractSafeHref(tag);

        if (href === null) {
          return '';
        }

        openAnchorCount += 1;
        return `<a href="${escapeHtmlAttribute(href)}" rel="noopener noreferrer">`;
      }

      return SAFE_INLINE_TAGS.has(name)
        ? isClosing
          ? `</${name}>`
          : `<${name}>`
        : '';
    },
  );
}

function visibleAttributeSegments(
  value: unknown,
  key: string,
  depth = 0,
): string[] {
  if (depth > MAX_BLOCK_DEPTH) {
    throw new UnsafeStoredContentError(
      'The stored note exceeds the safe visible-text nesting limit.',
    );
  }

  if (NON_VISIBLE_ATTRIBUTE_KEYS.has(key) || /^on[a-z]/iu.test(key)) {
    return [];
  }

  const richText = readRichTextValue(value);
  if (richText !== undefined) {
    if (!VISIBLE_ATTRIBUTE_KEYS.has(key)) {
      return [];
    }

    const text = extractVisibleText(richText);
    return text === '' ? [] : [text];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) =>
      visibleAttributeSegments(item, key, depth + 1),
    );
  }

  if (typeof value !== 'object' || value === null) {
    return [];
  }

  return Object.entries(value).flatMap(([nestedKey, nestedValue]) =>
    visibleAttributeSegments(nestedValue, nestedKey, depth + 1),
  );
}

function visibleSegments(block: BlockValue): string[] {
  const ownSegments = Object.entries(block.attributes).flatMap(([key, value]) =>
    visibleAttributeSegments(value, key),
  );
  const nestedSegments = block.innerBlocks.flatMap((innerBlock) =>
    visibleSegments(innerBlock),
  );

  // Attribute values and child blocks have distinct structural provenance.
  // Retain both occurrences rather than guessing that equal text is duplicate.
  return [...ownSegments, ...nestedSegments];
}

function makeBlock(
  name: string,
  attributes: Readonly<Record<string, unknown>> = {},
  innerBlocks: readonly BlockValue[] = [],
): BlockValue {
  return createBlock(name, attributes, [...innerBlocks]);
}

function paragraphBlocksFromVisibleText(block: BlockValue): BlockValue[] {
  return visibleSegments(block).map((segment) =>
    makeBlock('core/paragraph', {
      content: escapeHtmlText(segment),
    }),
  );
}

function readRichContent(block: BlockValue, key = 'content'): string {
  const value = readRichTextValue(block.attributes[key]);

  if (value === undefined) {
    return '';
  }

  return sanitizeRichText(value);
}

function sanitizeListItem(block: BlockValue): BlockValue {
  const nestedLists: BlockValue[] = [];
  const additionalText: string[] = [];

  for (const innerBlock of block.innerBlocks) {
    if (innerBlock.name === 'core/list') {
      const nestedList = sanitizeTextFocusedBlock(innerBlock)[0];

      if (nestedList !== undefined) {
        nestedLists.push(nestedList);
      }
    } else {
      additionalText.push(...visibleSegments(innerBlock));
    }
  }

  const ownContent = readRichContent(block);
  const appendedContent = additionalText
    .map((text) => escapeHtmlText(text))
    .join(' ');
  const content = [ownContent, appendedContent].filter(Boolean).join(' ');

  return makeBlock(
    'core/list-item',
    {
      content,
    },
    nestedLists,
  );
}

function sanitizeTextFocusedBlock(block: BlockValue): BlockValue[] {
  switch (block.name) {
    case 'core/paragraph': {
      const nestedContent = block.innerBlocks.flatMap((innerBlock) =>
        visibleSegments(innerBlock),
      );
      const content = [
        readRichContent(block),
        ...nestedContent.map((text) => escapeHtmlText(text)),
      ]
        .filter(Boolean)
        .join(' ');

      return [
        makeBlock('core/paragraph', {
          content,
        }),
      ];
    }
    case 'core/heading': {
      const level = block.attributes.level;
      const nestedText = block.innerBlocks.flatMap((innerBlock) =>
        visibleSegments(innerBlock),
      );
      const content = [
        readRichContent(block),
        ...nestedText.map((text) => escapeHtmlText(text)),
      ]
        .filter(Boolean)
        .join(' ');

      return [
        makeBlock('core/heading', {
          content,
          ...(typeof level === 'number' &&
          Number.isInteger(level) &&
          level >= 1 &&
          level <= 6
            ? { level }
            : {}),
        }),
      ];
    }
    case 'core/list':
      return [
        makeBlock(
          'core/list',
          {
            ordered: block.attributes.ordered === true,
          },
          block.innerBlocks.flatMap((innerBlock) =>
            innerBlock.name === 'core/list-item'
              ? [sanitizeListItem(innerBlock)]
              : visibleSegments(innerBlock).map((text) =>
                  makeBlock('core/list-item', {
                    content: escapeHtmlText(text),
                  }),
                ),
          ),
        ),
      ];
    case 'core/list-item':
      return [sanitizeListItem(block)];
    case 'core/quote': {
      const sanitizedInnerBlocks = block.innerBlocks.flatMap((innerBlock) =>
        innerBlock.name === 'core/paragraph'
          ? sanitizeTextFocusedBlock(innerBlock)
          : paragraphBlocksFromVisibleText(innerBlock),
      );
      const citation = readRichContent(block, 'citation');

      return [
        makeBlock(
          'core/quote',
          {
            citation,
          },
          sanitizedInnerBlocks,
        ),
      ];
    }
    case 'core/code':
    case 'core/preformatted': {
      const text = visibleSegments(block).join(' ');
      return [
        makeBlock(block.name, {
          content: escapeHtmlText(text),
        }),
      ];
    }
    case 'core/separator':
      return [
        makeBlock('core/separator'),
        ...block.innerBlocks.flatMap((innerBlock) =>
          paragraphBlocksFromVisibleText(innerBlock),
        ),
      ];
    default:
      return paragraphBlocksFromVisibleText(block);
  }
}

function validateParsedBlocks(
  value: unknown,
  depth = 0,
  count = { value: 0 },
): BlockValue[] {
  if (!Array.isArray(value)) {
    throw new UnsafeStoredContentError(
      'The editor parser returned a non-block value.',
    );
  }

  if (depth > MAX_BLOCK_DEPTH) {
    throw new UnsafeStoredContentError(
      'The stored note exceeds the safe block nesting limit.',
    );
  }

  const candidates: unknown[] = value;

  return candidates.map((candidate) => {
    count.value += 1;

    if (count.value > MAX_BLOCK_COUNT) {
      throw new UnsafeStoredContentError(
        'The stored note exceeds the safe block count limit.',
      );
    }

    if (
      typeof candidate !== 'object' ||
      candidate === null ||
      !('name' in candidate) ||
      typeof candidate.name !== 'string' ||
      !('attributes' in candidate) ||
      typeof candidate.attributes !== 'object' ||
      candidate.attributes === null ||
      Array.isArray(candidate.attributes) ||
      !('innerBlocks' in candidate)
    ) {
      throw new UnsafeStoredContentError(
        'The editor parser returned a malformed block.',
      );
    }

    return {
      name: candidate.name,
      attributes: candidate.attributes as Readonly<Record<string, unknown>>,
      innerBlocks: validateParsedBlocks(
        candidate.innerBlocks,
        depth + 1,
        count,
      ),
      ...('clientId' in candidate && typeof candidate.clientId === 'string'
        ? { clientId: candidate.clientId }
        : {}),
    };
  });
}

function validateSanitizedBlocks(
  blocks: readonly BlockValue[],
  editorMode: EditorMode,
  depth = 0,
  count = { value: 0 },
): void {
  const allowedBlocks =
    editorMode === 'paragraphs-only'
      ? PARAGRAPH_ONLY_BLOCKS
      : TEXT_FOCUSED_BLOCKS;

  if (depth > MAX_BLOCK_DEPTH) {
    throw new UnsafeStoredContentError(
      'The sanitized note exceeds the safe block nesting limit.',
    );
  }

  for (const block of blocks) {
    count.value += 1;

    if (
      count.value > MAX_BLOCK_COUNT ||
      !allowedBlocks.includes(
        block.name as (typeof allowedBlocks)[number] & 'core/paragraph',
      )
    ) {
      throw new UnsafeStoredContentError(
        'The stored note could not be converted to safe local text blocks.',
      );
    }

    const childNames = block.innerBlocks.map((innerBlock) => innerBlock.name);
    const hasSafeChildren =
      (block.name === 'core/list' &&
        childNames.every((name) => name === 'core/list-item')) ||
      (block.name === 'core/list-item' &&
        childNames.every((name) => name === 'core/list')) ||
      (block.name === 'core/quote' &&
        childNames.every((name) => name === 'core/paragraph')) ||
      (block.name !== 'core/list' &&
        block.name !== 'core/list-item' &&
        block.name !== 'core/quote' &&
        childNames.length === 0);

    if (!hasSafeChildren) {
      throw new UnsafeStoredContentError(
        'The stored note contains an unsafe nested block structure.',
      );
    }

    validateSanitizedBlocks(block.innerBlocks, editorMode, depth + 1, count);
  }
}

function sanitizeBlocks(
  parsedValue: unknown,
  editorMode: EditorMode,
  ensureEditable = true,
): BlockValue[] {
  // Stored block names and attributes are untrusted. Rebuild only the local
  // text schema, then validate the rebuilt tree before Gutenberg can render it.
  const parsedBlocks = validateParsedBlocks(parsedValue);
  const sanitized =
    editorMode === 'paragraphs-only'
      ? parsedBlocks.flatMap((block) =>
          block.name === 'core/paragraph'
            ? sanitizeTextFocusedBlock(block)
            : paragraphBlocksFromVisibleText(block),
        )
      : parsedBlocks.flatMap((block) => sanitizeTextFocusedBlock(block));

  const editableSanitized =
    ensureEditable && sanitized.length === 0
      ? [makeBlock('core/paragraph')]
      : sanitized;
  validateSanitizedBlocks(editableSanitized, editorMode);
  return editableSanitized;
}

const UNSAFE_CLIPBOARD_ELEMENTS = new Set([
  'EMBED',
  'IFRAME',
  'LINK',
  'MATH',
  'META',
  'NOSCRIPT',
  'OBJECT',
  'SCRIPT',
  'STYLE',
  'SVG',
  'TEMPLATE',
]);
const CLIPBOARD_WRAPPER_ELEMENTS = new Set([
  'ARTICLE',
  'DIV',
  'MAIN',
  'SECTION',
]);
function normalizeClipboardText(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function isClipboardElementConcealed(element: Element): boolean {
  if (
    UNSAFE_CLIPBOARD_ELEMENTS.has(element.tagName) ||
    element.hasAttribute('hidden') ||
    element.hasAttribute('inert') ||
    element.getAttribute('aria-hidden')?.trim().toLowerCase() === 'true'
  ) {
    return true;
  }

  if (!(element instanceof HTMLElement)) {
    return false;
  }

  const display = element.style.display.trim().toLowerCase();
  const visibility = element.style.visibility.trim().toLowerCase();
  const contentVisibility = element.style
    .getPropertyValue('content-visibility')
    .trim()
    .toLowerCase();

  return (
    display === 'none' ||
    visibility === 'hidden' ||
    visibility === 'collapse' ||
    contentVisibility === 'hidden'
  );
}

function safeClipboardElement(element: Element): Element | null {
  if (isClipboardElementConcealed(element)) {
    return null;
  }

  const clone = element.cloneNode(true);
  if (!(clone instanceof Element)) {
    return null;
  }

  for (const descendant of [...clone.querySelectorAll('*')]) {
    if (isClipboardElementConcealed(descendant)) {
      descendant.remove();
    }
  }

  return clone;
}

function clipboardVisibleSegments(element: Element): string[] {
  const segments: string[] = [];
  const visit = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = normalizeClipboardText(node.textContent ?? '');
      if (text !== '') {
        segments.push(text);
      }
      return;
    }

    if (!(node instanceof Element) || isClipboardElementConcealed(node)) {
      return;
    }

    if (node instanceof HTMLImageElement) {
      const alt = normalizeClipboardText(node.alt);
      if (alt !== '') {
        segments.push(alt);
      }
      return;
    }

    for (const child of node.childNodes) {
      visit(child);
    }
  };

  visit(element);
  return segments;
}

function countTextOccurrences(value: string, search: string): number {
  let count = 0;
  let cursor = 0;

  while (search !== '') {
    const index = value.indexOf(search, cursor);
    if (index === -1) {
      break;
    }
    count += 1;
    cursor = index + search.length;
  }

  return count;
}

function convertedTextPreservesSegments(
  convertedText: string,
  sourceSegments: readonly string[],
): boolean {
  let cursor = 0;
  for (const segment of sourceSegments) {
    const index = convertedText.indexOf(segment, cursor);
    if (index === -1) {
      return false;
    }
    cursor = index + segment.length;
  }

  const sourceText = sourceSegments.join(' ');
  return [...new Set(sourceSegments)].every(
    (segment) =>
      countTextOccurrences(convertedText, segment) ===
      countTextOccurrences(sourceText, segment),
  );
}

function clipboardFragmentNodes(documentNode: Document): ChildNode[] {
  let nodes = [...documentNode.body.childNodes].filter(
    (node) =>
      node.nodeType !== Node.TEXT_NODE ||
      (node.textContent ?? '').trim() !== '',
  );

  while (
    nodes.length === 1 &&
    nodes[0] instanceof Element &&
    CLIPBOARD_WRAPPER_ELEMENTS.has(nodes[0].tagName) &&
    !isClipboardElementConcealed(nodes[0])
  ) {
    nodes = [...nodes[0].childNodes].filter(
      (node) =>
        node.nodeType !== Node.TEXT_NODE ||
        (node.textContent ?? '').trim() !== '',
    );
  }

  return nodes;
}

// eslint-disable-next-line react-refresh/only-export-components
export function convertClipboardHtmlToSafeBlocks(
  html: string,
  _plainText: string,
  editorMode: EditorMode,
): BlockValue[] {
  const clipboardDocument = new DOMParser().parseFromString(html, 'text/html');
  const clipboardElements = [...clipboardDocument.body.querySelectorAll('*')];

  if (clipboardElements.length > MAX_BLOCK_COUNT) {
    throw new UnsafeStoredContentError(
      'The pasted content exceeds the safe element count limit.',
    );
  }

  for (const element of clipboardElements) {
    let depth = 0;
    let ancestor = element.parentElement;
    while (ancestor !== null && ancestor !== clipboardDocument.body) {
      depth += 1;
      if (depth > MAX_BLOCK_DEPTH) {
        throw new UnsafeStoredContentError(
          'The pasted content exceeds the safe element nesting limit.',
        );
      }
      ancestor = ancestor.parentElement;
    }
  }

  const safeBlocks = clipboardFragmentNodes(clipboardDocument).flatMap(
    (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = (node.textContent ?? '').replace(/\s+/gu, ' ').trim();
        return text === ''
          ? []
          : [
              makeBlock('core/paragraph', {
                content: escapeHtmlText(text),
              }),
            ];
      }

      if (!(node instanceof Element)) {
        return [];
      }

      const safeElement = safeClipboardElement(node);
      if (safeElement === null) {
        return [];
      }

      const fallbackSegments = clipboardVisibleSegments(safeElement);
      const converted = pasteHandler({
        HTML: safeElement.outerHTML,
        plainText: fallbackSegments.join(' '),
        mode: 'BLOCKS',
      });
      const convertedBlocks =
        typeof converted === 'string'
          ? []
          : sanitizeBlocks(converted, editorMode, false);
      const convertedVisibleText = normalizeClipboardText(
        extractVisibleText(serialize(convertedBlocks)),
      );
      const conversionIsComplete = convertedTextPreservesSegments(
        convertedVisibleText,
        fallbackSegments,
      );

      return conversionIsComplete
        ? convertedBlocks
        : fallbackSegments.map((segment) =>
            makeBlock('core/paragraph', {
              content: escapeHtmlText(segment),
            }),
          );
    },
  );
  const editableSafeBlocks =
    safeBlocks.length === 0 ? [makeBlock('core/paragraph')] : safeBlocks;

  validateSanitizedBlocks(editableSafeBlocks, editorMode);
  return editableSafeBlocks;
}

interface PageNoteEditorCapabilitiesShape {
  iso: {
    allowApi: boolean;
    blocks: {
      allowBlocks: readonly string[];
      disallowBlocks: readonly string[];
    };
    currentPattern: null;
    defaultPreferences: {
      fixedToolbar: boolean;
    };
    disableCanvasAnimations: boolean;
    disallowEmbed: readonly string[];
    footer: boolean;
    header: boolean;
    linkMenu: readonly never[];
    moreMenu: false;
    patterns: readonly never[];
    persistenceKey: null;
    preferencesKey: null;
    sidebar: {
      customComponent: null;
      inserter: boolean;
      inspector: boolean;
    };
    toolbar: {
      documentInspector: boolean;
      inserter: boolean;
      inspector: boolean;
      navigation: boolean;
      selectorTool: boolean;
      undo: boolean;
    };
  };
  editor: {
    __experimentalBlockPatterns: readonly never[];
    __experimentalCanUserUseUnfilteredHTML: boolean;
    __experimentalFetchLinkSuggestions: typeof NO_LINK_SUGGESTIONS;
    __experimentalFetchReusableBlocks: boolean;
    __experimentalReusableBlocks: readonly never[];
    alignWide: boolean;
    allowedBlockTypes: readonly string[];
    allowedMimeTypes: readonly never[];
    autosaveInterval: number;
    availableLegacyWidgets: Readonly<Record<string, never>>;
    bodyPlaceholder: string;
    codeEditingEnabled: boolean;
    defaultEditorStyles: readonly never[];
    disablePostFormats: boolean;
    fetchLinkSuggestions: typeof NO_LINK_SUGGESTIONS;
    fixedToolbar: boolean;
    hasFixedToolbar: boolean;
    hasInlineToolbar: boolean;
    hasPermissionsToManageWidgets: boolean;
    hasUploadPermissions: boolean;
    imageSizes: readonly never[];
    isRTL: boolean;
    maxUploadFileSize: number;
    reusableBlocks: readonly never[];
    richEditingEnabled: boolean;
    styles: readonly PageNoteEditorStyleAsset[];
    template: null;
    templateLock: null;
  };
}

export type PageNoteEditorCapabilities =
  DeepReadonly<PageNoteEditorCapabilitiesShape>;

type DeepReadonly<Value> = Value extends (...args: never[]) => unknown
  ? Value
  : Value extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : Value extends object
      ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
      : Value;

function deepFreeze<Value>(value: Value): DeepReadonly<Value> {
  if (
    value === null ||
    (typeof value !== 'object' && typeof value !== 'function')
  ) {
    return value as DeepReadonly<Value>;
  }

  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }

  return Object.freeze(value) as DeepReadonly<Value>;
}

function createCapabilities(
  allowedBlockTypes: readonly string[],
): PageNoteEditorCapabilities {
  const allowedBlocks = [...allowedBlockTypes];

  return deepFreeze({
    iso: {
      allowApi: false,
      blocks: {
        allowBlocks: allowedBlocks,
        disallowBlocks: [],
      },
      currentPattern: null,
      defaultPreferences: {
        fixedToolbar: false,
      },
      disableCanvasAnimations: true,
      disallowEmbed: [],
      footer: false,
      header: false,
      linkMenu: [],
      moreMenu: false as const,
      patterns: [],
      persistenceKey: null,
      preferencesKey: null,
      sidebar: {
        customComponent: null,
        inserter: false,
        inspector: false,
      },
      toolbar: {
        documentInspector: false,
        inserter: false,
        inspector: false,
        navigation: false,
        selectorTool: false,
        undo: false,
      },
    },
    editor: {
      __experimentalBlockPatterns: [],
      __experimentalCanUserUseUnfilteredHTML: false,
      __experimentalFetchLinkSuggestions: NO_LINK_SUGGESTIONS,
      __experimentalFetchReusableBlocks: false,
      __experimentalReusableBlocks: [],
      alignWide: false,
      allowedBlockTypes: allowedBlocks,
      allowedMimeTypes: [],
      autosaveInterval: 0,
      availableLegacyWidgets: {},
      bodyPlaceholder: 'Start writing or choose a local text block',
      codeEditingEnabled: false,
      defaultEditorStyles: [],
      disablePostFormats: true,
      fetchLinkSuggestions: NO_LINK_SUGGESTIONS,
      fixedToolbar: false,
      hasFixedToolbar: false,
      hasInlineToolbar: false,
      hasPermissionsToManageWidgets: false,
      hasUploadPermissions: false,
      imageSizes: [],
      isRTL: false,
      maxUploadFileSize: 0,
      reusableBlocks: [],
      richEditingEnabled: true,
      styles: PAGE_NOTE_EDITOR_STYLES,
      template: null,
      templateLock: null,
    },
  });
}

const CAPABILITIES: Readonly<Record<EditorMode, PageNoteEditorCapabilities>> =
  Object.freeze({
    'text-focused-blocks': createCapabilities(TEXT_FOCUSED_BLOCKS),
    'paragraphs-only': createCapabilities(PARAGRAPH_ONLY_BLOCKS),
  });

// eslint-disable-next-line react-refresh/only-export-components
export function buildPageNoteEditorCapabilities(
  editorMode: EditorMode,
): PageNoteEditorCapabilities {
  return CAPABILITIES[editorMode];
}

export interface PageNoteEditorProps {
  /**
   * Immutable for one page identity. Consumers key PageNoteEditor by page
   * identity; PageNoteEditor itself remounts Gutenberg when editorMode changes.
   */
  readonly initialContentHtml: string;
  readonly editorMode: EditorMode;
  readonly onContentChange: (serializedContentHtml: string) => void;
  readonly onReady: () => void;
  readonly onLoading: () => void;
  readonly onError: (error: Error) => void;
}

interface SerializedMutation {
  readonly version: number;
  readonly contentHtml: string;
}

interface RootInsertionSelectors {
  readonly canInsertBlockType: (
    blockName: string,
    rootClientId: string | undefined,
  ) => boolean;
  readonly getBlockName: (clientId: string) => string | undefined;
}

interface BlockEditorSelectors extends RootInsertionSelectors {
  readonly __unstableIsFullySelected: () => boolean;
  readonly getBlockRootClientId: (clientId: string) => string | undefined;
  readonly getSelectionEnd: () => {
    readonly clientId?: string;
    readonly offset?: number;
  };
  readonly getSelectionStart: () => {
    readonly clientId?: string;
    readonly offset?: number;
  };
  readonly getSelectedBlockClientIds: () => string[];
  readonly hasMultiSelection: () => boolean;
}

interface BlockEditorRegistry {
  readonly select: (storeName: 'core/block-editor') => BlockEditorSelectors;
  readonly dispatch: (storeName: 'core/block-editor') => {
    readonly __unstableSplitSelection: (blocks: readonly BlockValue[]) => void;
    readonly replaceBlocks: (
      clientIds: readonly string[],
      blocks: readonly BlockValue[],
      indexToSelect: number,
      initialPosition: -1,
    ) => void;
  };
}

function normalizeEditorError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  if (typeof error === 'string' && error.trim() !== '') {
    return new Error(error);
  }

  return new Error('PagePerch encountered an unexpected editor error.');
}

function hasInitialContentMarker(values: readonly unknown[]): boolean {
  return values.some(
    (value) =>
      typeof value === 'object' &&
      value !== null &&
      'isInitialContent' in value &&
      value.isInitialContent === true,
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function adaptStructuredBlocksToRoot(
  blocks: readonly BlockValue[],
  rootClientId: string | undefined,
  selectors: RootInsertionSelectors,
): BlockValue[] | null {
  const adapted: BlockValue[] = [];

  for (const block of blocks) {
    if (selectors.canInsertBlockType(block.name, rootClientId)) {
      adapted.push(block);
      continue;
    }

    if (rootClientId === undefined) {
      return null;
    }

    const rootBlockName = selectors.getBlockName(rootClientId);
    if (rootBlockName === undefined) {
      return null;
    }

    const switchedBlocks =
      block.name === rootBlockName
        ? [block]
        : switchToBlockType(block, rootBlockName);

    if (switchedBlocks === null || switchedBlocks.length === 0) {
      return null;
    }

    for (const switchedBlock of switchedBlocks) {
      if (switchedBlock.innerBlocks.length === 0) {
        return null;
      }

      for (const innerBlock of switchedBlock.innerBlocks) {
        if (!selectors.canInsertBlockType(innerBlock.name, rootClientId)) {
          return null;
        }
        adapted.push(innerBlock);
      }
    }
  }

  return adapted.length === 0 ? null : adapted;
}

function RichPasteBridge({
  editorMode,
  editorRootRef,
  onError,
}: {
  readonly editorMode: EditorMode;
  readonly editorRootRef: RefObject<HTMLElement | null>;
  readonly onError: (error?: unknown) => void;
}) {
  const registry = useRegistry() as unknown as BlockEditorRegistry;

  useEffect(() => {
    const editorRoot = editorRootRef.current;

    if (editorRoot === null) {
      return;
    }

    const handleRichPaste = (event: ClipboardEvent): void => {
      const target = event.target;
      const html = event.clipboardData?.getData('text/html') ?? '';

      if (
        event.defaultPrevented ||
        !(target instanceof Node) ||
        !editorRoot.contains(target) ||
        html.trim() === ''
      ) {
        return;
      }

      try {
        const editor = registry.select('core/block-editor');
        const selectedClientIds = editor.getSelectedBlockClientIds();
        const firstSelectedClientId = selectedClientIds[0];
        if (firstSelectedClientId === undefined) {
          return;
        }

        const blocks = convertClipboardHtmlToSafeBlocks(
          html,
          event.clipboardData?.getData('text/plain') ?? '',
          editorMode,
        );

        const isStructuredPaste =
          blocks.length > 1 ||
          blocks[0]?.name !== 'core/paragraph' ||
          /<(?:article|aside|blockquote|details|div|figure|h[1-6]|hr|li|main|ol|pre|section|table|ul)\b/iu.test(
            html,
          );

        // Native Gutenberg owns inline insertion. This bridge guarantees
        // structured conversion in the pinned isolated-editor integration only
        // when clipboard HTML would otherwise lose its block structure.
        if (!isStructuredPaste) {
          return;
        }

        const rootClientId = editor.getBlockRootClientId(firstSelectedClientId);
        const isFullySelected = editor.__unstableIsFullySelected();
        const selectionStart = editor.getSelectionStart();
        const selectionEnd = editor.getSelectionEnd();

        if (
          !isFullySelected &&
          (selectionStart.clientId === undefined ||
            selectionEnd.clientId === undefined ||
            selectionStart.offset === undefined ||
            selectionEnd.offset === undefined ||
            editor.getBlockRootClientId(selectionStart.clientId) !==
              rootClientId ||
            editor.getBlockRootClientId(selectionEnd.clientId) !==
              rootClientId ||
            (!editor.hasMultiSelection() &&
              !hasBlockSupport(
                editor.getBlockName(firstSelectedClientId) ?? '',
                'splitting',
                false,
              )))
        ) {
          return;
        }

        const adaptedBlocks = adaptStructuredBlocksToRoot(
          blocks,
          rootClientId,
          editor,
        );

        if (adaptedBlocks === null) {
          return;
        }

        const actions = registry.dispatch('core/block-editor');
        if (isFullySelected) {
          actions.replaceBlocks(
            selectedClientIds,
            adaptedBlocks,
            adaptedBlocks.length - 1,
            -1,
          );
        } else {
          actions.__unstableSplitSelection(adaptedBlocks);
        }

        event.preventDefault();
        event.stopPropagation();
      } catch (error) {
        onError(error);
      }
    };

    editorRoot.addEventListener('paste', handleRichPaste, { capture: true });

    return () => {
      editorRoot.removeEventListener('paste', handleRichPaste, {
        capture: true,
      });
    };
  }, [editorMode, editorRootRef, onError, registry]);

  return null;
}

function PageNoteEditorStyleInjector() {
  if (GutenbergEditorStyles === undefined) {
    throw new Error('The Gutenberg editor style injector is unavailable.');
  }

  return <GutenbergEditorStyles styles={PAGE_NOTE_EDITOR_STYLES} />;
}

function focusLastEditableBlock(
  editorRoot: HTMLElement,
  event: ReactMouseEvent<HTMLDivElement>,
): void {
  if (
    event.button !== 0 ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey
  ) {
    return;
  }

  const target = event.target;
  if (
    !(target instanceof Element) ||
    !target.matches(BLANK_EDITOR_SPACE_SELECTOR) ||
    target.closest(INTERACTIVE_EDITOR_TARGET_SELECTOR) !== null
  ) {
    return;
  }

  const editables = editorRoot.querySelectorAll<HTMLElement>(
    '[contenteditable="true"]',
  );
  const editable = editables.item(editables.length - 1);
  if (editable === null) {
    return;
  }

  editable.focus({ preventScroll: true });
  const selection = editable.ownerDocument.defaultView?.getSelection();
  if (selection === undefined || selection === null) {
    return;
  }

  const range = editable.ownerDocument.createRange();
  range.selectNodeContents(editable);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

function PageNoteEditorRuntime({
  initialContentHtml,
  editorMode,
  onContentChange,
  onReady,
  onLoading,
  onError,
}: PageNoteEditorProps) {
  const [isLoaded, setIsLoaded] = useState(false);
  const [fatalLoadError, setFatalLoadError] = useState<Error | null>(null);
  const phaseRef = useRef<'idle' | 'loading' | 'ready'>('idle');
  const initialContentRef = useRef(initialContentHtml);
  const loadFailedRef = useRef(false);
  const loadingNotifiedRef = useRef(false);
  const readyNotifiedRef = useRef(false);
  const mutationVersionRef = useRef(0);
  const latestMutationVersionRef = useRef(0);
  const lastScheduledMutationVersionRef = useRef(0);
  const queuedMutationRef = useRef<SerializedMutation | null>(null);
  const lastSerializedMutationRef = useRef<string>();
  const editorRootRef = useRef<HTMLElement>(null);

  const reportError = useCallback(
    (error?: unknown) => {
      onError(normalizeEditorError(error));
    },
    [onError],
  );
  const forwardMutation = useCallback(
    (mutation: SerializedMutation) => {
      if (
        loadFailedRef.current ||
        lastScheduledMutationVersionRef.current >= mutation.version
      ) {
        return;
      }

      lastScheduledMutationVersionRef.current = mutation.version;

      if (phaseRef.current === 'ready') {
        onContentChange(mutation.contentHtml);
      } else {
        queuedMutationRef.current = mutation;
      }
    },
    [onContentChange],
  );

  const handleLoading = useCallback(() => {
    if (
      loadFailedRef.current ||
      loadingNotifiedRef.current ||
      readyNotifiedRef.current
    ) {
      return;
    }

    loadingNotifiedRef.current = true;
    phaseRef.current = 'loading';
    setIsLoaded(false);
    onLoading();
  }, [onLoading]);
  const handleReady = useCallback(() => {
    if (loadFailedRef.current || readyNotifiedRef.current) {
      return;
    }

    readyNotifiedRef.current = true;
    phaseRef.current = 'ready';
    setIsLoaded(true);
    onReady();

    const queuedMutation = queuedMutationRef.current;
    queuedMutationRef.current = null;
    if (queuedMutation !== null) {
      onContentChange(queuedMutation.contentHtml);
    }
  }, [onContentChange, onReady]);
  const failLoad = useCallback(
    (error: unknown): BlockValue[] => {
      const normalizedError = normalizeEditorError(error);
      loadFailedRef.current = true;
      queuedMutationRef.current = null;
      setIsLoaded(false);
      setFatalLoadError(normalizedError);
      onError(normalizedError);
      return [];
    },
    [onError],
  );
  const handleLoad = useCallback(
    (parse: ParseBlocks, rawHandler: HandleRawHtml): BlockValue[] => {
      const content = initialContentRef.current;

      try {
        const blocks =
          content.trim() === ''
            ? [makeBlock('core/paragraph')]
            : sanitizeBlocks(
                isSerializedGutenbergDocument(content)
                  ? parse(content)
                  : rawHandler({ HTML: content }),
                editorMode,
              );
        lastSerializedMutationRef.current = serialize(blocks);

        return blocks;
      } catch (error) {
        return failLoad(error);
      }
    },
    [editorMode, failLoad],
  );
  const handleSave = useCallback(
    (serializedContentHtml: unknown) => {
      const mutationVersion = latestMutationVersionRef.current;

      if (loadFailedRef.current) {
        return;
      }

      if (typeof serializedContentHtml !== 'string') {
        reportError(
          new Error('The editor returned content in an unsupported format.'),
        );

        return;
      }

      if (
        mutationVersion === 0 ||
        lastScheduledMutationVersionRef.current >= mutationVersion
      ) {
        return;
      }

      forwardMutation({
        version: mutationVersion,
        contentHtml: serializedContentHtml,
      });
    },
    [forwardMutation, reportError],
  );
  const handleEditorMutation = useCallback(
    (...values: unknown[]) => {
      if (loadFailedRef.current || hasInitialContentMarker(values)) {
        return;
      }

      const blocks = values[0];

      if (!Array.isArray(blocks)) {
        reportError(
          new Error('The editor returned an unsupported block mutation.'),
        );
        return;
      }

      try {
        // Keep Gutenberg's live blocks untouched so native selection and
        // history remain authoritative. Only the persistence projection is
        // rebuilt through PagePerch's local text schema.
        const contentHtml = serialize(sanitizeBlocks(blocks, editorMode));

        if (contentHtml === lastSerializedMutationRef.current) {
          return;
        }

        lastSerializedMutationRef.current = contentHtml;
        const mutationVersion = mutationVersionRef.current + 1;
        mutationVersionRef.current = mutationVersion;
        latestMutationVersionRef.current = mutationVersion;
        forwardMutation({
          version: mutationVersion,
          contentHtml,
        });
      } catch (error) {
        reportError(error);
      }
    },
    [editorMode, forwardMutation, reportError],
  );
  const handleCanvasClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      const editorRoot = editorRootRef.current;
      if (editorRoot !== null) {
        focusLastEditableBlock(editorRoot, event);
      }
    },
    [],
  );

  return (
    <section
      ref={editorRootRef}
      className="page-note-editor"
      aria-label="Page note editor"
      aria-busy={fatalLoadError === null && !isLoaded}
    >
      {fatalLoadError !== null ? (
        <p className="page-note-editor__error" role="alert">
          This note could not be opened safely. Editing is disabled to protect
          its stored content.
        </p>
      ) : null}
      {fatalLoadError === null ? (
        <div className="page-note-editor__canvas" onClick={handleCanvasClick}>
          <IsolatedBlockEditor
            className="page-note-editor__isolated"
            settings={buildPageNoteEditorCapabilities(editorMode)}
            onLoad={handleLoad}
            onSaveContent={handleSave}
            onError={reportError}
            __experimentalOnInput={handleEditorMutation}
            __experimentalOnChange={handleEditorMutation}
          >
            <PageNoteEditorStyleInjector />
            <EditorLoaded onLoading={handleLoading} onLoaded={handleReady} />
            <RichPasteBridge
              editorMode={editorMode}
              editorRootRef={editorRootRef}
              onError={reportError}
            />
          </IsolatedBlockEditor>
        </div>
      ) : null}
    </section>
  );
}

export function PageNoteEditor(props: PageNoteEditorProps) {
  // Gutenberg reads initial content only on mount. A private mode key guarantees
  // existing blocks are re-sanitized when the allowed schema changes.
  return <PageNoteEditorRuntime key={props.editorMode} {...props} />;
}
