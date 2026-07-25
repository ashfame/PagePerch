import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';

import type { NoteRecordV1 } from '../domain/note';
import {
  getRemoteNoteKey,
  MAX_REMOTE_NOTE_BYTES,
  REMOTE_NOTE_KEY_PREFIX,
  S3ReplicaRepository,
  type S3ReplicaClientFactory,
  type S3ReplicaCommand,
  type S3ReplicaTemporaryCredentials,
} from './s3ReplicaRepository';

const ENDPOINT = 'https://byos.ashfame.com';
const REGION = 'us-east-1';
const PAGE_KEY_A = 'A'.repeat(43);
const PAGE_KEY_B = `${'B'.repeat(42)}E`;
const CONTENT_HASH = `${'C'.repeat(42)}I`;

function note(
  pageKey = PAGE_KEY_A,
  overrides: Partial<NoteRecordV1> = {},
): NoteRecordV1 {
  return {
    schemaVersion: 1,
    pageKey,
    canonicalUrl: `https://example.com/notes/${pageKey}`,
    representativeUrl: `https://example.com/notes/${pageKey}?view=editor`,
    origin: 'https://example.com',
    title: `Note ${pageKey.slice(0, 4)}`,
    contentHtml:
      '<!-- wp:paragraph --><p>Remote note</p><!-- /wp:paragraph -->',
    contentHash: CONTENT_HASH,
    savedAt: '2026-07-25T12:00:00.000Z',
    revisionId: `revision-${pageKey.slice(0, 4)}`,
    ...overrides,
  };
}

function temporaryCredentials(
  overrides: Partial<S3ReplicaTemporaryCredentials> = {},
): S3ReplicaTemporaryCredentials {
  return {
    accessKeyId: 'temporary-access-key',
    secretAccessKey: 'temporary-secret',
    bucket: 'issued-bucket-alias',
    ...overrides,
  };
}

function sdkBody(record: NoteRecordV1) {
  return {
    transformToByteArray: vi.fn(() =>
      Promise.resolve(new TextEncoder().encode(JSON.stringify(record))),
    ),
  };
}

function getOutput(record: NoteRecordV1, body: unknown = sdkBody(record)) {
  return {
    Body: body,
    ContentLength: new TextEncoder().encode(JSON.stringify(record)).byteLength,
  };
}

function harness(
  responder: (command: S3ReplicaCommand) => Promise<unknown> = () =>
    Promise.resolve({}),
  credentials: () => Promise<S3ReplicaTemporaryCredentials> = () =>
    Promise.resolve(temporaryCredentials()),
) {
  const send = vi.fn(responder);
  const destroy = vi.fn();
  const clientFactory = vi.fn<S3ReplicaClientFactory>(() => ({
    destroy,
    send,
  }));
  const getCredentials = vi.fn(credentials);
  const repository = new S3ReplicaRepository({
    clientFactory,
    credentialProvider: { get: getCredentials },
    endpoint: ENDPOINT,
    region: REGION,
  });

  return {
    clientFactory,
    destroy,
    getCredentials,
    repository,
    send,
  };
}

function commandInput(command: S3ReplicaCommand): Record<string, unknown> {
  return command.input as unknown as Record<string, unknown>;
}

describe('S3ReplicaRepository', () => {
  it('creates an operation-scoped SigV4-compatible path-style SDK client and exact get command', async () => {
    const record = note();
    const test = harness(() => Promise.resolve(getOutput(record)));

    await expect(test.repository.get(PAGE_KEY_A)).resolves.toEqual(record);

    expect(test.getCredentials).toHaveBeenCalledOnce();
    expect(test.clientFactory).toHaveBeenCalledWith({
      credentials: {
        accessKeyId: 'temporary-access-key',
        secretAccessKey: 'temporary-secret',
      },
      endpoint: ENDPOINT,
      forcePathStyle: true,
      region: REGION,
    });
    expect(test.clientFactory.mock.calls[0]?.[0]).not.toHaveProperty('bucket');
    expect(test.send).toHaveBeenCalledOnce();
    const command = test.send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(GetObjectCommand);
    expect(command === undefined ? undefined : commandInput(command)).toEqual({
      Bucket: 'issued-bucket-alias',
      Key: getRemoteNoteKey(PAGE_KEY_A),
    });
    expect(test.destroy).toHaveBeenCalledOnce();
  });

  it.each([
    ['SDK byte transform', (record: NoteRecordV1) => sdkBody(record)],
    [
      'SDK string transform',
      (record: NoteRecordV1) => ({
        transformToString: () => Promise.resolve(JSON.stringify(record)),
      }),
    ],
    [
      'Uint8Array',
      (record: NoteRecordV1) =>
        new TextEncoder().encode(JSON.stringify(record)),
    ],
    [
      'Blob',
      (record: NoteRecordV1) =>
        new Blob([JSON.stringify(record)], { type: 'application/json' }),
    ],
    [
      'ReadableStream',
      (record: NoteRecordV1) =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(JSON.stringify(record)),
            );
            controller.close();
          },
        }),
    ],
  ])(
    'reads a strict immutable record from a browser %s body',
    async (_label, makeBody) => {
      const record = note();
      const test = harness(() =>
        Promise.resolve({
          Body: makeBody(record),
        }),
      );

      const loaded = await test.repository.get(PAGE_KEY_A);

      expect(loaded).toEqual(record);
      expect(Object.isFrozen(loaded)).toBe(true);
      expect(() =>
        Object.assign(loaded ?? {}, { title: 'mutated after return' }),
      ).toThrow();
    },
  );

  it.each([
    [{ name: 'NoSuchKey' }],
    [{ name: 'NotFound' }],
    [{ Code: 'NoSuchKey' }],
    [{ code: 'NotFound' }],
    [{ $metadata: { httpStatusCode: 404 } }],
  ])('treats an S3 not-found response as absence', async (failure) => {
    const test = harness(() =>
      Promise.reject(Object.assign(new Error('not found'), failure)),
    );

    await expect(test.repository.get(PAGE_KEY_A)).resolves.toBeUndefined();
    expect(test.destroy).toHaveBeenCalledOnce();
  });

  it('propagates non-not-found get failure only as a sanitized stable error', async () => {
    const sentinel =
      'temporary-access-key temporary-secret oauth-token issued-bucket-alias private-body';
    const test = harness(() => Promise.reject(new Error(sentinel)));
    let thrown: unknown;

    try {
      await test.repository.get(PAGE_KEY_A);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      name: 'S3ReplicaRepositoryError',
      code: 'remote-failed',
      operation: 'get',
    });
    expect(String(thrown)).not.toContain(sentinel);
    expect(String(thrown)).not.toContain(PAGE_KEY_A);
    expect(String(thrown)).not.toMatch(
      /temporary-access-key|temporary-secret|oauth-token|issued-bucket-alias|private-body/u,
    );
    expect(thrown).not.toHaveProperty('cause');
  });

  it.each([
    ['missing body', {}],
    ['invalid UTF-8', { Body: new Uint8Array([0xc3, 0x28]) }],
    ['invalid JSON', { Body: '{private malformed body' }],
    [
      'invalid schema',
      {
        Body: JSON.stringify({
          ...note(),
          schemaVersion: 2,
        }),
      },
    ],
    ['record/key mismatch', { Body: JSON.stringify(note(PAGE_KEY_B)) }],
    [
      'invalid content length',
      {
        Body: JSON.stringify(note()),
        ContentLength: -1,
      },
    ],
    [
      'oversized content length',
      {
        Body: JSON.stringify(note()),
        ContentLength: MAX_REMOTE_NOTE_BYTES + 1,
      },
    ],
    [
      'unsupported transformed body',
      {
        Body: {
          transformToByteArray: () => Promise.resolve({ private: 'body' }),
        },
      },
    ],
  ])('rejects %s as sanitized invalid remote data', async (_label, output) => {
    const test = harness(() => Promise.resolve(output));
    let thrown: unknown;

    try {
      await test.repository.get(PAGE_KEY_A);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      name: 'S3ReplicaRepositoryError',
      code: 'invalid-remote-data',
      operation: 'get',
    });
    expect(String(thrown)).not.toMatch(
      /private|temporary-access-key|temporary-secret|issued-bucket-alias/u,
    );
  });

  it('writes an exact application/json PutObject snapshot and treats tombstones as ordinary puts', async () => {
    const tombstone = note(PAGE_KEY_A, {
      contentHtml: '',
      deletedAt: '2026-07-25T12:01:00.000Z',
      savedAt: '2026-07-25T12:01:00.000Z',
      revisionId: 'tombstone-revision',
    });
    const test = harness(() => Promise.resolve({}));

    await expect(test.repository.put(tombstone)).resolves.toBeUndefined();

    expect(test.send).toHaveBeenCalledOnce();
    const command = test.send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command === undefined ? undefined : commandInput(command)).toEqual({
      Body: JSON.stringify(tombstone),
      Bucket: 'issued-bucket-alias',
      ContentType: 'application/json',
      Key: `${REMOTE_NOTE_KEY_PREFIX}${PAGE_KEY_A}.json`,
    });
    expect(
      test.send.mock.calls.every(([sent]) => sent instanceof PutObjectCommand),
    ).toBe(true);
  });

  it('snapshots a put before asynchronous credential acquisition', async () => {
    let releaseCredentials:
      ((credentials: S3ReplicaTemporaryCredentials) => void) | undefined;
    const credentialsPending = new Promise<S3ReplicaTemporaryCredentials>(
      (resolve) => {
        releaseCredentials = resolve;
      },
    );
    const mutable = { ...note() };
    const test = harness(
      () => Promise.resolve({}),
      () => credentialsPending,
    );
    const putting = test.repository.put(mutable);

    mutable.title = 'mutated after put started';
    releaseCredentials?.(temporaryCredentials());
    await putting;

    const command = test.send.mock.calls[0]?.[0];
    const input = command === undefined ? undefined : commandInput(command);
    expect(JSON.parse(String(input?.Body))).toMatchObject({
      title: 'Note AAAA',
    });
  });

  it('round-trips an established large Gutenberg record above 8 MiB', async () => {
    const largeRecord = note(PAGE_KEY_A, {
      contentHtml: 'x'.repeat(9 * 1024 * 1024),
      revisionId: 'large-record-revision',
    });
    let storedBody: string | undefined;
    const test = harness((command) => {
      if (command instanceof PutObjectCommand) {
        if (typeof command.input.Body !== 'string') {
          return Promise.reject(new Error('Expected a string request body.'));
        }

        storedBody = command.input.Body;
        return Promise.resolve({});
      }

      return Promise.resolve({ Body: storedBody });
    });

    await test.repository.put(largeRecord);
    const loaded = await test.repository.get(PAGE_KEY_A);

    expect(loaded).toEqual(largeRecord);
    expect(loaded?.contentHtml).toHaveLength(9 * 1024 * 1024);
    expect(storedBody).toBeDefined();
  });

  it('rejects invalid and oversized puts before credentials or network side effects', async () => {
    const test = harness();

    await expect(
      test.repository.put(note('not-a-page-key')),
    ).rejects.toMatchObject({
      code: 'invalid-input',
      operation: 'put',
    });
    await expect(
      test.repository.put(
        note(PAGE_KEY_A, {
          contentHtml: 'x'.repeat(MAX_REMOTE_NOTE_BYTES),
        }),
      ),
    ).rejects.toMatchObject({
      code: 'invalid-input',
      operation: 'put',
    });
    expect(test.getCredentials).not.toHaveBeenCalled();
    expect(test.send).not.toHaveBeenCalled();
  });

  it('paginates under the exact prefix, validates every listed key, reads each object, and sorts snapshots', async () => {
    const recordA = note(PAGE_KEY_A);
    const recordB = note(PAGE_KEY_B);
    const responses: unknown[] = [
      {
        Contents: [{ Key: getRemoteNoteKey(PAGE_KEY_B) }],
        IsTruncated: true,
        NextContinuationToken: 'opaque-page-2',
      },
      {
        Contents: [{ Key: getRemoteNoteKey(PAGE_KEY_A) }],
        IsTruncated: false,
      },
      getOutput(recordA),
      getOutput(recordB),
    ];
    const test = harness(() => Promise.resolve(responses.shift()));

    const listed = await test.repository.listAll();

    expect(listed).toEqual([recordA, recordB]);
    expect(Object.isFrozen(listed)).toBe(true);
    expect(listed.every(Object.isFrozen)).toBe(true);
    expect(() => (listed as NoteRecordV1[]).push(note())).toThrow();
    expect(test.getCredentials).toHaveBeenCalledOnce();
    expect(test.clientFactory).toHaveBeenCalledOnce();
    expect(test.send).toHaveBeenCalledTimes(4);
    const commands = test.send.mock.calls.map(([command]) => command);
    expect(commands[0]).toBeInstanceOf(ListObjectsV2Command);
    expect(commandInput(commands[0] as S3ReplicaCommand)).toEqual({
      Bucket: 'issued-bucket-alias',
      Prefix: REMOTE_NOTE_KEY_PREFIX,
    });
    expect(commandInput(commands[1] as S3ReplicaCommand)).toEqual({
      Bucket: 'issued-bucket-alias',
      Prefix: REMOTE_NOTE_KEY_PREFIX,
      ContinuationToken: 'opaque-page-2',
    });
    expect(commands.slice(2).map((command) => commandInput(command))).toEqual([
      {
        Bucket: 'issued-bucket-alias',
        Key: getRemoteNoteKey(PAGE_KEY_A),
      },
      {
        Bucket: 'issued-bucket-alias',
        Key: getRemoteNoteKey(PAGE_KEY_B),
      },
    ]);
    expect(test.destroy).toHaveBeenCalledOnce();
  });

  it.each([
    ['missing key', {}],
    ['wrong prefix', { Key: `other/${PAGE_KEY_A}.json` }],
    [
      'nested key',
      { Key: `${REMOTE_NOTE_KEY_PREFIX}nested/${PAGE_KEY_A}.json` },
    ],
    ['wrong suffix', { Key: `${REMOTE_NOTE_KEY_PREFIX}${PAGE_KEY_A}.txt` }],
    ['invalid page key', { Key: `${REMOTE_NOTE_KEY_PREFIX}invalid.json` }],
  ])('rejects a listed object with %s', async (_label, listedObject) => {
    const test = harness(() => Promise.resolve({ Contents: [listedObject] }));

    await expect(test.repository.listAll()).rejects.toMatchObject({
      code: 'invalid-remote-data',
      operation: 'list',
    });
    expect(test.send).toHaveBeenCalledOnce();
  });

  it('rejects duplicate listed keys and unsafe continuation token states', async () => {
    const duplicate = harness(() =>
      Promise.resolve({
        Contents: [
          { Key: getRemoteNoteKey(PAGE_KEY_A) },
          { Key: getRemoteNoteKey(PAGE_KEY_A) },
        ],
      }),
    );
    await expect(duplicate.repository.listAll()).rejects.toMatchObject({
      code: 'invalid-remote-data',
    });

    const missingToken = harness(() => Promise.resolve({ IsTruncated: true }));
    await expect(missingToken.repository.listAll()).rejects.toMatchObject({
      code: 'invalid-remote-data',
    });

    const pages = [
      { IsTruncated: true, NextContinuationToken: 'same-token' },
      { IsTruncated: true, NextContinuationToken: 'same-token' },
    ];
    const repeatedToken = harness(() => Promise.resolve(pages.shift()));
    await expect(repeatedToken.repository.listAll()).rejects.toMatchObject({
      code: 'invalid-remote-data',
    });
    expect(repeatedToken.send).toHaveBeenCalledTimes(2);
  });

  it('fails listAll atomically when a later page or listed object read fails', async () => {
    const pageFailureResponses: unknown[] = [
      {
        Contents: [{ Key: getRemoteNoteKey(PAGE_KEY_A) }],
        IsTruncated: true,
        NextContinuationToken: 'private-token',
      },
      new Error('private second page body'),
    ];
    const pageFailure = harness(() => {
      const response = pageFailureResponses.shift();

      return response instanceof Error
        ? Promise.reject(response)
        : Promise.resolve(response);
    });
    await expect(pageFailure.repository.listAll()).rejects.toMatchObject({
      code: 'remote-failed',
      operation: 'list',
    });

    const getFailureResponses: unknown[] = [
      {
        Contents: [
          { Key: getRemoteNoteKey(PAGE_KEY_A) },
          { Key: getRemoteNoteKey(PAGE_KEY_B) },
        ],
      },
      getOutput(note(PAGE_KEY_A)),
      new Error('private listed object body'),
    ];
    const getFailure = harness(() => {
      const response = getFailureResponses.shift();

      return response instanceof Error
        ? Promise.reject(response)
        : Promise.resolve(response);
    });
    let thrown: unknown;

    try {
      await getFailure.repository.listAll();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      code: 'remote-failed',
      operation: 'list',
    });
    expect(String(thrown)).not.toMatch(
      /private|temporary-access-key|temporary-secret|issued-bucket-alias/u,
    );
    expect(getFailure.send).toHaveBeenCalledTimes(3);
  });

  it('acquires fresh credentials and bucket at each public operation without retaining them', async () => {
    const credentials = [
      temporaryCredentials({
        accessKeyId: 'access-one',
        secretAccessKey: 'secret-one',
        bucket: 'bucket-one',
      }),
      temporaryCredentials({
        accessKeyId: 'access-two',
        secretAccessKey: 'secret-two',
        bucket: 'bucket-two',
      }),
      temporaryCredentials({
        accessKeyId: 'access-three',
        secretAccessKey: 'secret-three',
        bucket: 'bucket-three',
      }),
    ];
    const record = note();
    const test = harness(
      (command) => {
        if (command instanceof GetObjectCommand) {
          return Promise.resolve(getOutput(record));
        }

        if (command instanceof ListObjectsV2Command) {
          return Promise.resolve({ Contents: [] });
        }

        return Promise.resolve({});
      },
      () =>
        Promise.resolve(
          credentials.shift() ?? temporaryCredentials({ bucket: 'unexpected' }),
        ),
    );

    await test.repository.get(PAGE_KEY_A);
    await test.repository.put(record);
    await test.repository.listAll();

    expect(test.getCredentials).toHaveBeenCalledTimes(3);
    expect(test.clientFactory).toHaveBeenCalledTimes(3);
    expect(
      test.clientFactory.mock.calls.map(([configuration]) => configuration),
    ).toEqual([
      {
        credentials: {
          accessKeyId: 'access-one',
          secretAccessKey: 'secret-one',
        },
        endpoint: ENDPOINT,
        forcePathStyle: true,
        region: REGION,
      },
      {
        credentials: {
          accessKeyId: 'access-two',
          secretAccessKey: 'secret-two',
        },
        endpoint: ENDPOINT,
        forcePathStyle: true,
        region: REGION,
      },
      {
        credentials: {
          accessKeyId: 'access-three',
          secretAccessKey: 'secret-three',
        },
        endpoint: ENDPOINT,
        forcePathStyle: true,
        region: REGION,
      },
    ]);
    expect(
      test.send.mock.calls.map(([command]) => commandInput(command).Bucket),
    ).toEqual(['bucket-one', 'bucket-two', 'bucket-three']);
    expect(test.destroy).toHaveBeenCalledTimes(3);
  });

  it('validates input and configuration before credential or client side effects', async () => {
    const test = harness();

    await expect(
      test.repository.get('private-invalid-key'),
    ).rejects.toMatchObject({
      code: 'invalid-input',
      operation: 'get',
    });
    expect(test.getCredentials).not.toHaveBeenCalled();

    const getCredentials = vi.fn(() => Promise.resolve(temporaryCredentials()));
    expect(
      () =>
        new S3ReplicaRepository({
          credentialProvider: { get: getCredentials },
          endpoint: 'http://private-endpoint.example',
          region: REGION,
        }),
    ).toThrowError(
      expect.objectContaining({
        code: 'configuration-required',
        operation: 'configure',
      }),
    );
    expect(getCredentials).not.toHaveBeenCalled();
  });

  it('sanitizes credential, credential-shape, and client-factory failures', async () => {
    const providerFailure = harness(
      () => Promise.resolve({}),
      () =>
        Promise.reject(
          new Error(
            'temporary-access-key temporary-secret oauth-token issued-bucket-alias',
          ),
        ),
    );
    await expect(
      providerFailure.repository.get(PAGE_KEY_A),
    ).rejects.toMatchObject({
      code: 'credential-failed',
    });

    const invalidCredentials = harness(
      () => Promise.resolve({}),
      () =>
        Promise.resolve(
          temporaryCredentials({ secretAccessKey: ' temporary-secret ' }),
        ),
    );
    await expect(
      invalidCredentials.repository.get(PAGE_KEY_A),
    ).rejects.toMatchObject({
      code: 'credential-failed',
    });

    const getCredentials = vi.fn(() => Promise.resolve(temporaryCredentials()));
    const repository = new S3ReplicaRepository({
      clientFactory: () => {
        throw new Error(
          'temporary-access-key temporary-secret issued-bucket-alias',
        );
      },
      credentialProvider: { get: getCredentials },
      endpoint: ENDPOINT,
      region: REGION,
    });
    let thrown: unknown;

    try {
      await repository.get(PAGE_KEY_A);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      code: 'remote-failed',
      operation: 'get',
    });
    expect(String(thrown)).not.toMatch(
      /temporary-access-key|temporary-secret|oauth-token|issued-bucket-alias/u,
    );
    expect(thrown).not.toHaveProperty('cause');
  });
});
