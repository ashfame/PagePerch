export interface BuiltInPageIdentityExclusions {
  readonly exactParameterNames: readonly string[];
  readonly parameterNamePrefixes: readonly string[];
}

export interface PageIdentityExclusionRule {
  readonly origin: string;
  readonly parameterNames: readonly string[];
}

export interface PageIdentity {
  readonly canonicalUrl: string;
  readonly isRoot: boolean;
  readonly origin: string;
  readonly pageKey: string;
  readonly pathname: string;
}

export interface SupportedPageIdentityResult {
  readonly status: 'supported';
  readonly identity: PageIdentity;
}

export interface InvalidPageIdentityResult {
  readonly status: 'unsupported';
  readonly reason: 'invalid-url';
}

export interface UnsupportedSchemePageIdentityResult {
  readonly status: 'unsupported';
  readonly reason: 'unsupported-scheme';
  readonly protocol: string;
}

export type UnsupportedPageIdentityResult =
  InvalidPageIdentityResult | UnsupportedSchemePageIdentityResult;

export type PageIdentityResult =
  SupportedPageIdentityResult | UnsupportedPageIdentityResult;

export interface PageIdentityService {
  readonly builtInExclusions: BuiltInPageIdentityExclusions;

  identify(
    rawUrl: string,
    customExclusions?: readonly PageIdentityExclusionRule[],
  ): Promise<PageIdentityResult>;
}
