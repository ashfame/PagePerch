import type { Plugin } from 'vite';

const unsafeGlobalFallback = /Function\((["'])return this\1\)\(\)/gu;
const isolatedVisualEditorPath =
  '/node_modules/@automattic/isolated-block-editor/build-module/components/block-editor/visual-editor.js';
const deprecatedVisualEditorImport =
  ', useSetting, __experimentalRecursionProvider as RecursionProvider,';
const currentVisualEditorImport = ', useSettings, RecursionProvider,';
const deprecatedLayoutSetting =
  "const globalLayoutSettings = useSetting('layout');";
const currentLayoutSettings =
  "const [globalLayoutSettings] = useSettings('layout');";

function exactOccurrenceCount(source: string, pattern: string): number {
  return source.split(pattern).length - 1;
}

export function replaceLodashGlobalFallback(
  code: string,
  modulePath: string,
): string | undefined {
  const normalizedPath = modulePath.replaceAll('\\', '/');
  if (
    !normalizedPath.includes('/node_modules/lodash/') &&
    !normalizedPath.includes('/node_modules/lodash.merge/')
  ) {
    return undefined;
  }

  return code.replace(unsafeGlobalFallback, 'globalThis');
}

export function replaceIsolatedEditorDeprecatedApis(
  code: string,
  modulePath: string,
): string | undefined {
  const normalizedPath = modulePath.replaceAll('\\', '/').split('?', 1)[0];
  if (!normalizedPath?.endsWith(isolatedVisualEditorPath)) {
    return undefined;
  }

  const expectedPatterns = [
    deprecatedVisualEditorImport,
    deprecatedLayoutSetting,
  ] as const;
  for (const pattern of expectedPatterns) {
    const occurrences = exactOccurrenceCount(code, pattern);
    if (occurrences !== 1) {
      throw new Error(
        `PagePerch expected exactly one pinned isolated-editor compatibility pattern in ${normalizedPath}, but found ${String(occurrences)}.`,
      );
    }
  }

  return code
    .replace(deprecatedVisualEditorImport, currentVisualEditorImport)
    .replace(deprecatedLayoutSetting, currentLayoutSettings);
}

export function replaceMv3IncompatibleCode(
  code: string,
  modulePath: string,
): string | undefined {
  const isolatedEditorResult = replaceIsolatedEditorDeprecatedApis(
    code,
    modulePath,
  );
  const lodashResult = replaceLodashGlobalFallback(
    isolatedEditorResult ?? code,
    modulePath,
  );

  return lodashResult ?? isolatedEditorResult;
}

export function mv3CompatibilityPlugin(): Plugin {
  return {
    name: 'pageperch-mv3-compatibility',
    transform(code, modulePath) {
      return replaceMv3IncompatibleCode(code, modulePath);
    },
  };
}
