import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

function relativeLuminance(hexColor: string): number {
  const channels = hexColor
    .slice(1)
    .match(/.{2}/gu)
    ?.map((channel) => Number.parseInt(channel, 16) / 255);

  if (channels?.length !== 3) {
    throw new Error(
      `Expected a six-digit hexadecimal color, received ${hexColor}`,
    );
  }

  const [red, green, blue] = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );

  return red! * 0.2126 + green! * 0.7152 + blue! * 0.0722;
}

function contrastRatio(foreground: string, background: string): number {
  const lighter = Math.max(
    relativeLuminance(foreground),
    relativeLuminance(background),
  );
  const darker = Math.min(
    relativeLuminance(foreground),
    relativeLuminance(background),
  );

  return (lighter + 0.05) / (darker + 0.05);
}

function cssVariable(block: string, name: string): string {
  const value = new RegExp(`--${name}:\\s*(#[A-Fa-f0-9]{6})\\s*;`, 'u').exec(
    block,
  )?.[1];

  if (value === undefined) {
    throw new Error(`Missing CSS variable --${name}`);
  }

  return value;
}

describe('automatic theme and accessibility baseline', () => {
  it('includes system dark mode, reduced motion, visible focus, and narrow-panel rules', async () => {
    const styles = await readFile(
      resolve(import.meta.dirname, '../src/styles/base.css'),
      'utf8',
    );

    expect(styles).toContain('@media (prefers-color-scheme: dark)');
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)');
    expect(styles).toContain(':focus-visible');
    expect(styles).toContain('@media (max-width: 320px)');
    expect(styles).toContain('min-width: 240px');
  });

  it('keeps normal and hover dark-theme button text above WCAG AA contrast', async () => {
    const styles = await readFile(
      resolve(import.meta.dirname, '../src/styles/base.css'),
      'utf8',
    );
    const darkTheme = styles.slice(
      styles.indexOf('@media (prefers-color-scheme: dark)'),
      styles.indexOf('@media (prefers-reduced-motion: reduce)'),
    );
    const white = '#ffffff';

    expect(
      contrastRatio(white, cssVariable(darkTheme, 'button-background')),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(white, cssVariable(darkTheme, 'button-background-hover')),
    ).toBeGreaterThanOrEqual(4.5);
  });
});
