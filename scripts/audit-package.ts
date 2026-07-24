import { resolve } from 'node:path';

import { auditPackage } from '../src/build/packageAudit.ts';

const projectRoot = resolve(import.meta.dirname, '..');
const result = await auditPackage(resolve(projectRoot, 'dist'));

if (result.violations.length > 0) {
  for (const violation of result.violations) {
    console.error(`${violation.file}: ${violation.message}`);
  }

  process.exitCode = 1;
} else {
  console.warn(
    `Production package audit passed (${result.filesInspected} files inspected).`,
  );
}
