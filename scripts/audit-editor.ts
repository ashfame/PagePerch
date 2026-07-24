import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { build } from 'vite';

import { mv3CompatibilityPlugin } from '../src/build/mv3Compatibility.ts';
import { auditBundle } from '../src/build/packageAudit.ts';

const projectRoot = resolve(import.meta.dirname, '..');
const outputDirectory = await mkdtemp(
  resolve(tmpdir(), 'pageperch-editor-smoke-'),
);
const keepOutput = process.env.PAGEPERCH_KEEP_EDITOR_SMOKE === '1';

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
      plugins: [mv3CompatibilityPlugin()],
      publicDir: false,
      resolve: {
        dedupe: ['@wordpress/block-editor'],
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
  if (editorStyles.length < 100_000) {
    throw new Error(
      'Editor smoke stylesheet is unexpectedly small; Gutenberg CSS may not have been emitted.',
    );
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
