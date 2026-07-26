import { StrictMode, type ReactNode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { initializeEditor as initializeEditorType } from '@automattic/isolated-block-editor';
import apiFetch from '@wordpress/api-fetch';
// @ts-expect-error WordPress ships declarations without exposing them in its package metadata.
import * as wordpressBlocks from '@wordpress/blocks';
import { RichTextData } from '@wordpress/rich-text';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const editorBoundary = vi.hoisted(
  (): { editorProps: unknown; loadedProps: unknown } => ({
    editorProps: undefined,
    loadedProps: undefined,
  }),
);

vi.mock('@automattic/isolated-block-editor', () => ({
  default: (props: { readonly children?: ReactNode }) => {
    editorBoundary.editorProps = props;

    return props.children ?? null;
  },
  EditorLoaded: (props: unknown) => {
    editorBoundary.loadedProps = props;

    return null;
  },
}));

import {
  adaptStructuredBlocksToRoot,
  convertClipboardHtmlToSafeBlocks,
  PageNoteEditor,
  buildPageNoteEditorCapabilities,
  isSerializedGutenbergDocument,
  type PageNoteEditorCapabilities,
  type PageNoteEditorProps,
} from './PageNoteEditor';

interface CapturedEditorProps {
  readonly className: string;
  readonly settings: PageNoteEditorCapabilities;
  readonly onLoad: (
    parse: (content: string) => unknown,
    rawHandler: (options: { readonly HTML: string }) => unknown,
  ) => TestBlock[];
  readonly onSaveContent: (content: unknown) => void;
  readonly onError: (error?: unknown) => void;
  readonly __experimentalOnInput: (...values: unknown[]) => void;
  readonly __experimentalOnChange: (...values: unknown[]) => void;
}

interface CapturedLoadedProps {
  readonly onLoaded: () => void;
  readonly onLoading: () => void;
}

interface TestBlock {
  readonly name: string;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly innerBlocks: readonly TestBlock[];
}

interface WordPressBlocksTestApi {
  readonly createBlock: (
    name: string,
    attributes?: Readonly<Record<string, unknown>>,
    innerBlocks?: readonly TestBlock[],
  ) => TestBlock;
  readonly serialize: (blocks: readonly TestBlock[]) => string;
  readonly parse: (content: string) => TestBlock[];
  readonly pasteHandler: (options: {
    readonly HTML: string;
    readonly plainText?: string;
    readonly mode?: 'AUTO' | 'BLOCKS' | 'INLINE';
  }) => TestBlock[] | string;
  readonly rawHandler: (options: { readonly HTML: string }) => TestBlock[];
}

const { createBlock, parse, pasteHandler, rawHandler, serialize } =
  wordpressBlocks as unknown as WordPressBlocksTestApi;

function testBlock(
  name: string,
  attributes: Readonly<Record<string, unknown>> = {},
  innerBlocks: readonly TestBlock[] = [],
): TestBlock {
  return { name, attributes, innerBlocks };
}

function capturedEditor(): CapturedEditorProps {
  if (editorBoundary.editorProps === undefined) {
    throw new Error('Expected isolated editor props to be captured.');
  }

  return editorBoundary.editorProps as CapturedEditorProps;
}

function capturedLoaded(): CapturedLoadedProps {
  if (editorBoundary.loadedProps === undefined) {
    throw new Error('Expected editor loading props to be captured.');
  }

  return editorBoundary.loadedProps as CapturedLoadedProps;
}

function createProps(
  overrides: Partial<PageNoteEditorProps> = {},
): PageNoteEditorProps {
  return {
    initialContentHtml: '',
    editorMode: 'text-focused-blocks',
    onContentChange: vi.fn(),
    onReady: vi.fn(),
    onLoading: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  };
}

function expectDeeplyFrozen(
  value: unknown,
  seen: Set<object> = new Set(),
): void {
  if (
    value === null ||
    (typeof value !== 'object' && typeof value !== 'function')
  ) {
    return;
  }

  if (seen.has(value)) {
    return;
  }

  seen.add(value);
  expect(Object.isFrozen(value)).toBe(true);

  for (const nested of Object.values(value)) {
    expectDeeplyFrozen(nested, seen);
  }
}

beforeAll(async () => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string): MediaQueryList => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    }),
    writable: true,
  });
  const actualEditor = await vi.importActual<{
    initializeEditor: typeof initializeEditorType;
  }>('@automattic/isolated-block-editor');
  actualEditor.initializeEditor();
});

beforeEach(() => {
  editorBoundary.editorProps = undefined;
  editorBoundary.loadedProps = undefined;
});

describe('buildPageNoteEditorCapabilities', () => {
  it('builds exact matching block allowlists for both editor modes', () => {
    const textFocused = buildPageNoteEditorCapabilities('text-focused-blocks');
    const paragraphsOnly = buildPageNoteEditorCapabilities('paragraphs-only');

    expect(textFocused.iso.blocks.allowBlocks).toEqual([
      'core/paragraph',
      'core/heading',
      'core/list',
      'core/list-item',
      'core/quote',
      'core/code',
      'core/preformatted',
      'core/separator',
    ]);
    expect(textFocused.editor.allowedBlockTypes).toEqual(
      textFocused.iso.blocks.allowBlocks,
    );
    expect(paragraphsOnly.iso.blocks.allowBlocks).toEqual(['core/paragraph']);
    expect(paragraphsOnly.editor.allowedBlockTypes).toEqual(
      paragraphsOnly.iso.blocks.allowBlocks,
    );
  });

  it('disables remote, persistence, media, pattern, inspector, and irrelevant editing capabilities', () => {
    const capabilities = buildPageNoteEditorCapabilities('text-focused-blocks');

    expect(capabilities).toMatchObject({
      iso: {
        allowApi: false,
        blocks: { disallowBlocks: [] },
        currentPattern: null,
        disableCanvasAnimations: true,
        footer: false,
        header: false,
        linkMenu: [],
        moreMenu: false,
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
        __experimentalFetchReusableBlocks: false,
        __experimentalReusableBlocks: [],
        allowedMimeTypes: [],
        autosaveInterval: 0,
        codeEditingEnabled: false,
        defaultEditorStyles: [],
        fixedToolbar: false,
        hasFixedToolbar: false,
        hasPermissionsToManageWidgets: false,
        hasUploadPermissions: false,
        imageSizes: [],
        maxUploadFileSize: 0,
        reusableBlocks: [],
        richEditingEnabled: true,
        template: null,
        templateLock: null,
      },
    });
    expect(capabilities.editor.fetchLinkSuggestions()).toEqual([]);
    expect(capabilities.editor.__experimentalFetchLinkSuggestions()).toEqual(
      [],
    );
    expect(capabilities.editor.allowedBlockTypes).not.toContain('core/embed');
  });

  it('returns deterministic deeply immutable capabilities', () => {
    const first = buildPageNoteEditorCapabilities('text-focused-blocks');
    const second = buildPageNoteEditorCapabilities('text-focused-blocks');
    const paragraphs = buildPageNoteEditorCapabilities('paragraphs-only');

    expect(second).toBe(first);
    expectDeeplyFrozen(first);
    expectDeeplyFrozen(paragraphs);
    expect(() => {
      (
        first.iso.toolbar as {
          undo: boolean;
        }
      ).undo = false;
    }).toThrow(TypeError);
    expect(() => {
      (first.iso.blocks.allowBlocks as string[]).push('core/image');
    }).toThrow(TypeError);
    expect(paragraphs.iso.blocks.allowBlocks).toEqual(['core/paragraph']);
  });
});

describe('PageNoteEditor loading contract', () => {
  it('adapts incompatible structured blocks to a nested list root without dropping text', () => {
    const paragraph = createBlock('core/paragraph', {
      content: 'Nested transformed text',
    });
    const adapted = adaptStructuredBlocksToRoot([paragraph], 'list-root', {
      canInsertBlockType: (blockName, rootClientId) =>
        rootClientId === 'list-root' && blockName === 'core/list-item',
      getBlockName: (clientId) =>
        clientId === 'list-root' ? 'core/list' : undefined,
    });

    expect(adapted).not.toBeNull();
    expect(adapted?.map((block) => block.name)).toEqual(['core/list-item']);
    expect(serialize(adapted ?? [])).toContain('Nested transformed text');
  });

  it('fails root adaptation without mutating or dropping incompatible content', () => {
    const paragraph = createBlock('core/paragraph', {
      content: 'Must remain available to native paste',
    });
    const getBlockName = vi.fn(() => undefined);

    expect(
      adaptStructuredBlocksToRoot([paragraph], 'unknown-root', {
        canInsertBlockType: () => false,
        getBlockName,
      }),
    ).toBeNull();
    expect(getBlockName).toHaveBeenCalledWith('unknown-root');
    expect(serialize([paragraph])).toContain(
      'Must remain available to native paste',
    );
  });

  it('uses the direct serialization parser to distinguish block documents from raw HTML', () => {
    expect(
      isSerializedGutenbergDocument(
        '<!-- wp:paragraph --><p>Hello</p><!-- /wp:paragraph -->',
      ),
    ).toBe(true);
    expect(
      isSerializedGutenbergDocument(
        '<!-- wp:quote --><blockquote><!-- wp:paragraph --><p>Nested</p><!-- /wp:paragraph --></blockquote><!-- /wp:quote -->',
      ),
    ).toBe(true);
    expect(isSerializedGutenbergDocument('<h2>Raw heading</h2>')).toBe(false);
    expect(
      isSerializedGutenbergDocument(
        '<p>A comment-like string: &lt;!-- wp:paragraph --&gt;</p>',
      ),
    ).toBe(false);
  });

  it('remounts its runtime and re-sanitizes initial content when editor mode changes', () => {
    const props = createProps({
      initialContentHtml:
        '<!-- wp:heading --><h2>Mode heading</h2><!-- /wp:heading -->',
    });
    const { rerender } = render(<PageNoteEditor {...props} />);
    const firstEditor = capturedEditor();
    const firstLoaded = capturedLoaded();
    const headingDocument = [
      testBlock('core/heading', {
        content: 'Mode heading',
        level: 2,
      }),
    ];

    expect(firstEditor.settings).toBe(
      buildPageNoteEditorCapabilities('text-focused-blocks'),
    );
    expect(
      serialize(firstEditor.onLoad(() => headingDocument, vi.fn())),
    ).toContain('<h2 class="wp-block-heading">Mode heading</h2>');
    act(() => {
      firstLoaded.onLoading();
      firstLoaded.onLoading();
      firstLoaded.onLoaded();
      firstLoaded.onLoaded();
    });
    expect(props.onLoading).toHaveBeenCalledOnce();
    expect(props.onReady).toHaveBeenCalledOnce();

    rerender(<PageNoteEditor {...props} editorMode="paragraphs-only" />);
    const secondEditor = capturedEditor();
    const secondLoaded = capturedLoaded();
    expect(secondEditor.settings).toBe(
      buildPageNoteEditorCapabilities('paragraphs-only'),
    );
    const paragraphsOnly = secondEditor.onLoad(() => headingDocument, vi.fn());
    expect(paragraphsOnly).toHaveLength(1);
    expect(paragraphsOnly[0]?.name).toBe('core/paragraph');
    expect(serialize(paragraphsOnly)).toContain('<p>Mode heading</p>');
    act(() => {
      secondLoaded.onLoading();
      secondLoaded.onLoading();
      secondLoaded.onLoaded();
      secondLoaded.onLoaded();
    });
    expect(props.onLoading).toHaveBeenCalledTimes(2);
    expect(props.onReady).toHaveBeenCalledTimes(2);
  });

  it('uses the provided Gutenberg parser when block comments exist', () => {
    const content = '<!-- wp:paragraph --><p>Hello</p><!-- /wp:paragraph -->';
    render(
      <PageNoteEditor {...createProps({ initialContentHtml: content })} />,
    );
    const parsed = [
      testBlock('core/paragraph', {
        content: 'Hello',
      }),
    ];
    const parse = vi.fn(() => parsed);
    const rawHandler = vi.fn(() => [{ name: 'raw' }]);

    const sanitized = capturedEditor().onLoad(parse, rawHandler);
    expect(sanitized).toMatchObject([
      {
        name: 'core/paragraph',
        innerBlocks: [],
      },
    ]);
    expect(serialize(sanitized)).toContain('<p>Hello</p>');
    expect(parse).toHaveBeenCalledWith(content);
    expect(rawHandler).not.toHaveBeenCalled();
  });

  it('uses the provided raw handler for genuinely raw HTML', () => {
    const content = '<p>Imported legacy note</p>';
    render(
      <PageNoteEditor {...createProps({ initialContentHtml: content })} />,
    );
    const rawBlocks = [
      testBlock('core/paragraph', {
        content: 'Imported legacy note',
      }),
    ];
    const parse = vi.fn(() => [{ name: 'parsed' }]);
    const rawHandler = vi.fn(() => rawBlocks);

    const sanitized = capturedEditor().onLoad(parse, rawHandler);
    expect(sanitized).toMatchObject([
      {
        name: 'core/paragraph',
        innerBlocks: [],
      },
    ]);
    expect(serialize(sanitized)).toContain('<p>Imported legacy note</p>');
    expect(rawHandler).toHaveBeenCalledWith({ HTML: content });
    expect(parse).not.toHaveBeenCalled();
  });

  it('projects genuine WordPress paste blocks through the safe text schema before persistence', () => {
    const onContentChange = vi.fn();
    render(<PageNoteEditor {...createProps({ onContentChange })} />);
    const editor = capturedEditor();
    editor.onLoad(vi.fn(), vi.fn());
    act(() => {
      capturedLoaded().onLoaded();
    });
    const externalHtml = [
      '<h2 class="source-heading" style="color: red" onclick="alert(1)">Pasted <em>heading</em></h2>',
      String.raw`<p class="source-copy" style="font-size: 99px">Body with <strong>bold</strong>, <em>emphasis</em>, a <a href="https://safe.example/path" style="color: red" onclick="alert(1)">safe link</a>, a <a href="javascript:alert(1)">script link</a>, a <a href="data:text/html,unsafe">data link</a>, a <a href="/\evil.example/path">backslash link</a>, and a <a href="//evil.example/path">protocol-relative link</a>.</p>`,
      '<ul class="source-list"><li>First item</li><li>Second <code>item</code></li></ul>',
      '<blockquote class="source-quote"><p>Quoted <b>text</b></p><cite>Safe citation</cite></blockquote>',
      '<pre class="source-code" style="position: fixed"><code>const safe = true;</code></pre>',
      '<script>window.pwned = true</script>',
      '<style>.source-copy { display: none }</style>',
      '<iframe src="https://unsafe.example/embed"></iframe>',
    ].join('');

    const converted = pasteHandler({
      HTML: externalHtml,
      plainText:
        'Pasted heading\nBody with bold, emphasis, and safe link.\nFirst item\nSecond item\nQuoted text\nSafe citation\nconst safe = true;',
      mode: 'BLOCKS',
    });

    expect(converted).not.toBeTypeOf('string');
    const blocks = converted as TestBlock[];
    expect(blocks.map((block) => block.name)).toEqual([
      'core/heading',
      'core/paragraph',
      'core/list',
      'core/quote',
      'core/code',
      'core/embed',
    ]);
    const nativeSerialized = serialize(blocks);
    expect(nativeSerialized).toMatch(/javascript:|data:text\/html/iu);
    expect(blocks[2]?.innerBlocks.map((block) => block.name)).toEqual([
      'core/list-item',
      'core/list-item',
    ]);

    act(() => {
      editor.__experimentalOnChange(blocks, {});
      editor.onSaveContent(nativeSerialized);
    });

    expect(onContentChange).toHaveBeenCalledOnce();
    const persisted = onContentChange.mock.calls[0]?.[0] as string;
    expect(persisted).toContain('<!-- wp:heading');
    expect(persisted).toContain('<!-- wp:list');
    expect(persisted).toContain('<!-- wp:quote');
    expect(persisted).toContain('<!-- wp:code');
    expect(persisted).toContain('<em>heading</em>');
    expect(persisted).toContain('<strong>bold</strong>');
    expect(persisted).toContain('<em>emphasis</em>');
    expect(persisted).toContain(
      '<a href="https://safe.example/path" rel="noopener noreferrer">safe link</a>',
    );
    expect(persisted).toContain('script link');
    expect(persisted).toContain('data link');
    expect(persisted).toContain('backslash link');
    expect(persisted).toContain('protocol-relative link');
    expect(persisted).toContain('Safe citation');
    expect(persisted).toContain('const safe = true;');
    expect(persisted).not.toMatch(
      /core\/embed|class="source-|style=|onclick=|<script|<style|<iframe|javascript:|data:text\/html|evil\.example|unsafe\.example|window\.pwned/iu,
    );
  });

  it('recovers unsupported clipboard structures from source HTML in visible order', () => {
    const html = [
      '<article>',
      '<table style="margin-left:80px" onclick="alert(1)">',
      '<caption>Clipboard caption</caption>',
      '<thead><tr><th>Clipboard heading</th></tr></thead>',
      '<tbody><tr><td>Clipboard first cell</td><td><strong>Clipboard second cell</strong></td></tr></tbody>',
      '<tfoot><tr><td>Clipboard footer</td></tr></tfoot>',
      '</table>',
      '<figure><img src="javascript:alert(1)" alt="Clipboard image alternative"><figcaption>Clipboard image caption</figcaption></figure>',
      '<template>Hidden template text</template>',
      '<style>.clipboard { color: red }</style>',
      '</article>',
    ].join('');

    const serialized = serialize(
      convertClipboardHtmlToSafeBlocks(
        html,
        'Clipboard caption Clipboard heading Clipboard first cell Clipboard second cell Clipboard footer Clipboard image alternative Clipboard image caption',
        'text-focused-blocks',
      ),
    );

    expect(serialized).toMatch(
      /Clipboard caption[\s\S]*Clipboard heading[\s\S]*Clipboard first cell[\s\S]*Clipboard second cell[\s\S]*Clipboard footer[\s\S]*Clipboard image alternative[\s\S]*Clipboard image caption/u,
    );
    expect(serialized).not.toMatch(
      /wp:(?:table|image)|Unsupported content was removed|style=|onclick=|javascript:|Hidden template text|\.clipboard/u,
    );
  });

  it('preserves repeated clipboard text occurrences instead of treating one match as complete', () => {
    const serialized = serialize(
      convertClipboardHtmlToSafeBlocks(
        '<p>Same<img src="https://tracking.example/image.png" alt="Same"></p>',
        'Same Same',
        'text-focused-blocks',
      ),
    );

    expect(serialized.match(/Same/gu)).toHaveLength(2);
    expect(serialized).not.toContain('tracking.example');
  });

  it('recovers mixed unsupported clipboard content in exact visible source order', () => {
    const serialized = serialize(
      convertClipboardHtmlToSafeBlocks(
        '<table><tbody><tr><td>before<p>middle</p>after</td></tr></tbody></table>',
        'before middle after',
        'text-focused-blocks',
      ),
    );

    expect(serialized).toMatch(/before[\s\S]*middle[\s\S]*after/u);
    for (const token of ['before', 'middle', 'after']) {
      expect(serialized.match(new RegExp(token, 'gu'))).toHaveLength(1);
    }
  });

  it('excludes explicitly concealed clipboard subtrees without guessing from class names', () => {
    const serialized = serialize(
      convertClipboardHtmlToSafeBlocks(
        [
          '<article>',
          '<p class="hidden">Ordinary class remains visible<span hidden>Nested hidden</span> and its visible tail</p>',
          '<p hidden>Hidden attribute</p>',
          '<p aria-hidden="true">ARIA hidden</p>',
          '<p style="display:none">Display hidden</p>',
          '<p style="visibility:hidden">Visibility hidden</p>',
          '<p style="content-visibility:hidden">Content visibility hidden</p>',
          '<div inert><p>Inert subtree</p></div>',
          '<noscript>Noscript subtree</noscript>',
          '</article>',
        ].join(''),
        'Ordinary class remains visible',
        'text-focused-blocks',
      ),
    );

    expect(serialized).toContain('Ordinary class remains visible');
    expect(serialized).toContain('and its visible tail');
    expect(serialized).not.toMatch(
      /Nested hidden|Hidden attribute|ARIA hidden|Display hidden|Visibility hidden|Content visibility hidden|Inert subtree|Noscript subtree/u,
    );
  });

  it('sanitizes block-delimited clipboard HTML that bypasses WordPress paste filtering', () => {
    const onContentChange = vi.fn();
    render(<PageNoteEditor {...createProps({ onContentChange })} />);
    const editor = capturedEditor();
    editor.onLoad(vi.fn(), vi.fn());
    act(() => {
      capturedLoaded().onLoaded();
    });
    const delimitedHtml = [
      '<!-- wp:paragraph {"className":"source-copy","style":{"color":{"text":"#ff0000"}}} -->',
      '<p class="source-copy" style="color: red" onclick="alert(1)">Delimited <strong>format</strong> with <a href="javascript:alert(1)" onclick="alert(1)">unsafe link</a> and <a href="https://safe.example/delimited" style="color: red">safe link</a><script>window.delimited = true</script></p>',
      '<!-- /wp:paragraph -->',
      '<!-- wp:html -->',
      '<iframe src="https://unsafe.example/frame"></iframe><p onclick="alert(1)">Recovered visible text</p>',
      '<!-- /wp:html -->',
    ].join('');
    const converted = pasteHandler({
      HTML: delimitedHtml,
      plainText:
        'Delimited format with unsafe link and safe link\nRecovered visible text',
      mode: 'BLOCKS',
    });

    expect(converted).not.toBeTypeOf('string');
    const blocks = converted as TestBlock[];
    expect(blocks.map((block) => block.name)).toEqual([
      'core/paragraph',
      'core/html',
    ]);
    const nativeSerialized = serialize(blocks);
    expect(nativeSerialized).toMatch(
      /source-copy|style=|onclick=|javascript:|<script|<iframe/iu,
    );

    act(() => {
      editor.__experimentalOnInput(blocks, {});
      editor.onSaveContent(nativeSerialized);
    });

    expect(onContentChange).toHaveBeenCalledOnce();
    const persisted = onContentChange.mock.calls[0]?.[0] as string;
    expect(persisted).toContain('<strong>format</strong>');
    expect(persisted).toContain('unsafe link');
    expect(persisted).toContain('Recovered visible text');
    expect(persisted).toContain(
      '<a href="https://safe.example/delimited" rel="noopener noreferrer">safe link</a>',
    );
    expect(persisted).not.toMatch(
      /core\/html|source-copy|style=|onclick=|javascript:|<script|<iframe|unsafe\.example|window\.delimited/iu,
    );
  });

  it('rejects backslash-obfuscated hrefs while preserving safe inline links and visible text', () => {
    render(
      <PageNoteEditor
        {...createProps({
          initialContentHtml: '<!-- wp:paragraph /-->',
        })}
      />,
    );
    const unsafeHrefs = [
      String.raw`/\evil.example/x`,
      String.raw`\\evil.example/x`,
      '/&#92;evil.example/x',
      'https://safe.example/&#x5c;@evil.example/x',
      '/&bsol;evil.example/x',
    ];

    unsafeHrefs.forEach((href, index) => {
      const label = `Unsafe link text ${index}`;
      const sanitized = capturedEditor().onLoad(
        () => [
          testBlock('core/paragraph', {
            content: `<a href="${href}">${label}</a>`,
          }),
        ],
        vi.fn(),
      );
      const serialized = serialize(sanitized);

      expect(serialized).toContain(label);
      expect(serialized).not.toContain('<a ');
      expect(serialized).not.toContain('evil.example');
    });

    const safeHrefs = [
      'https://safe.example/x',
      'mailto:person@example.com',
      'tel:+971555555555',
      '#note',
      '/notes/one',
      '?view=one',
      './one',
      '../one',
    ];

    safeHrefs.forEach((href, index) => {
      const label = `Safe link text ${index}`;
      const serialized = serialize(
        capturedEditor().onLoad(
          () => [
            testBlock('core/paragraph', {
              content: `<a href="${href}">${label}</a>`,
            }),
          ],
          vi.fn(),
        ),
      );

      expect(serialized).toContain(label);
      expect(serialized).toContain(
        `<a href="${href}" rel="noopener noreferrer">`,
      );
    });
  });

  it('loads empty content as one editable paragraph without invoking either parser', () => {
    render(
      <PageNoteEditor {...createProps({ initialContentHtml: ' \n\t ' })} />,
    );
    const parse = vi.fn();
    const rawHandler = vi.fn();
    const blocks = capturedEditor().onLoad(parse, rawHandler);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      name: 'core/paragraph',
      attributes: {},
      innerBlocks: [],
    });
    expect(parse).not.toHaveBeenCalled();
    expect(rawHandler).not.toHaveBeenCalled();
  });

  it('routes parser failures to the current error callback and safely loads no blocks', () => {
    const failure = new Error('parse failed');
    const onError = vi.fn();
    render(
      <PageNoteEditor
        {...createProps({
          initialContentHtml: '<!-- wp:paragraph --><p>Broken</p>',
          onError,
        })}
      />,
    );

    let loadedBlocks: object[] | undefined;
    act(() => {
      loadedBlocks = capturedEditor().onLoad(() => {
        throw failure;
      }, vi.fn());
    });

    expect(loadedBlocks).toEqual([]);
    expect(onError).toHaveBeenCalledWith(failure);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'This note could not be opened safely.',
    );
    expect(screen.queryByText('Loading note editor')).not.toBeInTheDocument();
  });

  it('converts forbidden stored blocks and unsafe nested blocks to local text-only blocks', () => {
    render(
      <PageNoteEditor
        {...createProps({
          initialContentHtml: '<!-- wp:image /-->',
        })}
      />,
    );
    const forbidden = [
      testBlock('core/image', {
        alt: 'Visible image alternative',
        url: 'https://tracking.example/image.png',
        caption: '<strong>Visible caption</strong>',
      }),
      testBlock('core/table', {
        head: [
          {
            cells: [{ content: '<strong>Visible table heading</strong>' }],
          },
        ],
        body: [
          {
            cells: [
              { content: 'Visible first cell' },
              { content: '<em>Visible second cell</em>' },
            ],
          },
        ],
        foot: [
          {
            cells: [{ content: 'Visible table footer' }],
          },
        ],
        caption: 'Visible table caption',
        style: {
          color: { text: 'expression(alert(1))' },
        },
      }),
      testBlock('custom/unsupported', {
        innerHTML:
          '<p>Visible inner HTML</p><template>Hidden template text</template><style>.leak { color: red }</style>',
        eventHandler: 'alert(1)',
      }),
      testBlock('core/html', {
        content:
          '<script src="https://tracking.example/x.js">hidden()</script><p>Recovered HTML text</p>',
      }),
      testBlock('core/paragraph', {
        content: '<iframe src="https://tracking.example/frame"></iframe>',
      }),
      testBlock('core/quote', {}, [
        testBlock('core/embed', {
          caption: 'Nested embed caption',
        }),
      ]),
      testBlock('core/quote'),
      testBlock('core/list', {}, [
        testBlock('core/video', {
          src: 'https://tracking.example/video.mp4',
        }),
      ]),
    ];

    const sanitized = capturedEditor().onLoad(() => forbidden, vi.fn());

    expect(sanitized).toMatchObject([
      {
        name: 'core/paragraph',
      },
      {
        name: 'core/paragraph',
      },
      {
        name: 'core/paragraph',
      },
      {
        name: 'core/paragraph',
      },
      {
        name: 'core/paragraph',
      },
      {
        name: 'core/paragraph',
      },
      {
        name: 'core/paragraph',
      },
      {
        name: 'core/paragraph',
      },
      {
        name: 'core/paragraph',
      },
      {
        name: 'core/paragraph',
      },
      {
        name: 'core/quote',
        innerBlocks: [
          {
            name: 'core/paragraph',
          },
        ],
      },
      {
        name: 'core/quote',
        innerBlocks: [],
      },
      {
        name: 'core/list',
        innerBlocks: [],
      },
    ]);
    const serialized = serialize(sanitized);
    expect(serialized).toMatch(
      /Visible image alternative[\s\S]*Visible caption[\s\S]*Visible table heading[\s\S]*Visible first cell[\s\S]*Visible second cell[\s\S]*Visible table footer[\s\S]*Visible table caption[\s\S]*Visible inner HTML[\s\S]*Recovered HTML text[\s\S]*Nested embed caption/u,
    );
    expect(serialized).toContain('Visible caption');
    expect(serialized).toContain('Recovered HTML text');
    expect(serialized).toContain('Nested embed caption');
    expect(serialized).not.toContain('Unsupported content was removed.');
    expect(serialized).not.toMatch(
      /core\/(?:image|embed|video|html|table)|tracking\.example|Hidden template text|expression|alert\(1\)|\.leak/u,
    );
  });

  it('fails closed on malformed unsafe stored HTML while preserving preceding safe text', () => {
    render(
      <PageNoteEditor
        {...createProps({
          initialContentHtml: '<!-- wp:paragraph /-->',
        })}
      />,
    );

    const sanitized = capturedEditor().onLoad(
      () => [
        testBlock('custom/template', {
          content:
            '<strong>Safe template prefix</strong><template>Hidden template remainder',
        }),
        testBlock('core/paragraph', {
          content: '<em>Safe script prefix</em><script>Hidden script remainder',
        }),
      ],
      vi.fn(),
    );
    const serialized = serialize(sanitized);

    expect(serialized).toContain('Safe template prefix');
    expect(serialized).toContain('Safe script prefix');
    expect(serialized).not.toMatch(
      /Hidden template remainder|Hidden script remainder|<template|<script/u,
    );
  });

  it('retains genuine repeated text from parent and nested stored block provenance', () => {
    render(
      <PageNoteEditor
        {...createProps({
          initialContentHtml: '<!-- wp:paragraph /-->',
        })}
      />,
    );

    const sanitized = capturedEditor().onLoad(
      () => [
        testBlock('custom/parent', { content: 'Repeated occurrence' }, [
          testBlock('custom/child', { content: 'Repeated occurrence' }),
        ]),
      ],
      vi.fn(),
    );
    const serialized = serialize(sanitized);

    expect(serialized.match(/Repeated occurrence/gu)).toHaveLength(2);
  });

  it('flattens malformed paragraph children safely in both editor modes', () => {
    const props = createProps({
      initialContentHtml: '<!-- wp:paragraph /-->',
    });
    const { rerender } = render(<PageNoteEditor {...props} />);
    const malformedParagraph = [
      testBlock('core/paragraph', { content: 'Parent text' }, [
        testBlock('core/image', {
          caption: '<strong>Nested visible text</strong>',
          url: 'https://tracking.example/image.png',
        }),
        testBlock('core/embed', {
          url: 'https://tracking.example/embed',
        }),
      ]),
    ];

    const assertSafeFlattenedParagraph = (blocks: readonly TestBlock[]) => {
      expect(blocks).toHaveLength(1);
      expect(blocks[0]?.name).toBe('core/paragraph');
      expect(blocks[0]?.innerBlocks).toEqual([]);
      const serialized = serialize(blocks);
      expect(serialized).toContain('Parent text');
      expect(serialized).toContain('Nested visible text');
      expect(serialized).not.toContain('Unsupported content was removed.');
      expect(serialized).not.toMatch(
        /core\/(?:image|embed)|tracking\.example/u,
      );
    };

    assertSafeFlattenedParagraph(
      capturedEditor().onLoad(() => malformedParagraph, vi.fn()),
    );

    rerender(<PageNoteEditor {...props} editorMode="paragraphs-only" />);
    assertSafeFlattenedParagraph(
      capturedEditor().onLoad(() => malformedParagraph, vi.fn()),
    );
  });

  it('converts prior text-focused documents to paragraphs-only without dropping visible text', () => {
    render(
      <PageNoteEditor
        {...createProps({
          initialContentHtml: '<!-- wp:heading /-->',
          editorMode: 'paragraphs-only',
        })}
      />,
    );
    const priorDocument = [
      testBlock('core/heading', { content: '<em>Heading text</em>' }),
      testBlock('core/list', {}, [
        testBlock('core/list-item', { content: 'First item' }),
        testBlock('core/list-item', { content: 'Second item' }),
      ]),
      testBlock('core/separator'),
      testBlock('core/freeform', {
        content: '<p>Classic text</p><img src="https://tracking.example/x">',
      }),
    ];

    const sanitized = capturedEditor().onLoad(() => priorDocument, vi.fn());

    expect(sanitized.every((block) => block.name === 'core/paragraph')).toBe(
      true,
    );
    expect(sanitized.every((block) => block.innerBlocks.length === 0)).toBe(
      true,
    );
    const serialized = serialize(sanitized);
    expect(serialized).toMatch(
      /Heading text[\s\S]*First item[\s\S]*Second item[\s\S]*Classic text/u,
    );
    expect(serialized).not.toContain('Unsupported content was removed.');
    expect(serialized).not.toContain('tracking.example');
  });

  it('preserves an allowed empty paragraph in paragraphs-only mode as a clear state', () => {
    render(
      <PageNoteEditor
        {...createProps({
          initialContentHtml:
            '<!-- wp:paragraph --><p></p><!-- /wp:paragraph -->',
          editorMode: 'paragraphs-only',
        })}
      />,
    );

    const sanitized = capturedEditor().onLoad(
      () => [testBlock('core/paragraph', { content: '' })],
      vi.fn(),
    );

    expect(sanitized).toHaveLength(1);
    expect(sanitized[0]?.name).toBe('core/paragraph');
    expect(sanitized[0]?.innerBlocks).toEqual([]);
    expect(serialize(sanitized)).not.toContain(
      'Unsupported content was removed.',
    );
  });

  it('fails closed when a parser returns a malformed recursive block contract', () => {
    const onContentChange = vi.fn();
    const onReady = vi.fn();
    const onError = vi.fn();
    render(
      <PageNoteEditor
        {...createProps({
          initialContentHtml: '<!-- wp:paragraph /-->',
          onContentChange,
          onReady,
          onError,
        })}
      />,
    );
    const editor = capturedEditor();
    const loaded = capturedLoaded();

    act(() => {
      expect(
        editor.onLoad(
          () => [
            {
              name: 'core/paragraph',
              attributes: { content: 'unsafe' },
              innerBlocks: 'not-an-array',
            },
          ],
          vi.fn(),
        ),
      ).toEqual([]);
      loaded.onLoaded();
      editor.__experimentalOnChange(
        [createBlock('core/paragraph', { content: 'overwrite' })],
        {},
      );
      editor.onSaveContent('overwrite');
    });

    expect(onError).toHaveBeenCalledOnce();
    expect(onReady).not.toHaveBeenCalled();
    expect(onContentChange).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Editing is disabled to protect its stored content.',
    );
  });
});

describe('PageNoteEditor lifecycle and save contract', () => {
  it.each([
    [
      'input then change before ready with save interleaving',
      (
        editor: CapturedEditorProps,
        loaded: CapturedLoadedProps,
        initialBlocks: readonly TestBlock[],
        initialContent: string,
      ) => {
        editor.__experimentalOnInput(initialBlocks, {});
        editor.onSaveContent(initialContent);
        editor.__experimentalOnChange(initialBlocks, {});
        loaded.onLoaded();
      },
    ],
    [
      'change then input after ready with a marker first',
      (
        editor: CapturedEditorProps,
        loaded: CapturedLoadedProps,
        initialBlocks: readonly TestBlock[],
        initialContent: string,
      ) => {
        editor.__experimentalOnInput(initialBlocks, {
          isInitialContent: true,
        });
        loaded.onLoaded();
        editor.__experimentalOnChange(initialBlocks, {});
        editor.onSaveContent(initialContent);
        editor.__experimentalOnInput(initialBlocks, {});
      },
    ],
    [
      'an initial marker between unmarked callbacks',
      (
        editor: CapturedEditorProps,
        loaded: CapturedLoadedProps,
        initialBlocks: readonly TestBlock[],
        initialContent: string,
      ) => {
        editor.__experimentalOnInput(initialBlocks, {});
        editor.__experimentalOnChange(initialBlocks, {
          isInitialContent: true,
        });
        editor.onSaveContent(initialContent);
        loaded.onLoaded();
        editor.__experimentalOnChange(initialBlocks, {});
      },
    ],
    [
      'an initial marker after ready and unmarked callbacks',
      (
        editor: CapturedEditorProps,
        loaded: CapturedLoadedProps,
        initialBlocks: readonly TestBlock[],
        initialContent: string,
      ) => {
        loaded.onLoaded();
        editor.__experimentalOnChange(initialBlocks, {});
        editor.onSaveContent(initialContent);
        editor.__experimentalOnInput(initialBlocks, {});
        editor.__experimentalOnChange(initialBlocks, {
          isInitialContent: true,
        });
      },
    ],
  ] as const)(
    'suppresses blank initialization for %s until the first genuine edit',
    (_label, initialize) => {
      const onContentChange = vi.fn();
      render(<PageNoteEditor {...createProps({ onContentChange })} />);
      const editor = capturedEditor();
      const loaded = capturedLoaded();
      const initialBlocks = editor.onLoad(vi.fn(), vi.fn());
      const initialContent = serialize(initialBlocks);

      act(() => {
        initialize(editor, loaded, initialBlocks, initialContent);
      });
      expect(onContentChange).not.toHaveBeenCalled();

      const editedBlocks = [
        createBlock('core/paragraph', {
          content: 'First real edit',
        }),
      ];
      const editedContent = serialize(editedBlocks);
      act(() => {
        loaded.onLoaded();
        editor.__experimentalOnInput(editedBlocks, {});
        editor.__experimentalOnChange(editedBlocks, {});
        editor.onSaveContent(editedContent);
      });

      expect(onContentChange).toHaveBeenCalledOnce();
      expect(onContentChange).toHaveBeenCalledWith(editedContent);
    },
  );

  it('suppresses initialization saves, de-duplicates loading/ready phases, and forwards post-ready strings', () => {
    const onContentChange = vi.fn();
    const onLoading = vi.fn();
    const onReady = vi.fn();
    render(
      <PageNoteEditor
        {...createProps({ onContentChange, onLoading, onReady })}
      />,
    );
    const editor = capturedEditor();
    const loaded = capturedLoaded();

    act(() => {
      editor.onSaveContent('initial editor serialization');
      loaded.onLoading();
      loaded.onLoading();
      editor.onSaveContent('initial loading serialization');
    });
    expect(onContentChange).not.toHaveBeenCalled();
    expect(onLoading).toHaveBeenCalledOnce();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    const savedBlocks = [
      createBlock('core/paragraph', {
        content: 'Saved',
      }),
    ];
    const savedContent = serialize(savedBlocks);
    act(() => {
      loaded.onLoaded();
      loaded.onLoaded();
      editor.__experimentalOnInput(savedBlocks, {});
      editor.onSaveContent(savedContent);
    });
    expect(onReady).toHaveBeenCalledOnce();
    expect(onContentChange).toHaveBeenCalledOnce();
    expect(onContentChange).toHaveBeenCalledWith(savedContent);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('routes editor errors and invalid serialized values defensively', () => {
    const onError = vi.fn();
    render(<PageNoteEditor {...createProps({ onError })} />);
    const failure = new Error('editor failed');

    act(() => {
      capturedEditor().onError(failure);
      capturedEditor().onError('string failure');
      capturedLoaded().onLoaded();
      capturedEditor().__experimentalOnChange('not a block array');
      capturedEditor().onSaveContent({ invalid: true });
    });

    expect(onError.mock.calls[0]?.[0]).toBe(failure);
    expect(onError.mock.calls[1]?.[0]).toEqual(new Error('string failure'));
    expect(onError.mock.calls[2]?.[0]).toEqual(
      new Error('The editor returned an unsupported block mutation.'),
    );
    expect(onError.mock.calls[3]?.[0]).toEqual(
      new Error('The editor returned content in an unsupported format.'),
    );
  });

  it('does not let a raw save string bypass a rejected non-block mutation', () => {
    const onContentChange = vi.fn();
    const onError = vi.fn();
    render(
      <PageNoteEditor
        {...createProps({
          onContentChange,
          onError,
        })}
      />,
    );
    const editor = capturedEditor();
    editor.onLoad(vi.fn(), vi.fn());

    act(() => {
      capturedLoaded().onLoaded();
      editor.__experimentalOnChange('not a block array');
      editor.onSaveContent(
        '<!-- wp:paragraph --><p onclick="alert(1)"><a href="javascript:alert(1)">unsafe raw save</a></p><!-- /wp:paragraph -->',
      );
    });

    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(
      new Error('The editor returned an unsupported block mutation.'),
    );
    expect(onContentChange).not.toHaveBeenCalled();
  });

  it('uses replacement callbacks during child commits while latching mounted initial content', () => {
    const original = createProps();
    const replacement = createProps({
      initialContentHtml: '<p>Replacement content</p>',
    });
    const { rerender } = render(<PageNoteEditor {...original} />);

    rerender(<PageNoteEditor {...replacement} />);
    const editor = capturedEditor();
    const loaded = capturedLoaded();
    const rawHandler = vi.fn(() => []);
    const replacementBlocks = [
      createBlock('core/paragraph', {
        content: 'Replacement save',
      }),
    ];
    const replacementContent = serialize(replacementBlocks);
    act(() => {
      loaded.onLoading();
      loaded.onLoaded();
      editor.__experimentalOnChange(replacementBlocks, {});
      editor.onSaveContent(replacementContent);
      editor.onError(new Error('replacement error'));
    });
    editor.onLoad(vi.fn(), rawHandler);

    expect(original.onLoading).not.toHaveBeenCalled();
    expect(original.onReady).not.toHaveBeenCalled();
    expect(original.onContentChange).not.toHaveBeenCalled();
    expect(original.onError).not.toHaveBeenCalled();
    expect(replacement.onLoading).toHaveBeenCalledOnce();
    expect(replacement.onReady).toHaveBeenCalledOnce();
    expect(replacement.onContentChange).toHaveBeenCalledWith(
      replacementContent,
    );
    expect(replacement.onError).toHaveBeenCalledWith(
      new Error('replacement error'),
    );
    expect(rawHandler).not.toHaveBeenCalled();
  });

  it('loads changed initial content only after a keyed remount', () => {
    const firstProps = createProps({
      initialContentHtml: '<p>First note</p>',
    });
    const secondProps = createProps({
      initialContentHtml: '<p>Second note</p>',
    });
    const { rerender } = render(
      <PageNoteEditor key="first-note" {...firstProps} />,
    );
    const firstRawHandler = vi.fn(() => [
      testBlock('core/paragraph', { content: 'First note' }),
    ]);

    capturedEditor().onLoad(vi.fn(), firstRawHandler);
    expect(firstRawHandler).toHaveBeenCalledWith({ HTML: '<p>First note</p>' });

    rerender(<PageNoteEditor key="second-note" {...secondProps} />);
    const secondRawHandler = vi.fn(() => [
      testBlock('core/paragraph', { content: 'Second note' }),
    ]);
    capturedEditor().onLoad(vi.fn(), secondRawHandler);

    expect(secondRawHandler).toHaveBeenCalledWith({
      HTML: '<p>Second note</p>',
    });
  });

  it('does not duplicate user lifecycle callbacks under StrictMode', () => {
    const props = createProps();
    render(
      <StrictMode>
        <PageNoteEditor {...props} />
      </StrictMode>,
    );
    const editor = capturedEditor();
    const loaded = capturedLoaded();
    const changedBlocks = [
      createBlock('core/paragraph', {
        content: 'Strict user change',
      }),
    ];
    const changedContent = serialize(changedBlocks);

    act(() => {
      loaded.onLoading();
      loaded.onLoading();
      editor.onSaveContent('strict initialization');
      loaded.onLoaded();
      loaded.onLoaded();
      editor.__experimentalOnInput(changedBlocks, {});
      editor.onSaveContent(changedContent);
    });

    expect(props.onLoading).toHaveBeenCalledOnce();
    expect(props.onReady).toHaveBeenCalledOnce();
    expect(props.onContentChange).toHaveBeenCalledOnce();
    expect(props.onContentChange).toHaveBeenCalledWith(changedContent);
  });

  it('suppresses initial blocks and serializes the first one-block edit when ready arrives first', () => {
    const onContentChange = vi.fn();
    const props = createProps({ onContentChange });
    render(<PageNoteEditor {...props} />);
    const editor = capturedEditor();
    const loaded = capturedLoaded();

    act(() => {
      loaded.onLoaded();
      loaded.onLoading();
      editor.__experimentalOnInput([], { isInitialContent: true });
      editor.onSaveContent(
        '<!-- wp:paragraph --><p>Initial</p><!-- /wp:paragraph -->',
      );
    });
    expect(onContentChange).not.toHaveBeenCalled();
    expect(props.onLoading).not.toHaveBeenCalled();

    const editedBlocks = [
      createBlock('core/paragraph', {
        content: 'User edit',
      }),
    ];
    const editedContent = serialize(editedBlocks);
    act(() => {
      editor.__experimentalOnChange(editedBlocks, {});
      editor.onSaveContent(editedContent);
    });
    expect(onContentChange).toHaveBeenCalledOnce();
    expect(onContentChange).toHaveBeenCalledWith(editedContent);
    expect(editedContent).toBe(
      '<!-- wp:paragraph -->\n<p>User edit</p>\n<!-- /wp:paragraph -->',
    );
  });

  it('accepts only genuine parser rich text, sanitizes it, and ignores spoof conversion methods during hydration', () => {
    const onContentChange = vi.fn();
    const initialContent =
      '<!-- wp:paragraph -->\n<p>Persisted <strong>safe text</strong> <a href="javascript:alert(1)">unsafe link</a><script>unsafe element</script> <a href="https://safe.example/path">safe link</a></p>\n<!-- /wp:paragraph -->';
    render(
      <PageNoteEditor
        {...createProps({
          initialContentHtml: initialContent,
          onContentChange,
        })}
      />,
    );
    const rawParsed = parse(initialContent);
    expect(rawParsed[0]?.attributes.content).toBeInstanceOf(RichTextData);
    let hydratedBlocks: readonly TestBlock[] = [];

    act(() => {
      hydratedBlocks = capturedEditor().onLoad(parse, rawHandler);
    });

    const hydratedContent = serialize(hydratedBlocks);
    expect(hydratedContent).toContain('<strong>safe text</strong>');
    expect(hydratedContent).toContain('unsafe link');
    expect(hydratedContent).toContain(
      '<a href="https://safe.example/path" rel="noopener noreferrer">safe link</a>',
    );
    expect(hydratedContent).not.toMatch(/javascript:|<script|unsafe element/iu);

    act(() => {
      capturedEditor().__experimentalOnInput(hydratedBlocks, {
        isInitialContent: true,
      });
      capturedLoaded().onLoaded();
    });

    expect(onContentChange).not.toHaveBeenCalled();

    const toHTMLString = vi.fn(() => '<strong>Spoofed content</strong>');
    const spoofParser = vi.fn(() => [
      testBlock('core/paragraph', {
        content: { toHTMLString },
      }),
    ]);
    let spoofedBlocks: readonly TestBlock[] = [];

    act(() => {
      spoofedBlocks = capturedEditor().onLoad(spoofParser, rawHandler);
    });

    expect(toHTMLString).not.toHaveBeenCalled();
    expect(serialize(spoofedBlocks)).not.toContain('Spoofed content');
  });

  it('queues the latest pre-ready mutation and ignores later callbacks with identical HTML', () => {
    const onContentChange = vi.fn();
    render(<PageNoteEditor {...createProps({ onContentChange })} />);
    const editor = capturedEditor();
    const blocks = [
      createBlock('core/paragraph', {
        content: 'Same serialization',
      }),
    ];
    const content = serialize(blocks);
    const supersededBlocks = [
      createBlock('core/paragraph', {
        content: 'Superseded pre-ready draft',
      }),
    ];

    act(() => {
      editor.__experimentalOnInput(supersededBlocks, {});
      editor.__experimentalOnInput(blocks, {});
      editor.onSaveContent(content);
      editor.onSaveContent(content);
    });
    expect(onContentChange).not.toHaveBeenCalled();

    act(() => {
      capturedLoaded().onLoaded();
    });
    expect(onContentChange).toHaveBeenCalledOnce();

    act(() => {
      editor.__experimentalOnChange(blocks, {});
      editor.onSaveContent(content);
    });
    expect(onContentChange).toHaveBeenCalledOnce();
    expect(onContentChange).toHaveBeenNthCalledWith(1, content);

    const changedBlocks = [
      createBlock('core/paragraph', {
        content: 'Actually changed serialization',
      }),
    ];
    const changedContent = serialize(changedBlocks);
    act(() => {
      editor.__experimentalOnChange(changedBlocks, {});
      editor.onSaveContent(changedContent);
    });
    expect(onContentChange).toHaveBeenCalledTimes(2);
    expect(onContentChange).toHaveBeenNthCalledWith(2, changedContent);
  });

  it('renders an accessible control-free loading wrapper without visible loading or save claims', () => {
    const { container } = render(<PageNoteEditor {...createProps()} />);
    const region = screen.getByRole('region', {
      name: 'Page note editor',
    });

    expect(region).toHaveAttribute('aria-busy', 'true');
    expect(region).not.toHaveAccessibleDescription();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(container).not.toHaveTextContent(/saved|saving|autosave/u);

    act(() => {
      capturedLoaded().onLoaded();
    });
    expect(region).toHaveAttribute('aria-busy', 'false');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('focuses the final editable at its end when blank canvas space is clicked', () => {
    const { container } = render(<PageNoteEditor {...createProps()} />);
    const canvas = container.querySelector('.page-note-editor__canvas');

    if (!(canvas instanceof HTMLDivElement)) {
      throw new Error('Expected the PagePerch editor canvas.');
    }

    const firstEditable = document.createElement('p');
    firstEditable.setAttribute('contenteditable', 'true');
    firstEditable.textContent = 'First block';
    const finalEditable = document.createElement('p');
    finalEditable.setAttribute('contenteditable', 'true');
    finalEditable.textContent = 'Final block';
    canvas.append(firstEditable, finalEditable);

    fireEvent.click(canvas, { button: 0 });

    expect(finalEditable).toHaveFocus();
    const selection = window.getSelection();
    expect(selection).not.toBeNull();
    expect(selection?.rangeCount).toBe(1);
    const range = selection?.getRangeAt(0);
    expect(range?.collapsed).toBe(true);
    expect(range?.startContainer).toBe(finalEditable);
    expect(range?.startOffset).toBe(finalEditable.childNodes.length);
  });

  it('does not steal modified or interactive editor clicks', () => {
    const { container } = render(<PageNoteEditor {...createProps()} />);
    const canvas = container.querySelector('.page-note-editor__canvas');

    if (!(canvas instanceof HTMLDivElement)) {
      throw new Error('Expected the PagePerch editor canvas.');
    }

    const firstEditable = document.createElement('p');
    firstEditable.setAttribute('contenteditable', 'true');
    firstEditable.tabIndex = 0;
    const finalEditable = document.createElement('p');
    finalEditable.setAttribute('contenteditable', 'true');
    finalEditable.tabIndex = 0;
    const link = document.createElement('a');
    link.href = 'https://example.test/';
    link.textContent = 'Interactive link';
    link.addEventListener('click', (event) => {
      event.preventDefault();
    });
    canvas.append(firstEditable, finalEditable, link);

    firstEditable.focus();
    fireEvent.click(canvas, { button: 0, ctrlKey: true });
    expect(firstEditable).toHaveFocus();

    fireEvent.click(firstEditable, { button: 0 });
    expect(firstEditable).toHaveFocus();

    link.focus();
    fireEvent.click(link, { button: 0 });
    expect(link).toHaveFocus();
  });
});

describe('PageNoteEditor local WordPress API boundary', () => {
  it('serves known preloads locally then rejects unknown requests without window.fetch', async () => {
    const originalFetchDescriptor = Object.getOwnPropertyDescriptor(
      window,
      'fetch',
    );
    const fetchSpy = vi.fn();
    Object.defineProperty(window, 'fetch', {
      configurable: true,
      value: fetchSpy,
      writable: true,
    });

    try {
      const preloadPath = '/wp/v2/pageperch-known-preload';
      apiFetch.use(
        apiFetch.createPreloadingMiddleware({
          [preloadPath]: {
            body: { source: 'local-preload' },
            headers: {},
          },
        }),
      );
      await expect(
        apiFetch<{ source: string }>({ path: preloadPath }),
      ).resolves.toEqual({
        source: 'local-preload',
      });

      const rejection: unknown = await apiFetch<unknown>({
        path: '/wp/v2/pageperch-unknown',
      }).then(
        () => null,
        (error: unknown) => error,
      );

      expect(rejection).toBeInstanceOf(Error);
      expect(rejection).toHaveProperty('code', 'pageperch_local_only');
      expect((rejection as Error).message).toContain(
        'blocks an unhandled WordPress API request',
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      if (originalFetchDescriptor === undefined) {
        Reflect.deleteProperty(window, 'fetch');
      } else {
        Object.defineProperty(window, 'fetch', originalFetchDescriptor);
      }
    }
  });
});
