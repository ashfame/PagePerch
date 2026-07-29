export const PAGEPERCH_CORE_BLOCK_NAMES = [
  'core/paragraph',
  'core/heading',
  'core/list',
  'core/list-item',
  'core/quote',
  'core/code',
  'core/preformatted',
  'core/separator',
] as const;

export const PAGEPERCH_RICH_TEXT_FORMAT_NAMES = [
  'core/bold',
  'core/code',
  'core/italic',
  'core/link',
  'core/strikethrough',
  'core/subscript',
  'core/superscript',
  'core/keyboard',
  'core/unknown',
] as const;

// These safe semantic tags intentionally route through `core/unknown` because
// their toolbar formats use different canonical tags or have no toolbar format.
// PageNoteEditor owns the final tag, attribute, and URL sanitization boundary.
export const PAGEPERCH_UNKNOWN_FORMAT_FALLBACK_TAG_NAMES = [
  'b',
  'i',
  'del',
  'mark',
] as const;

export function assertExactGutenbergRegistry(
  actualNames: readonly string[],
  expectedNames: readonly string[],
  registryLabel: string,
): void {
  if (
    actualNames.length !== expectedNames.length ||
    actualNames.some((name, index) => name !== expectedNames[index])
  ) {
    throw new Error(
      `PagePerch ${registryLabel} registry drifted: expected ${expectedNames.join(', ')}, received ${actualNames.join(', ')}.`,
    );
  }
}
