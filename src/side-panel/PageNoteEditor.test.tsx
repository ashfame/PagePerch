import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { StrictMode, type ReactNode } from 'react';
import { act, render, screen } from '@testing-library/react';
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
  PageNoteEditor,
  buildPageNoteEditorCapabilities,
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
  readonly rawHandler: (options: { readonly HTML: string }) => TestBlock[];
}

const { createBlock, parse, rawHandler, serialize } =
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
        header: true,
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
          inserter: true,
          inspector: false,
          navigation: false,
          selectorTool: false,
          undo: true,
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
        fixedToolbar: true,
        hasFixedToolbar: true,
        hasPermissionsToManageWidgets: false,
        hasUploadPermissions: false,
        imageSizes: [],
        maxUploadFileSize: 0,
        reusableBlocks: [],
        richEditingEnabled: true,
        styles: [],
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

  it('loads empty content as no blocks without invoking either parser', () => {
    render(
      <PageNoteEditor {...createProps({ initialContentHtml: ' \n\t ' })} />,
    );
    const parse = vi.fn();
    const rawHandler = vi.fn();

    expect(capturedEditor().onLoad(parse, rawHandler)).toEqual([]);
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
        url: 'https://tracking.example/image.png',
        caption: '<strong>Visible caption</strong>',
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
        name: 'core/quote',
        innerBlocks: [
          {
            name: 'core/paragraph',
          },
        ],
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
        name: 'core/list',
        innerBlocks: [
          {
            name: 'core/list-item',
          },
        ],
      },
    ]);
    const serialized = serialize(sanitized);
    expect(serialized).toContain('Visible caption');
    expect(serialized).toContain('Recovered HTML text');
    expect(serialized).toContain('Nested embed caption');
    expect(serialized).toContain('Unsupported content was removed.');
    expect(serialized).not.toMatch(
      /core\/(?:image|embed|video|html)|tracking\.example/u,
    );
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
      expect(serialized).toContain('Unsupported content was removed.');
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
      /Heading text[\s\S]*First item[\s\S]*Second item[\s\S]*Unsupported content was removed\.[\s\S]*Classic text/u,
    );
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
    expect(screen.getByRole('status')).toHaveTextContent('Loading note editor');

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

  it('queues a first mutation through readiness and allows a later mutation with identical HTML', () => {
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
    expect(onContentChange).toHaveBeenCalledTimes(2);
    expect(onContentChange).toHaveBeenNthCalledWith(1, content);
    expect(onContentChange).toHaveBeenNthCalledWith(2, content);
  });

  it('renders an accessible locally described loading wrapper without save claims', () => {
    const { container } = render(<PageNoteEditor {...createProps()} />);
    const region = screen.getByRole('region', {
      name: 'Page note editor',
    });

    expect(region).toHaveAttribute('aria-busy', 'true');
    expect(region).toHaveAccessibleDescription(
      'Write a private note using the available local text blocks.',
    );
    expect(screen.getByRole('status')).toHaveTextContent('Loading note editor');
    expect(container).not.toHaveTextContent(/saved|saving|autosave/u);

    act(() => {
      capturedLoaded().onLoaded();
    });
    expect(region).toHaveAttribute('aria-busy', 'false');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(capturedEditor().className).toBe('page-note-editor__isolated');
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

describe('PageNoteEditor local theme contract', () => {
  it('defines local Gutenberg variables for light and dark themes with focus and reduced-motion rules', async () => {
    const css = await readFile(
      resolve(import.meta.dirname, 'PageNoteEditor.css'),
      'utf8',
    );
    const requiredVariables = [
      '--wp-admin-theme-color:',
      '--wp-admin-theme-color--rgb:',
      '--wp-components-color-accent:',
      '--wp-components-color-accent-inverted:',
      '--wp-components-color-background:',
      '--wp-components-color-foreground:',
      '--wp-components-color-foreground-inverted:',
      '--wp-editor-canvas-background:',
      '--wp-editor-background:',
      '--wp-editor-text-color:',
    ];

    for (const variable of requiredVariables) {
      expect(css.split(variable)).toHaveLength(3);
    }

    expect(css).toContain('@media (prefers-color-scheme: dark)');
    expect(css).toContain(':focus-visible');
    expect(css).toContain('@media (max-width: 320px)');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).not.toMatch(/url\(\s*['"]?https?:/u);

    const compactCss = css.replace(/\s+/gu, ' ');
    expect(compactCss).toContain(
      '.page-note-editor .page-note-editor__isolated.iso-editor .edit-post-visual-editor',
    );
    expect(compactCss).toContain(
      '.page-note-editor .page-note-editor__isolated.iso-editor .components-popover__content',
    );
    expect(compactCss).toContain(
      '.page-note-editor .page-note-editor__isolated.iso-editor .components-popover__triangle-bg',
    );
    expect(compactCss).toContain(
      '.page-note-editor .page-note-editor__isolated.iso-editor :where(input, select, textarea)',
    );
    expect(css).toContain('--wp-components-color-accent: #58b775');
    expect(css).toContain('--wp-components-color-accent-inverted: #101712');
    expect(contrastRatio('#58b775', '#101712')).toBeGreaterThanOrEqual(4.5);
  });
});

function contrastRatio(first: string, second: string): number {
  const luminance = (hex: string): number => {
    const channels = [1, 3, 5].map((start) => {
      const channel = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
      return channel <= 0.04045
        ? channel / 12.92
        : ((channel + 0.055) / 1.055) ** 2.4;
    });

    return (
      0.2126 * (channels[0] ?? 0) +
      0.7152 * (channels[1] ?? 0) +
      0.0722 * (channels[2] ?? 0)
    );
  };
  const lighter = Math.max(luminance(first), luminance(second));
  const darker = Math.min(luminance(first), luminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}
