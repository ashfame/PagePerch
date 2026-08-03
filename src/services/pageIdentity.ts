import type {
  BuiltInPageIdentityExclusions,
  PageIdentityExclusionRule,
  PageIdentityResult,
  PageIdentityService,
} from '../domain/pageIdentity';

const exactParameterNames = Object.freeze([
  'gclid',
  'dclid',
  'gbraid',
  'wbraid',
  'fbclid',
  'msclkid',
  'twclid',
  'ttclid',
  'li_fat_id',
  'mc_cid',
  'mc_eid',
  '_ga',
  '_gl',
]);

const parameterNamePrefixes = Object.freeze(['utm_']);

export const BUILT_IN_CASE_INSENSITIVE_PATH_ORIGINS = Object.freeze([
  'https://github.com',
]);

const caseInsensitivePathOriginSet = new Set(
  BUILT_IN_CASE_INSENSITIVE_PATH_ORIGINS,
);

export const BUILT_IN_PAGE_IDENTITY_EXCLUSIONS: BuiltInPageIdentityExclusions =
  Object.freeze({
    exactParameterNames,
    parameterNamePrefixes,
  });

const exactParameterNameSet = new Set(exactParameterNames);

function compareCodeUnits(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}

function isSupportedProtocol(protocol: string): boolean {
  return protocol === 'http:' || protocol === 'https:';
}

export function normalizePageIdentityPathname(
  origin: string,
  pathname: string,
): string {
  if (!caseInsensitivePathOriginSet.has(origin)) {
    return pathname;
  }

  // Product decision: selected sites whose routes are case-insensitive share one note across path casing variants.
  return pathname.toLowerCase();
}

function normalizeRuleOrigin(origin: string): string | undefined {
  try {
    const parsedOrigin = new URL(origin);

    if (
      !isSupportedProtocol(parsedOrigin.protocol) ||
      parsedOrigin.username !== '' ||
      parsedOrigin.password !== '' ||
      parsedOrigin.pathname !== '/' ||
      parsedOrigin.search !== '' ||
      parsedOrigin.hash !== ''
    ) {
      return undefined;
    }

    return parsedOrigin.origin;
  } catch {
    return undefined;
  }
}

function getCustomExclusionsForOrigin(
  origin: string,
  rules: readonly PageIdentityExclusionRule[],
): ReadonlySet<string> {
  const exclusions = new Set<string>();

  for (const rule of rules) {
    if (normalizeRuleOrigin(rule.origin) !== origin) {
      continue;
    }

    for (const parameterName of rule.parameterNames) {
      exclusions.add(parameterName.toLowerCase());
    }
  }

  return exclusions;
}

function isBuiltInExcluded(parameterName: string): boolean {
  const normalizedName = parameterName.toLowerCase();

  return (
    exactParameterNameSet.has(normalizedName) ||
    parameterNamePrefixes.some((prefix) => normalizedName.startsWith(prefix))
  );
}

function canonicalizeQuery(
  parsedUrl: URL,
  customExclusions: ReadonlySet<string>,
): string {
  const entries = [...parsedUrl.searchParams].filter(([parameterName]) => {
    const normalizedName = parameterName.toLowerCase();

    return (
      !isBuiltInExcluded(parameterName) && !customExclusions.has(normalizedName)
    );
  });

  entries.sort(([leftName, leftValue], [rightName, rightValue]) => {
    const nameComparison = compareCodeUnits(leftName, rightName);

    return nameComparison === 0
      ? compareCodeUnits(leftValue, rightValue)
      : nameComparison;
  });

  const canonicalSearchParameters = new URLSearchParams();

  for (const [parameterName, value] of entries) {
    canonicalSearchParameters.append(parameterName, value);
  }

  return canonicalSearchParameters.toString();
}

function encodeBase64Url(bytes: Uint8Array): string {
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let encoded = '';

  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const combined =
      (first << 16) | ((second ?? 0) << 8) | (third === undefined ? 0 : third);

    encoded += alphabet[(combined >>> 18) & 0x3f];
    encoded += alphabet[(combined >>> 12) & 0x3f];

    if (second !== undefined) {
      encoded += alphabet[(combined >>> 6) & 0x3f];
    }

    if (third !== undefined) {
      encoded += alphabet[combined & 0x3f];
    }
  }

  return encoded;
}

export async function createPageIdentityKey(
  canonicalUrl: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalUrl),
  );

  return encodeBase64Url(new Uint8Array(digest));
}

export async function derivePageIdentity(
  rawUrl: string,
  customExclusions: readonly PageIdentityExclusionRule[] = [],
): Promise<PageIdentityResult> {
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    return {
      status: 'unsupported',
      reason: 'invalid-url',
    };
  }

  if (!isSupportedProtocol(parsedUrl.protocol)) {
    return {
      status: 'unsupported',
      reason: 'unsupported-scheme',
      protocol: parsedUrl.protocol,
    };
  }

  // Product decision: a page keeps one note when parameters declared not to make it unique are removed.
  const meaningfulQuery = canonicalizeQuery(
    parsedUrl,
    getCustomExclusionsForOrigin(parsedUrl.origin, customExclusions),
  );
  const pathname = normalizePageIdentityPathname(
    parsedUrl.origin,
    parsedUrl.pathname,
  );
  const canonicalUrl = `${parsedUrl.origin}${pathname}${
    meaningfulQuery === '' ? '' : `?${meaningfulQuery}`
  }`;

  return {
    status: 'supported',
    identity: {
      canonicalUrl,
      isRoot: pathname === '/' && meaningfulQuery === '',
      origin: parsedUrl.origin,
      pageKey: await createPageIdentityKey(canonicalUrl),
      pathname,
    },
  };
}

export class DefaultPageIdentityService implements PageIdentityService {
  readonly builtInExclusions = BUILT_IN_PAGE_IDENTITY_EXCLUSIONS;

  identify(
    rawUrl: string,
    customExclusions: readonly PageIdentityExclusionRule[] = [],
  ): Promise<PageIdentityResult> {
    return derivePageIdentity(rawUrl, customExclusions);
  }
}
