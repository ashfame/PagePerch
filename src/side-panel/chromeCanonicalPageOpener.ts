export interface CanonicalPageOpener {
  openCanonicalUrl(canonicalUrl: string): Promise<void>;
}

export interface ChromeCreateTabPort {
  create(
    createProperties: chrome.tabs.CreateProperties,
  ): Promise<chrome.tabs.Tab>;
}

export class InvalidCanonicalPageUrlError extends Error {
  constructor() {
    super(
      'A recent note URL must be a canonical absolute credential-free HTTP(S) URL.',
    );
    this.name = 'InvalidCanonicalPageUrlError';
  }
}

function validateCanonicalUrl(canonicalUrl: string): string {
  if (typeof canonicalUrl !== 'string') {
    throw new InvalidCanonicalPageUrlError();
  }

  let parsed: URL;

  try {
    parsed = new URL(canonicalUrl);
  } catch {
    throw new InvalidCanonicalPageUrlError();
  }

  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.hash !== '' ||
    canonicalUrl.includes('#') ||
    parsed.href !== canonicalUrl ||
    (parsed.search === '' && canonicalUrl.includes('?'))
  ) {
    throw new InvalidCanonicalPageUrlError();
  }

  return canonicalUrl;
}

export class ChromeCanonicalPageOpener implements CanonicalPageOpener {
  readonly #tabs: ChromeCreateTabPort;

  constructor(tabs: ChromeCreateTabPort = chrome.tabs) {
    this.#tabs = tabs;
  }

  async openCanonicalUrl(canonicalUrl: string): Promise<void> {
    const validatedUrl = validateCanonicalUrl(canonicalUrl);
    await this.#tabs.create({
      active: true,
      url: validatedUrl,
    });
  }
}
