import { describe, expect, it } from 'vitest';

import type {
  PageIdentity,
  PageIdentityExclusionRule,
} from '../domain/pageIdentity';
import {
  BUILT_IN_CASE_INSENSITIVE_PATH_ORIGINS,
  BUILT_IN_PAGE_IDENTITY_EXCLUSIONS,
  DefaultPageIdentityService,
} from './pageIdentity';

const service = new DefaultPageIdentityService();

async function expectSupported(
  rawUrl: string,
  customExclusions: readonly PageIdentityExclusionRule[] = [],
): Promise<PageIdentity> {
  const result = await service.identify(rawUrl, customExclusions);

  expect(result.status).toBe('supported');

  if (result.status !== 'supported') {
    throw new Error(`Expected ${rawUrl} to be supported`);
  }

  return result.identity;
}

describe('DefaultPageIdentityService', () => {
  describe('unsupported URLs', () => {
    it.each([
      '',
      'not a URL',
      '/relative/path',
      'http://',
      'https://[invalid-ipv6',
    ])('reports an invalid URL without throwing for %j', async (rawUrl) => {
      await expect(service.identify(rawUrl)).resolves.toEqual({
        status: 'unsupported',
        reason: 'invalid-url',
      });
    });

    it.each([
      ['chrome://settings/', 'chrome:'],
      ['chrome-extension://abcdefghijklmnop/options.html', 'chrome-extension:'],
      ['file:///tmp/page.html', 'file:'],
      ['about:blank', 'about:'],
      ['data:text/plain,page', 'data:'],
      ['ftp://example.com/file', 'ftp:'],
    ])('reports the unsupported protocol for %s', async (rawUrl, protocol) => {
      await expect(service.identify(rawUrl)).resolves.toEqual({
        status: 'unsupported',
        reason: 'unsupported-scheme',
        protocol,
      });
    });
  });

  describe('exact origins and paths', () => {
    it.each([
      [
        'https://example.com',
        {
          canonicalUrl: 'https://example.com/',
          origin: 'https://example.com',
          pathname: '/',
          isRoot: true,
        },
      ],
      [
        'http://example.com/',
        {
          canonicalUrl: 'http://example.com/',
          origin: 'http://example.com',
          pathname: '/',
          isRoot: true,
        },
      ],
      [
        'HTTPS://EXAMPLE.COM:443/Path',
        {
          canonicalUrl: 'https://example.com/Path',
          origin: 'https://example.com',
          pathname: '/Path',
          isRoot: false,
        },
      ],
      [
        'http://EXAMPLE.com:80/path',
        {
          canonicalUrl: 'http://example.com/path',
          origin: 'http://example.com',
          pathname: '/path',
          isRoot: false,
        },
      ],
      [
        'https://example.com:8443/path',
        {
          canonicalUrl: 'https://example.com:8443/path',
          origin: 'https://example.com:8443',
          pathname: '/path',
          isRoot: false,
        },
      ],
      [
        'https://sub.example.com/path/',
        {
          canonicalUrl: 'https://sub.example.com/path/',
          origin: 'https://sub.example.com',
          pathname: '/path/',
          isRoot: false,
        },
      ],
      [
        'https://[2001:db8::1]:8443/path',
        {
          canonicalUrl: 'https://[2001:db8::1]:8443/path',
          origin: 'https://[2001:db8::1]:8443',
          pathname: '/path',
          isRoot: false,
        },
      ],
      [
        'https://bücher.example/Über',
        {
          canonicalUrl: 'https://xn--bcher-kva.example/%C3%9Cber',
          origin: 'https://xn--bcher-kva.example',
          pathname: '/%C3%9Cber',
          isRoot: false,
        },
      ],
      [
        'https://example.com/path',
        {
          canonicalUrl: 'https://example.com/path',
          origin: 'https://example.com',
          pathname: '/path',
          isRoot: false,
        },
      ],
      [
        'https://example.com/path/',
        {
          canonicalUrl: 'https://example.com/path/',
          origin: 'https://example.com',
          pathname: '/path/',
          isRoot: false,
        },
      ],
      [
        'https://example.com/Path',
        {
          canonicalUrl: 'https://example.com/Path',
          origin: 'https://example.com',
          pathname: '/Path',
          isRoot: false,
        },
      ],
      [
        'https://example.com/path#section',
        {
          canonicalUrl: 'https://example.com/path',
          origin: 'https://example.com',
          pathname: '/path',
          isRoot: false,
        },
      ],
      [
        'https://example.com/one/../two/./page',
        {
          canonicalUrl: 'https://example.com/two/page',
          origin: 'https://example.com',
          pathname: '/two/page',
          isRoot: false,
        },
      ],
      [
        'https://user:password@example.com/private',
        {
          canonicalUrl: 'https://example.com/private',
          origin: 'https://example.com',
          pathname: '/private',
          isRoot: false,
        },
      ],
    ])('canonicalizes %s with URL semantics', async (rawUrl, expected) => {
      const identity = await expectSupported(rawUrl);

      expect(identity).toMatchObject(expected);
      expect(identity.pageKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    it('keeps HTTP, HTTPS, subdomains, and non-default ports distinct', async () => {
      const identities = await Promise.all(
        [
          'http://example.com/path',
          'https://example.com/path',
          'https://sub.example.com/path',
          'https://example.com:8443/path',
        ].map((rawUrl) => expectSupported(rawUrl)),
      );

      expect(new Set(identities.map(({ pageKey }) => pageKey)).size).toBe(4);
    });

    it('shares one GitHub identity across path casing variants', async () => {
      const lowercase = await expectSupported(
        'https://github.com/automattic/chatrix',
      );
      const mixedCase = await expectSupported(
        'https://github.com/Automattic/Chatrix',
      );

      expect(mixedCase).toEqual(lowercase);
      expect(mixedCase).toMatchObject({
        canonicalUrl: 'https://github.com/automattic/chatrix',
        origin: 'https://github.com',
        pathname: '/automattic/chatrix',
      });
    });

    it('publishes an immutable exact-origin list for case-insensitive paths', () => {
      expect(BUILT_IN_CASE_INSENSITIVE_PATH_ORIGINS).toEqual([
        'https://github.com',
      ]);
      expect(Object.isFrozen(BUILT_IN_CASE_INSENSITIVE_PATH_ORIGINS)).toBe(
        true,
      );
    });

    it.each([
      ['http://github.com/Automattic', 'http://github.com/Automattic'],
      [
        'https://www.github.com/Automattic',
        'https://www.github.com/Automattic',
      ],
      [
        'https://github.com:8443/Automattic',
        'https://github.com:8443/Automattic',
      ],
      ['https://example.com/Automattic', 'https://example.com/Automattic'],
    ])(
      'keeps paths case-sensitive outside the built-in exact origin for %s',
      async (rawUrl, expected) => {
        const identity = await expectSupported(rawUrl);

        expect(identity.canonicalUrl).toBe(expected);
      },
    );

    it('keeps GitHub query names and values case-sensitive while normalizing its path', async () => {
      const identity = await expectSupported(
        'https://github.com/Automattic?view=Upper&View=lower',
      );

      expect(identity.canonicalUrl).toBe(
        'https://github.com/automattic?View=lower&view=Upper',
      );
    });
  });

  describe('meaningful query canonicalization', () => {
    it.each([
      [
        'https://example.com/path?b=2&a=2&a=1',
        'https://example.com/path?a=1&a=2&b=2',
      ],
      [
        'https://example.com/path?tag=z&tag=a&tag=a&other=2&other=1',
        'https://example.com/path?other=1&other=2&tag=a&tag=a&tag=z',
      ],
      [
        'https://example.com/path?empty=&implicit&=value',
        'https://example.com/path?=value&empty=&implicit=',
      ],
      [
        'https://example.com/path?space=a+b&literalPlus=a%2Bb&percent=%252F&unicode=%E2%9C%93&slash=%2f',
        'https://example.com/path?literalPlus=a%2Bb&percent=%252F&slash=%2F&space=a+b&unicode=%E2%9C%93',
      ],
      [
        'https://example.com/path?%C3%A9=z&a=z&%F0%9F%98%80=z&A=z',
        'https://example.com/path?A=z&a=z&%C3%A9=z&%F0%9F%98%80=z',
      ],
    ])(
      'sorts and serializes %s deterministically',
      async (rawUrl, expected) => {
        const identity = await expectSupported(rawUrl);

        expect(identity.canonicalUrl).toBe(expected);
      },
    );

    it('gives reordered equivalent query parameters the same identity', async () => {
      const first = await expectSupported(
        'https://example.com/path?tag=z&a=2&tag=a&a=1',
      );
      const second = await expectSupported(
        'https://example.com/path?a=1&tag=a&a=2&tag=z',
      );

      expect(second).toEqual(first);
    });

    it('normalizes equivalent space encodings while preserving a literal encoded plus', async () => {
      const formSpace = await expectSupported(
        'https://example.com/path?value=a+b',
      );
      const percentSpace = await expectSupported(
        'https://example.com/path?value=a%20b',
      );
      const literalPlus = await expectSupported(
        'https://example.com/path?value=a%2Bb',
      );

      expect(percentSpace).toEqual(formSpace);
      expect(formSpace.canonicalUrl).toBe('https://example.com/path?value=a+b');
      expect(literalPlus.canonicalUrl).toBe(
        'https://example.com/path?value=a%2Bb',
      );
      expect(literalPlus.pageKey).not.toBe(formSpace.pageKey);
    });
  });

  describe('built-in exclusions', () => {
    it('exposes the read-only built-in exclusions for settings display', () => {
      expect(service.builtInExclusions).toBe(BUILT_IN_PAGE_IDENTITY_EXCLUSIONS);
      expect(service.builtInExclusions).toEqual({
        exactParameterNames: [
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
        ],
        parameterNamePrefixes: ['utm_'],
      });
      expect(Object.isFrozen(service.builtInExclusions)).toBe(true);
      expect(
        Object.isFrozen(service.builtInExclusions.exactParameterNames),
      ).toBe(true);
      expect(
        Object.isFrozen(service.builtInExclusions.parameterNamePrefixes),
      ).toBe(true);
    });

    it.each([
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
      'utm_source',
      'UTM_CAMPAIGN',
      'FbClId',
    ])('excludes %s case-insensitively', async (parameterName) => {
      const identity = await expectSupported(
        `https://example.com/?keep=yes&${parameterName}=tracking`,
      );

      expect(identity.canonicalUrl).toBe('https://example.com/?keep=yes');
      expect(identity.isRoot).toBe(false);
    });

    it.each([
      'utm',
      'utmSource',
      'xutm_source',
      'gclid_extra',
      'agclid',
      '_ga_extra',
      'mc_cid_suffix',
    ])('does not exclude near-miss parameter %s', async (parameterName) => {
      const identity = await expectSupported(
        `https://example.com/?${parameterName}=meaningful`,
      );

      expect(identity.canonicalUrl).toBe(
        `https://example.com/?${parameterName}=meaningful`,
      );
      expect(identity.isRoot).toBe(false);
    });
  });

  describe('custom exact-origin exclusions', () => {
    const customExclusions = Object.freeze([
      Object.freeze({
        origin: 'HTTPS://EXAMPLE.COM:443/',
        parameterNames: Object.freeze(['Session', 'VIEW']),
      }),
    ]);

    it('matches parameter names case-insensitively on the normalized exact origin', async () => {
      const identity = await expectSupported(
        'https://example.com/path?session=one&ViEw=grid&keep=yes',
        customExclusions,
      );

      expect(identity.canonicalUrl).toBe('https://example.com/path?keep=yes');
    });

    it.each([
      [
        'http://example.com/path?session=one',
        'http://example.com/path?session=one',
      ],
      [
        'https://example.com:8443/path?session=one',
        'https://example.com:8443/path?session=one',
      ],
      [
        'https://sub.example.com/path?session=one',
        'https://sub.example.com/path?session=one',
      ],
      [
        'https://example.org/path?session=one',
        'https://example.org/path?session=one',
      ],
    ])(
      'does not cross exact-origin boundaries for %s',
      async (rawUrl, expected) => {
        const identity = await expectSupported(rawUrl, customExclusions);

        expect(identity.canonicalUrl).toBe(expected);
      },
    );

    it('combines multiple rules for the same exact origin', async () => {
      const identity = await expectSupported(
        'https://example.com/path?first=1&second=2&keep=3',
        [
          { origin: 'https://example.com', parameterNames: ['first'] },
          { origin: 'https://example.com/', parameterNames: ['SECOND'] },
        ],
      );

      expect(identity.canonicalUrl).toBe('https://example.com/path?keep=3');
    });

    it('normalizes and scopes a bracketed IPv6 origin with a non-default port', async () => {
      const matching = await expectSupported(
        'https://[2001:db8::1]:8443/path?session=one&keep=yes',
        [
          {
            origin: 'https://[2001:0db8:0:0:0:0:0:1]:8443',
            parameterNames: ['session'],
          },
        ],
      );
      const otherPort = await expectSupported(
        'https://[2001:db8::1]/path?session=one',
        [
          {
            origin: 'https://[2001:db8::1]:8443',
            parameterNames: ['session'],
          },
        ],
      );

      expect(matching.canonicalUrl).toBe(
        'https://[2001:db8::1]:8443/path?keep=yes',
      );
      expect(otherPort.canonicalUrl).toBe(
        'https://[2001:db8::1]/path?session=one',
      );
    });

    it('matches custom parameter names exactly rather than by prefix', async () => {
      const identity = await expectSupported(
        'https://example.com/path?id=one&id_extra=two',
        [{ origin: 'https://example.com', parameterNames: ['ID'] }],
      );

      expect(identity.canonicalUrl).toBe(
        'https://example.com/path?id_extra=two',
      );
    });

    it.each([
      'not an origin',
      'ftp://example.com',
      'https://user@example.com',
      'https://example.com/path',
      'https://example.com?query=yes',
      'https://example.com#fragment',
    ])('ignores malformed or non-origin scope %s', async (origin) => {
      const identity = await expectSupported(
        'https://example.com/path?session=one',
        [{ origin, parameterNames: ['session'] }],
      );

      expect(identity.canonicalUrl).toBe(
        'https://example.com/path?session=one',
      );
    });

    it('does not mutate custom exclusion inputs', async () => {
      const before = JSON.stringify(customExclusions);

      await expectSupported(
        'https://example.com/path?session=one',
        customExclusions,
      );

      expect(JSON.stringify(customExclusions)).toBe(before);
    });
  });

  describe('root detection', () => {
    it.each([
      'https://example.com',
      'https://example.com/',
      'https://example.com/#fragment',
      'https://example.com/?utm_source=newsletter',
      'https://example.com/?GCLID=tracking&utm_campaign=sale#fragment',
    ])('treats %s as an origin root', async (rawUrl) => {
      const identity = await expectSupported(rawUrl);

      expect(identity.canonicalUrl).toBe('https://example.com/');
      expect(identity.isRoot).toBe(true);
    });

    it('treats a custom-ignored-only query as an origin root', async () => {
      const identity = await expectSupported(
        'https://example.com/?session=one',
        [{ origin: 'https://example.com', parameterNames: ['SESSION'] }],
      );

      expect(identity.canonicalUrl).toBe('https://example.com/');
      expect(identity.isRoot).toBe(true);
    });

    it.each([
      'https://example.com/path',
      'https://example.com//',
      'https://example.com/?meaningful=',
    ])('does not treat %s as an origin root', async (rawUrl) => {
      const identity = await expectSupported(rawUrl);

      expect(identity.isRoot).toBe(false);
    });
  });

  describe('stable page keys', () => {
    it.each([
      [
        'https://example.com/',
        'https://example.com/',
        'DxFdsGK3wN0DCxaHjJnepcNUtJ3DezjriEYXnHeD6dc',
      ],
      [
        'https://example.com/path?b=2&a=1',
        'https://example.com/path?a=1&b=2',
        'lKsgh_TEzhnSSM-6ueKxnMUGXkQ1EPfzfKtzR6qn3ww',
      ],
    ])(
      'hashes the exact canonical URL bytes for %s',
      async (rawUrl, canonicalUrl, pageKey) => {
        const identity = await expectSupported(rawUrl);

        expect(identity.canonicalUrl).toBe(canonicalUrl);
        expect(identity.pageKey).toBe(pageKey);
        expect(identity.pageKey).not.toContain('=');
      },
    );

    it('returns byte-for-byte identical results across repeated calls', async () => {
      const inputs = [
        'https://example.com/path?z=2&a=%E2%9C%93&z=1#ignored',
        [{ origin: 'https://example.com', parameterNames: ['ignored'] }],
      ] as const;

      const first = await service.identify(...inputs);
      const second = await service.identify(...inputs);

      expect(second).toEqual(first);
    });
  });
});
