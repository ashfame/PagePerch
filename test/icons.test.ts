import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';

import { generateIcons, iconSizes } from '../scripts/generate-icons';

const temporaryDirectories: string[] = [];
const projectRoot = resolve(import.meta.dirname, '..');

function digest(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('generated extension icons', () => {
  it('reproduces committed square, transparent, padded PNGs from the supplied logo', async () => {
    const temporaryDirectory = await mkdtemp(
      resolve(tmpdir(), 'pageperch-icons-'),
    );
    temporaryDirectories.push(temporaryDirectory);
    const temporaryIconDirectory = resolve(temporaryDirectory, 'icons');

    await generateIcons({
      sourcePath: resolve(projectRoot, 'page_perch_logo.png'),
      iconOutputDirectory: temporaryIconDirectory,
      brandOutputPath: resolve(temporaryDirectory, 'brand/page-perch-logo.png'),
    });

    for (const size of iconSizes) {
      const filename = `icon-${size}.png`;
      const generated = await readFile(
        resolve(temporaryIconDirectory, filename),
      );
      const committed = await readFile(
        resolve(projectRoot, 'public/icons', filename),
      );
      const metadata = await sharp(committed).metadata();
      const corner = await sharp(committed)
        .extract({ height: 1, left: 0, top: 0, width: 1 })
        .raw()
        .toBuffer();

      expect(digest(generated)).toBe(digest(committed));
      expect(metadata).toMatchObject({
        format: 'png',
        hasAlpha: true,
        height: size,
        width: size,
      });
      expect(corner[3]).toBe(0);
    }
  });
});
