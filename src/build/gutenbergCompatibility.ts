import { resolve } from 'node:path';

import type { Alias, Plugin } from 'vite';

export const GUTENBERG_SINGLETON_PACKAGES = [
  '@wordpress/block-editor',
  '@wordpress/commands',
  '@wordpress/core-data',
  '@wordpress/data',
  '@wordpress/dataviews',
  '@wordpress/patterns',
  '@wordpress/preferences',
] as const;

const buildDirectory = import.meta.dirname;

export const PAGEPERCH_GUTENBERG_PACKAGE_ALIASES = [
  {
    find: /^@wordpress\/block-library$/u,
    replacement: resolve(buildDirectory, 'pagePerchGutenbergBlockLibrary.ts'),
  },
  {
    find: /^@wordpress\/format-library$/u,
    replacement: resolve(buildDirectory, 'pagePerchGutenbergFormatLibrary.ts'),
  },
] as const satisfies readonly Alias[];

const isolatedEditorEntryPath =
  '/node_modules/@automattic/isolated-block-editor/build-module/index.js';
const expectedRegistryImports = [
  "import { registerCoreBlocks } from '@wordpress/block-library';",
  "import '@wordpress/format-library';",
] as const;

function exactOccurrenceCount(source: string, pattern: string): number {
  return source.split(pattern).length - 1;
}

export function assertIsolatedEditorRegistryImports(
  source: string,
  modulePath: string,
): void {
  const normalizedPath = modulePath.replaceAll('\\', '/').split('?', 1)[0];
  if (!normalizedPath?.endsWith(isolatedEditorEntryPath)) {
    return;
  }

  for (const expectedImport of expectedRegistryImports) {
    const occurrences = exactOccurrenceCount(source, expectedImport);
    if (occurrences !== 1) {
      throw new Error(
        `PagePerch expected exactly one pinned isolated-editor registry import in ${normalizedPath}, but found ${String(occurrences)}.`,
      );
    }
  }
}

export function pagePerchGutenbergCompatibilityPlugin(): Plugin {
  return {
    name: 'pageperch-gutenberg-compatibility',
    transform(source, modulePath) {
      assertIsolatedEditorRegistryImports(source, modulePath);
    },
  };
}
