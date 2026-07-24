import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

export const iconSizes = [16, 32, 48, 128] as const;

export interface GenerateIconsOptions {
  sourcePath: string;
  iconOutputDirectory: string;
  brandOutputPath: string;
}

export async function generateIcons({
  sourcePath,
  iconOutputDirectory,
  brandOutputPath,
}: GenerateIconsOptions): Promise<void> {
  await Promise.all([
    mkdir(iconOutputDirectory, { recursive: true }),
    mkdir(dirname(brandOutputPath), { recursive: true }),
  ]);
  await copyFile(sourcePath, brandOutputPath);

  await Promise.all(
    iconSizes.map(async (size) => {
      const innerSize = Math.max(1, Math.round(size * 0.8));
      const outerPadding = size - innerSize;
      const before = Math.floor(outerPadding / 2);
      const after = outerPadding - before;

      await sharp(sourcePath)
        .resize(innerSize, innerSize, {
          background: { alpha: 0, b: 0, g: 0, r: 0 },
          fit: 'contain',
          kernel: sharp.kernel.lanczos3,
        })
        .extend({
          top: before,
          bottom: after,
          left: before,
          right: after,
          background: { alpha: 0, b: 0, g: 0, r: 0 },
        })
        .png({
          compressionLevel: 9,
          palette: false,
        })
        .toFile(resolve(iconOutputDirectory, `icon-${size}.png`));
    }),
  );
}

const scriptPath = fileURLToPath(import.meta.url);

if (process.argv[1] === scriptPath) {
  const projectRoot = resolve(dirname(scriptPath), '..');
  await generateIcons({
    sourcePath: resolve(projectRoot, 'page_perch_logo.png'),
    iconOutputDirectory: resolve(projectRoot, 'public/icons'),
    brandOutputPath: resolve(projectRoot, 'public/brand/page-perch-logo.png'),
  });
}
