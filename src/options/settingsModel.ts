import type {
  BuiltInPageIdentityExclusions,
  PageIdentityExclusionRule,
} from '../domain/pageIdentity';
import type { SettingsRecordV1 } from '../domain/settings';
import { isExactHttpOrigin } from '../repositories/validation';

export type OptionsSettingsValidationErrorCode =
  | 'built-in-parameter'
  | 'duplicate-parameter'
  | 'invalid-origin'
  | 'invalid-parameter'
  | 'missing-parameter';

export class OptionsSettingsValidationError extends Error {
  readonly code: OptionsSettingsValidationErrorCode;

  constructor(code: OptionsSettingsValidationErrorCode, message: string) {
    super(message);
    this.name = 'OptionsSettingsValidationError';
    this.code = code;
  }
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}

function normalizeParameterName(value: string): string {
  const normalized = value.trim().toLowerCase();

  if (normalized === '') {
    throw new OptionsSettingsValidationError(
      'invalid-parameter',
      'Enter a query parameter name.',
    );
  }

  return normalized;
}

function assertCustomParameter(
  parameterName: string,
  builtIns: BuiltInPageIdentityExclusions,
): void {
  const isExactBuiltIn = builtIns.exactParameterNames.some(
    (name) => name.toLowerCase() === parameterName,
  );
  const hasBuiltInPrefix = builtIns.parameterNamePrefixes.some((prefix) =>
    parameterName.startsWith(prefix.toLowerCase()),
  );

  if (isExactBuiltIn || hasBuiltInPrefix) {
    throw new OptionsSettingsValidationError(
      'built-in-parameter',
      'That query parameter is already excluded by PagePerch.',
    );
  }
}

function normalizeRules(
  rules: readonly PageIdentityExclusionRule[],
): PageIdentityExclusionRule[] {
  const namesByOrigin = new Map<string, Set<string>>();

  for (const rule of rules) {
    const names = namesByOrigin.get(rule.origin) ?? new Set<string>();

    for (const parameterName of rule.parameterNames) {
      names.add(parameterName.trim().toLowerCase());
    }

    namesByOrigin.set(rule.origin, names);
  }

  return [...namesByOrigin]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([origin, names]) => ({
      origin,
      parameterNames: [...names].sort(compareCodeUnits),
    }));
}

export function sortedPageIdentityExclusions(
  rules: readonly PageIdentityExclusionRule[],
): readonly PageIdentityExclusionRule[] {
  return normalizeRules(rules);
}

export function addPageIdentityExclusion(
  settings: SettingsRecordV1,
  rawOrigin: string,
  rawParameterName: string,
  builtIns: BuiltInPageIdentityExclusions,
): SettingsRecordV1 {
  const origin = rawOrigin.trim();

  if (!isExactHttpOrigin(origin)) {
    throw new OptionsSettingsValidationError(
      'invalid-origin',
      'Enter a canonical HTTP(S) origin without credentials, a path, query, or fragment.',
    );
  }

  const parameterName = normalizeParameterName(rawParameterName);
  assertCustomParameter(parameterName, builtIns);
  const rules = normalizeRules(settings.pageIdentityExclusions);
  const existingRule = rules.find((rule) => rule.origin === origin);

  if (existingRule?.parameterNames.includes(parameterName) === true) {
    throw new OptionsSettingsValidationError(
      'duplicate-parameter',
      'That origin already excludes this query parameter.',
    );
  }

  const nextRules =
    existingRule === undefined
      ? [...rules, { origin, parameterNames: [parameterName] }]
      : rules.map((rule) =>
          rule.origin === origin
            ? {
                origin: rule.origin,
                parameterNames: [...rule.parameterNames, parameterName].sort(
                  compareCodeUnits,
                ),
              }
            : rule,
        );

  return {
    ...settings,
    pageIdentityExclusions: normalizeRules(nextRules),
  };
}

export function removePageIdentityExclusion(
  settings: SettingsRecordV1,
  origin: string,
  rawParameterName: string,
): SettingsRecordV1 {
  const parameterName = normalizeParameterName(rawParameterName);
  const rules = normalizeRules(settings.pageIdentityExclusions);
  const existingRule = rules.find((rule) => rule.origin === origin);

  if (existingRule?.parameterNames.includes(parameterName) !== true) {
    throw new OptionsSettingsValidationError(
      'missing-parameter',
      'That custom exclusion is no longer present. Reload settings and retry.',
    );
  }

  return {
    ...settings,
    pageIdentityExclusions: rules.flatMap((rule) => {
      if (rule.origin !== origin) {
        return [rule];
      }

      const parameterNames = rule.parameterNames.filter(
        (name) => name !== parameterName,
      );

      return parameterNames.length === 0
        ? []
        : [{ origin: rule.origin, parameterNames }];
    }),
  };
}
