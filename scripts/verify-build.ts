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
const lazyEditorEntries = [
  'assets/PageNoteEditor.css',
  'assets/PageNoteEditor.js',
] as const;
const maximumSidePanelEntryBytes = 96 * 1024;
const editorImplementationMarkers = [
  'BlockEditorProvider',
  'Page note editor',
  'core/paragraph',
] as const;

await Promise.all(
  [...stableEntries, ...lazyEditorEntries, 'assets/side-panel.js'].map(
    async (entry) => {
      const metadata = await stat(resolve(distributionDirectory, entry));
      if (!metadata.isFile() || metadata.size === 0) {
        throw new Error(`Build entry is missing or empty: ${entry}`);
      }
    },
  ),
);

const [sidePanelHtml, sidePanelSource, editorSource, sidePanelMetadata] =
  await Promise.all([
    readFile(resolve(distributionDirectory, 'side-panel.html'), 'utf8'),
    readFile(resolve(distributionDirectory, 'assets/side-panel.js'), 'utf8'),
    readFile(
      resolve(distributionDirectory, 'assets/PageNoteEditor.js'),
      'utf8',
    ),
    stat(resolve(distributionDirectory, 'assets/side-panel.js')),
  ]);

if (sidePanelMetadata.size > maximumSidePanelEntryBytes) {
  throw new Error(
    `The side-panel shell entry exceeds its ${String(maximumSidePanelEntryBytes)}-byte budget: ${String(sidePanelMetadata.size)} bytes.`,
  );
}

if (
  !sidePanelSource.includes('import(`./PageNoteEditor.js`)') ||
  !sidePanelSource.includes('assets/PageNoteEditor.css')
) {
  throw new Error(
    'The side-panel shell does not retain the stable lazy editor JS and CSS boundary.',
  );
}

if (
  sidePanelHtml.includes('PageNoteEditor.js') ||
  sidePanelHtml.includes('PageNoteEditor.css')
) {
  throw new Error(
    'The side-panel HTML eagerly references a lazy editor resource.',
  );
}

for (const marker of editorImplementationMarkers) {
  if (sidePanelSource.includes(marker)) {
    throw new Error(
      `The side-panel shell contains an editor implementation marker: ${marker}`,
    );
  }

  if (!editorSource.includes(marker)) {
    throw new Error(
      `The lazy editor chunk is missing its expected implementation marker: ${marker}`,
    );
  }
}

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
