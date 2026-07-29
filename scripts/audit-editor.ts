import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { build } from 'vite';

import {
  GUTENBERG_SINGLETON_PACKAGES,
  PAGEPERCH_GUTENBERG_PACKAGE_ALIASES,
  pagePerchGutenbergCompatibilityPlugin,
} from '../src/build/gutenbergCompatibility.ts';
import { mv3CompatibilityPlugin } from '../src/build/mv3Compatibility.ts';
import { auditBundle } from '../src/build/packageAudit.ts';
import {
  PAGEPERCH_CORE_BLOCK_NAMES,
  PAGEPERCH_RICH_TEXT_FORMAT_NAMES,
} from '../src/build/pagePerchGutenbergRegistry.ts';

const projectRoot = resolve(import.meta.dirname, '..');
const outputDirectory = await mkdtemp(
  resolve(tmpdir(), 'pageperch-editor-smoke-'),
);
const keepOutput = process.env.PAGEPERCH_KEEP_EDITOR_SMOKE === '1';
const editorStylesheetPath = resolve(
  projectRoot,
  'src/side-panel/PageNoteEditorCore.css',
);
const expectedEditorStylesheetImports = [
  '@wordpress/components/build-style/style.css',
  '@wordpress/block-editor/build-style/style.css',
  '@wordpress/format-library/build-style/style.css',
  '@wordpress/edit-post/build-style/style.css',
  '@wordpress/block-library/build-style/common.css',
  '@wordpress/block-library/build-style/editor-elements.css',
  '@wordpress/block-library/build-style/paragraph/style.css',
  '@wordpress/block-library/build-style/paragraph/editor.css',
  '@wordpress/block-library/build-style/heading/style.css',
  '@wordpress/block-library/build-style/list/style.css',
  '@wordpress/block-library/build-style/quote/style.css',
  '@wordpress/block-library/build-style/quote/theme.css',
  '@wordpress/block-library/build-style/code/style.css',
  '@wordpress/block-library/build-style/code/editor.css',
  '@wordpress/block-library/build-style/code/theme.css',
  '@wordpress/block-library/build-style/preformatted/style.css',
  '@wordpress/block-library/build-style/separator/style.css',
  '@wordpress/block-library/build-style/separator/editor.css',
  '@wordpress/block-library/build-style/separator/theme.css',
] as const;
const maximumEditorSmokeStylesheetBytes = 256 * 1024;
const requiredEditorStylesheetMarkers = [
  '.components-button',
  '.block-editor-block-list__layout',
  '.format-library__inline-color-popover',
  '.edit-post-visual-editor',
  '.wp-block-code',
  '.wp-block-list',
  '.wp-block-preformatted',
  '.wp-block-quote',
  '.wp-block-separator',
] as const;
const unsupportedBlockStylesheetMarkers = [
  '.wp-block-cover',
  '.wp-block-gallery',
  '.wp-block-image',
  '.wp-block-table',
] as const;

interface EditorBuildChunk {
  modules: Record<string, unknown>;
  type: 'chunk';
}

interface EditorBuildAsset {
  type: 'asset';
}

interface EditorBuildOutput {
  output: Array<EditorBuildAsset | EditorBuildChunk>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseBuildOutput(value: unknown): EditorBuildOutput {
  if (
    Array.isArray(value) ||
    !isRecord(value) ||
    !Array.isArray(value.output)
  ) {
    throw new Error('Editor smoke build returned an unexpected result.');
  }

  const output = value.output.map(
    (item): EditorBuildAsset | EditorBuildChunk => {
      if (!isRecord(item) || (item.type !== 'asset' && item.type !== 'chunk')) {
        throw new Error(
          'Editor smoke build returned an unexpected output item.',
        );
      }

      if (item.type === 'asset') {
        return { type: 'asset' };
      }

      if (!isRecord(item.modules)) {
        throw new Error(
          'Editor smoke build returned a chunk without module metadata.',
        );
      }

      return {
        modules: item.modules,
        type: 'chunk',
      };
    },
  );

  return { output };
}

try {
  const editorStylesheetSource = await readFile(editorStylesheetPath, 'utf8');
  const actualEditorStylesheetImports = [
    ...editorStylesheetSource.matchAll(
      /^@import\s+['"](?<path>[^'"]+)['"];\s*$/gmu,
    ),
  ].map((match) => match.groups?.path);
  if (
    actualEditorStylesheetImports.some((path) => path === undefined) ||
    JSON.stringify(actualEditorStylesheetImports) !==
      JSON.stringify(expectedEditorStylesheetImports)
  ) {
    throw new Error(
      `PagePerch editor stylesheet imports drifted: ${actualEditorStylesheetImports.join(', ')}.`,
    );
  }

  const buildOutput = parseBuildOutput(
    await build({
      build: {
        assetsInlineLimit: 0,
        chunkSizeWarningLimit: 7_000,
        cssCodeSplit: true,
        emptyOutDir: true,
        minify: 'oxc',
        outDir: outputDirectory,
        reportCompressedSize: false,
        rollupOptions: {
          input: resolve(projectRoot, 'src/build/editorSmoke.ts'),
          preserveEntrySignatures: 'strict',
          output: {
            assetFileNames: 'assets/editor-smoke[extname]',
            chunkFileNames: 'assets/[name].js',
            entryFileNames: 'editor-smoke.js',
          },
        },
        sourcemap: false,
        target: 'chrome114',
      },
      configFile: false,
      css: {
        preprocessorOptions: {
          scss: {
            silenceDeprecations: ['global-builtin', 'import'],
          },
        },
      },
      logLevel: 'warn',
      mode: 'production',
      plugins: [
        pagePerchGutenbergCompatibilityPlugin(),
        mv3CompatibilityPlugin(),
      ],
      publicDir: false,
      resolve: {
        alias: [...PAGEPERCH_GUTENBERG_PACKAGE_ALIASES],
        dedupe: [...GUTENBERG_SINGLETON_PACKAGES],
      },
      root: projectRoot,
    }),
  );

  const chunks = buildOutput.output.filter(
    (output): output is EditorBuildChunk => output.type === 'chunk',
  );
  const includesEditorModule = chunks.some((chunk) =>
    Object.keys(chunk.modules).some((modulePath) =>
      modulePath.includes(
        '/node_modules/@automattic/isolated-block-editor/build-module/',
      ),
    ),
  );

  if (!includesEditorModule) {
    throw new Error(
      'Editor smoke bundle did not include the isolated editor module entry.',
    );
  }

  const modulePaths = chunks.flatMap((chunk) => Object.keys(chunk.modules));
  const normalizedModulePaths = modulePaths.map((modulePath) =>
    modulePath.replaceAll('\\', '/').replace(/\?.*$/u, ''),
  );
  const includesBlockShim = normalizedModulePaths.some((modulePath) =>
    modulePath.endsWith('/src/build/pagePerchGutenbergBlockLibrary.ts'),
  );
  const includesFormatShim = normalizedModulePaths.some((modulePath) =>
    modulePath.endsWith('/src/build/pagePerchGutenbergFormatLibrary.ts'),
  );
  if (!includesBlockShim || !includesFormatShim) {
    throw new Error(
      'Editor smoke bundle did not include both PagePerch Gutenberg registry shims.',
    );
  }

  const fullRegistryEntries = [
    '/node_modules/@wordpress/block-library/build-module/index.js',
    '/node_modules/@wordpress/format-library/build-module/index.js',
  ];
  for (const registryEntry of fullRegistryEntries) {
    if (
      normalizedModulePaths.some((modulePath) =>
        modulePath.endsWith(registryEntry),
      )
    ) {
      throw new Error(
        `Editor smoke bundle unexpectedly included the full registry entry: ${registryEntry}`,
      );
    }
  }

  const includedBlockEntries = normalizedModulePaths.flatMap((modulePath) => {
    const match =
      /\/node_modules\/@wordpress\/block-library\/build-module\/([^/]+)\/index\.js$/u.exec(
        modulePath,
      );
    return match?.[1] === undefined ? [] : [`core/${match[1]}`];
  });
  const includedFormatEntries = normalizedModulePaths.flatMap((modulePath) => {
    const match =
      /\/node_modules\/@wordpress\/format-library\/build-module\/([^/]+)\/index\.js$/u.exec(
        modulePath,
      );
    return match?.[1] === undefined ? [] : [`core/${match[1]}`];
  });
  const exactSet = (values: readonly string[]): string[] =>
    [...new Set(values)].sort();
  if (
    JSON.stringify(exactSet(includedBlockEntries)) !==
    JSON.stringify(exactSet(PAGEPERCH_CORE_BLOCK_NAMES))
  ) {
    throw new Error(
      `Editor smoke block registry graph drifted: ${exactSet(includedBlockEntries).join(', ')}.`,
    );
  }
  if (
    JSON.stringify(exactSet(includedFormatEntries)) !==
    JSON.stringify(exactSet(PAGEPERCH_RICH_TEXT_FORMAT_NAMES))
  ) {
    throw new Error(
      `Editor smoke format registry graph drifted: ${exactSet(includedFormatEntries).join(', ')}.`,
    );
  }

  const entrySource = await readFile(
    resolve(outputDirectory, 'editor-smoke.js'),
    'utf8',
  );
  if (entrySource.length < 100_000) {
    throw new Error(
      'Editor smoke entry is unexpectedly small; the dependency may have been externalized or tree-shaken.',
    );
  }

  const editorStyles = await readFile(
    resolve(outputDirectory, 'assets/editor-smoke.css'),
    'utf8',
  );
  if (
    Buffer.byteLength(editorStyles, 'utf8') > maximumEditorSmokeStylesheetBytes
  ) {
    throw new Error(
      `Editor smoke stylesheet exceeds its ${String(maximumEditorSmokeStylesheetBytes)}-byte budget.`,
    );
  }
  for (const marker of requiredEditorStylesheetMarkers) {
    if (!editorStyles.includes(marker)) {
      throw new Error(
        `Editor smoke stylesheet is missing a required composition marker: ${marker}.`,
      );
    }
  }
  for (const marker of unsupportedBlockStylesheetMarkers) {
    if (editorStyles.includes(marker)) {
      throw new Error(
        `Editor smoke stylesheet contains an unsupported block marker: ${marker}.`,
      );
    }
  }

  const result = await auditBundle(outputDirectory);

  if (result.violations.length > 0) {
    for (const violation of result.violations) {
      console.error(`${violation.file}: ${violation.message}`);
    }

    process.exitCode = 1;
  } else {
    console.warn(
      `Isolated editor production/CSP smoke passed (${result.filesInspected} files inspected).`,
    );
  }
} finally {
  if (keepOutput) {
    console.warn(
      `Editor smoke output retained for inspection: ${outputDirectory}`,
    );
  } else {
    await rm(outputDirectory, { force: true, recursive: true });
  }
}
