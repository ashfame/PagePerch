import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..');
const distributionDirectory = resolve(projectRoot, 'dist');
const stableEntries = [
  'manifest.json',
  'options.html',
  'service-worker.js',
  'side-panel.html',
] as const;

await Promise.all(
  stableEntries.map(async (entry) => {
    const metadata = await stat(resolve(distributionDirectory, entry));
    if (!metadata.isFile() || metadata.size === 0) {
      throw new Error(`Build entry is missing or empty: ${entry}`);
    }
  }),
);

const manifest = JSON.parse(
  await readFile(resolve(distributionDirectory, 'manifest.json'), 'utf8'),
) as {
  background?: { service_worker?: string; type?: string };
  options_page?: string;
  side_panel?: { default_path?: string };
};

if (
  manifest.background?.service_worker !== 'service-worker.js' ||
  manifest.background.type !== 'module' ||
  manifest.options_page !== 'options.html' ||
  manifest.side_panel?.default_path !== 'side-panel.html'
) {
  throw new Error(
    'Built manifest does not reference the deterministic entry files.',
  );
}

console.warn('Deterministic MV3 build entries verified.');
