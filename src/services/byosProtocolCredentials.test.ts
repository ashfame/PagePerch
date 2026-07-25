import { describe, expect, it, vi } from 'vitest';

import {
  BYOS_PROTOCOL_CREDENTIALS_URL,
  DefaultByosProtocolCredentialIssuer,
  MemoryByosProtocolCredentialProvider,
  type ByosProtocolCredentials,
} from './byosProtocolCredentials';

const NOW = '2026-07-25T12:00:00.000Z';

function response(
  overrides: {
    readonly accessKeyId?: unknown;
    readonly secret?: unknown;
    readonly bucket?: unknown;
    readonly credentialExpiry?: unknown;
    readonly grantExpiry?: unknown;
    readonly protocolCredentialId?: unknown;
    readonly status?: number;
  } = {},
) {
  const accessKeyId = overrides.accessKeyId ?? 'byos-access-key';

  return {
    status: overrides.status ?? 200,
    body: {
      credential: {
        id: 'credential-1',
        protocol: 's3',
        access_key_id: accessKeyId,
        expires_at: overrides.credentialExpiry ?? '2026-07-25T13:00:00.000Z',
      },
      grant: {
        protocol: 's3',
        protocol_credential_id:
          overrides.protocolCredentialId ?? 'credential-1',
        external_alias: overrides.bucket ?? 'pageperch-bucket-alias',
        expires_at: overrides.grantExpiry ?? '2026-07-25T12:45:00.000Z',
      },
      access_key_id: accessKeyId,
      secret: overrides.secret ?? 'one-time-secret',
    },
  };
}

function credentials(
  overrides: Partial<ByosProtocolCredentials> = {},
): ByosProtocolCredentials {
  return {
    accessKeyId: 'access-key',
    secretAccessKey: 'memory-secret',
    bucket: 'bucket-alias',
    credentialId: 'credential-id',
    expiresAt: '2026-07-25T13:00:00.000Z',
    ...overrides,
  };
}

describe('BYOS protocol credential issuance', () => {
  it('posts the exact bearer-authenticated JSON request and returns the earliest expiry', async () => {
    const request = vi.fn(() => Promise.resolve(response()));
    const issuer = new DefaultByosProtocolCredentialIssuer(
      { request },
      () => new Date(NOW),
    );

    await expect(issuer.issue('oauth-access-token')).resolves.toEqual({
      accessKeyId: 'byos-access-key',
      secretAccessKey: 'one-time-secret',
      bucket: 'pageperch-bucket-alias',
      credentialId: 'credential-1',
      expiresAt: '2026-07-25T12:45:00.000Z',
    });
    expect(request).toHaveBeenCalledWith({
      url: BYOS_PROTOCOL_CREDENTIALS_URL,
      method: 'POST',
      headers: {
        Authorization: 'Bearer oauth-access-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        protocol: 's3',
        kind: 's3_access_key',
        label: 'PagePerch',
      }),
    });
  });

  it.each([
    ['HTTP status', response({ status: 403 })],
    ['missing access key', response({ accessKeyId: '' })],
    ['missing one-time secret', response({ secret: '' })],
    [
      'mismatched protocol credential',
      response({ protocolCredentialId: 'credential-2' }),
    ],
    ['invalid bucket alias', response({ bucket: 'private/path' })],
    [
      'expired credential',
      response({ credentialExpiry: '2026-07-25T12:00:30.000Z' }),
    ],
    ['expired grant', response({ grantExpiry: '2026-07-25T12:00:30.000Z' })],
  ])(
    'rejects %s without exposing credential material',
    async (_label, result) => {
      const sentinel = JSON.stringify(result);
      const issuer = new DefaultByosProtocolCredentialIssuer(
        { request: () => Promise.resolve(result) },
        () => new Date(NOW),
      );
      let thrown: unknown;

      try {
        await issuer.issue('sentinel-oauth-token');
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toMatchObject({
        name: 'ByosError',
        code: 'credential-failed',
      });
      expect(String(thrown)).not.toContain('sentinel-oauth-token');
      expect(String(thrown)).not.toContain(sentinel);
      expect(String(thrown)).not.toContain('one-time-secret');
    },
  );

  it('caches only usable in-memory credentials, refreshes early, and separates OAuth tokens', async () => {
    let now = new Date(NOW);
    let issue = 0;
    const issuer = {
      issue: vi.fn((accessToken: string) =>
        Promise.resolve(
          credentials({
            accessKeyId: `${accessToken}-${(issue += 1)}`,
          }),
        ),
      ),
    };
    const provider = new MemoryByosProtocolCredentialProvider(
      issuer,
      () => now,
    );

    const first = await provider.get('token-a');
    const cached = await provider.get('token-a');
    expect(cached).toEqual(first);
    expect(issuer.issue).toHaveBeenCalledTimes(1);

    await provider.get('token-b');
    expect(issuer.issue).toHaveBeenCalledTimes(2);

    now = new Date('2026-07-25T12:59:00.000Z');
    await provider.get('token-b');
    expect(issuer.issue).toHaveBeenCalledTimes(3);

    provider.clear();
    await provider.get('token-b');
    expect(issuer.issue).toHaveBeenCalledTimes(4);
  });

  it('coalesces concurrent issuance and never serializes its secret to storage', async () => {
    let resolveIssue: ((value: ByosProtocolCredentials) => void) | undefined;
    const pending = new Promise<ByosProtocolCredentials>((resolve) => {
      resolveIssue = resolve;
    });
    const issuer = { issue: vi.fn(() => pending) };
    const provider = new MemoryByosProtocolCredentialProvider(
      issuer,
      () => new Date(NOW),
    );
    const first = provider.get('token-a');
    const second = provider.get('token-a');

    expect(issuer.issue).toHaveBeenCalledOnce();
    resolveIssue?.(credentials());
    await expect(Promise.all([first, second])).resolves.toEqual([
      credentials(),
      credentials(),
    ]);
    expect(JSON.stringify({ durableStorage: {} })).not.toMatch(
      /memory-secret|access-key|bucket-alias/u,
    );
  });

  it('rejects credential material issued after clear and allows a fresh issuance', async () => {
    let resolveStale: ((value: ByosProtocolCredentials) => void) | undefined;
    const staleIssuance = new Promise<ByosProtocolCredentials>((resolve) => {
      resolveStale = resolve;
    });
    const issuer = {
      issue: vi
        .fn<(accessToken: string) => Promise<ByosProtocolCredentials>>()
        .mockReturnValueOnce(staleIssuance)
        .mockResolvedValueOnce(
          credentials({
            accessKeyId: 'fresh-access-key',
            secretAccessKey: 'fresh-secret',
          }),
        ),
    };
    const provider = new MemoryByosProtocolCredentialProvider(
      issuer,
      () => new Date(NOW),
    );
    const stale = provider.get('token-a');
    const settled = stale.then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    );

    provider.clear();
    resolveStale?.(
      credentials({
        accessKeyId: 'sentinel-stale-access-key',
        secretAccessKey: 'sentinel-stale-secret',
      }),
    );
    const { error } = await settled;

    expect(error).toMatchObject({
      name: 'ByosError',
      code: 'reconnect-required',
    });
    expect(String(error)).not.toMatch(/sentinel|access-key|secret/u);

    await expect(provider.get('token-a')).resolves.toMatchObject({
      accessKeyId: 'fresh-access-key',
      secretAccessKey: 'fresh-secret',
    });
    await expect(provider.get('token-a')).resolves.toMatchObject({
      accessKeyId: 'fresh-access-key',
      secretAccessKey: 'fresh-secret',
    });
    expect(issuer.issue).toHaveBeenCalledTimes(2);
  });
});
