import { relative, resolve } from 'node:path';

import { createReleasePackage } from '../src/build/releasePackage.ts';

const projectRoot = resolve(import.meta.dirname, '..');
const result = await createReleasePackage({
  packageJsonPath: resolve(projectRoot, 'package.json'),
  releaseDirectory: resolve(projectRoot, '.release'),
  sourceDirectory: resolve(projectRoot, 'dist'),
});

console.warn(
  [
    `Release package created with ${result.entries.length} audited files.`,
    `Archive: ${relative(projectRoot, result.archivePath)}`,
    `Checksum: ${relative(projectRoot, result.checksumPath)}`,
    `SHA-256: ${result.checksum}`,
  ].join('\n'),
);
