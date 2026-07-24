import type { Plugin } from 'vite';

const unsafeGlobalFallback = /Function\((["'])return this\1\)\(\)/gu;

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

export function mv3CompatibilityPlugin(): Plugin {
  return {
    name: 'pageperch-mv3-compatibility',
    transform(code, modulePath) {
      return replaceLodashGlobalFallback(code, modulePath);
    },
  };
}
