import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

import type { NoteRecordV1 } from '../domain/note';
import type { RemoteReplicaRepository } from './remoteReplicaRepository';
import { isNoteRecordV1, isPageKey } from './validation';

export const REMOTE_NOTE_KEY_PREFIX = 'pageperch/v1/notes/';
export const MAX_REMOTE_NOTE_BYTES = 16 * 1024 * 1024;

export type S3ReplicaOperation = 'configure' | 'get' | 'list' | 'put';

export type S3ReplicaErrorCode =
  | 'configuration-required'
  | 'credential-failed'
  | 'invalid-input'
  | 'invalid-remote-data'
  | 'remote-failed';

export class S3ReplicaRepositoryError extends Error {
  readonly code: S3ReplicaErrorCode;
  readonly operation: S3ReplicaOperation;

  constructor(
    code: S3ReplicaErrorCode,
    operation: S3ReplicaOperation,
    message: string,
  ) {
    super(message);
    this.name = 'S3ReplicaRepositoryError';
    this.code = code;
    this.operation = operation;
  }
}

export interface S3ReplicaTemporaryCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly bucket: string;
}

export interface S3ReplicaCredentialProvider {
  get(): Promise<S3ReplicaTemporaryCredentials>;
}

export interface S3ReplicaClientConfiguration {
  readonly credentials: {
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
  };
  readonly endpoint: string;
  readonly forcePathStyle: true;
  readonly region: string;
}

export type S3ReplicaCommand =
  GetObjectCommand | ListObjectsV2Command | PutObjectCommand;

export interface S3ReplicaClient {
  send(command: S3ReplicaCommand): Promise<unknown>;
  destroy?(): void;
}

export type S3ReplicaClientFactory = (
  configuration: S3ReplicaClientConfiguration,
) => S3ReplicaClient;

export interface S3ReplicaRepositoryDependencies {
  readonly clientFactory?: S3ReplicaClientFactory;
  readonly credentialProvider: S3ReplicaCredentialProvider;
  readonly endpoint: string;
  readonly region: string;
}

interface OperationContext {
  readonly bucket: string;
  readonly client: S3ReplicaClient;
}

function repositoryError(
  code: S3ReplicaErrorCode,
  operation: S3ReplicaOperation,
  message: string,
): S3ReplicaRepositoryError {
  return new S3ReplicaRepositoryError(code, operation, message);
}

function invalidRemoteData(
  operation: Extract<S3ReplicaOperation, 'get' | 'list'>,
): S3ReplicaRepositoryError {
  return repositoryError(
    'invalid-remote-data',
    operation,
    'Remote PagePerch note data is invalid or unsupported.',
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyTrimmed(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && value.trim() === value;
}

function isHttpsOrigin(value: string): boolean {
  try {
    const parsed = new URL(value);

    return (
      value.trim() === value &&
      parsed.protocol === 'https:' &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.origin === value &&
      parsed.pathname === '/' &&
      parsed.search === '' &&
      parsed.hash === ''
    );
  } catch {
    return false;
  }
}

function isRegion(value: string): boolean {
  return value.trim() === value && /^[a-z0-9]+(?:-[a-z0-9]+)+$/u.test(value);
}

function createDefaultS3Client(
  configuration: S3ReplicaClientConfiguration,
): S3ReplicaClient {
  const client = new S3Client(configuration);

  return {
    destroy: () => {
      client.destroy();
    },
    send: (command) => {
      if (command instanceof GetObjectCommand) {
        return client.send(command);
      }

      if (command instanceof ListObjectsV2Command) {
        return client.send(command);
      }

      return client.send(command);
    },
  };
}

export function getRemoteNoteKey(pageKey: string): string {
  return `${REMOTE_NOTE_KEY_PREFIX}${pageKey}.json`;
}

function pageKeyFromRemoteKey(
  key: unknown,
  operation: Extract<S3ReplicaOperation, 'get' | 'list'>,
): string {
  if (
    typeof key !== 'string' ||
    !key.startsWith(REMOTE_NOTE_KEY_PREFIX) ||
    !key.endsWith('.json')
  ) {
    throw invalidRemoteData(operation);
  }

  const pageKey = key.slice(REMOTE_NOTE_KEY_PREFIX.length, -'.json'.length);

  if (!isPageKey(pageKey) || getRemoteNoteKey(pageKey) !== key) {
    throw invalidRemoteData(operation);
  }

  return pageKey;
}

function cloneRecord(record: NoteRecordV1): NoteRecordV1 {
  return Object.freeze({ ...record });
}

function serializeRecord(record: NoteRecordV1): string {
  return JSON.stringify({
    schemaVersion: record.schemaVersion,
    pageKey: record.pageKey,
    canonicalUrl: record.canonicalUrl,
    representativeUrl: record.representativeUrl,
    origin: record.origin,
    title: record.title,
    contentHtml: record.contentHtml,
    contentHash: record.contentHash,
    savedAt: record.savedAt,
    revisionId: record.revisionId,
    ...(record.deletedAt === undefined ? {} : { deletedAt: record.deletedAt }),
  });
}

function assertByteLimit(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength > MAX_REMOTE_NOTE_BYTES) {
    throw invalidRemoteData('get');
  }

  return bytes;
}

function bytesFromArrayBufferView(value: ArrayBufferView): Uint8Array {
  return new Uint8Array(
    value.buffer,
    value.byteOffset,
    value.byteLength,
  ).slice();
}

async function bytesFromReadableStream(
  stream: ReadableStream<unknown>,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      let chunk: Uint8Array;

      if (value instanceof Uint8Array) {
        chunk = value;
      } else if (ArrayBuffer.isView(value)) {
        chunk = bytesFromArrayBufferView(value);
      } else if (value instanceof ArrayBuffer) {
        chunk = new Uint8Array(value);
      } else {
        throw invalidRemoteData('get');
      }

      total += chunk.byteLength;

      if (total > MAX_REMOTE_NOTE_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // Size validation remains authoritative even if stream cancellation fails.
        }

        throw invalidRemoteData('get');
      }

      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
}

async function readBodyBytes(body: unknown): Promise<Uint8Array> {
  if (typeof body === 'string') {
    return assertByteLimit(new TextEncoder().encode(body));
  }

  if (body instanceof Uint8Array) {
    return assertByteLimit(body.slice());
  }

  if (body instanceof ArrayBuffer) {
    return assertByteLimit(new Uint8Array(body).slice());
  }

  if (ArrayBuffer.isView(body)) {
    return assertByteLimit(bytesFromArrayBufferView(body));
  }

  if (isRecord(body)) {
    const transformToByteArray = body.transformToByteArray;

    if (typeof transformToByteArray === 'function') {
      const transformed: unknown = await Reflect.apply(
        transformToByteArray,
        body,
        [],
      );

      if (transformed instanceof Uint8Array) {
        return assertByteLimit(transformed.slice());
      }

      if (ArrayBuffer.isView(transformed)) {
        return assertByteLimit(bytesFromArrayBufferView(transformed));
      }

      if (transformed instanceof ArrayBuffer) {
        return assertByteLimit(new Uint8Array(transformed).slice());
      }

      throw invalidRemoteData('get');
    }

    const transformToString = body.transformToString;

    if (typeof transformToString === 'function') {
      const transformed: unknown = await Reflect.apply(
        transformToString,
        body,
        ['utf-8'],
      );

      if (typeof transformed !== 'string') {
        throw invalidRemoteData('get');
      }

      return assertByteLimit(new TextEncoder().encode(transformed));
    }
  }

  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    if (body.size > MAX_REMOTE_NOTE_BYTES) {
      throw invalidRemoteData('get');
    }

    return assertByteLimit(new Uint8Array(await body.arrayBuffer()));
  }

  if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) {
    return bytesFromReadableStream(body);
  }

  throw invalidRemoteData('get');
}

async function parseRemoteRecord(
  output: unknown,
  expectedPageKey: string,
  operation: Extract<S3ReplicaOperation, 'get' | 'list'>,
): Promise<NoteRecordV1> {
  if (!isRecord(output)) {
    throw invalidRemoteData(operation);
  }

  if (
    output.ContentLength !== undefined &&
    (typeof output.ContentLength !== 'number' ||
      !Number.isSafeInteger(output.ContentLength) ||
      output.ContentLength < 0 ||
      output.ContentLength > MAX_REMOTE_NOTE_BYTES)
  ) {
    throw invalidRemoteData(operation);
  }

  if (output.Body === undefined) {
    throw invalidRemoteData(operation);
  }

  let bytes: Uint8Array;
  let decoded: string;
  let parsed: unknown;

  try {
    bytes = await readBodyBytes(output.Body);
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    parsed = JSON.parse(decoded);
  } catch (error) {
    if (error instanceof S3ReplicaRepositoryError) {
      throw invalidRemoteData(operation);
    }

    throw invalidRemoteData(operation);
  }

  if (
    !isNoteRecordV1(parsed) ||
    parsed.pageKey !== expectedPageKey ||
    getRemoteNoteKey(parsed.pageKey) !== getRemoteNoteKey(expectedPageKey)
  ) {
    throw invalidRemoteData(operation);
  }

  return cloneRecord(parsed);
}

function isS3NotFound(error: unknown): boolean {
  if (!isRecord(error)) {
    return false;
  }

  const metadata = error.$metadata;
  const status =
    isRecord(metadata) && typeof metadata.httpStatusCode === 'number'
      ? metadata.httpStatusCode
      : undefined;
  const code =
    typeof error.Code === 'string'
      ? error.Code
      : typeof error.code === 'string'
        ? error.code
        : undefined;

  return (
    status === 404 ||
    error.name === 'NoSuchKey' ||
    error.name === 'NotFound' ||
    code === 'NoSuchKey' ||
    code === 'NotFound'
  );
}

export class S3ReplicaRepository implements RemoteReplicaRepository {
  readonly #clientFactory: S3ReplicaClientFactory;
  readonly #credentialProvider: S3ReplicaCredentialProvider;
  readonly #endpoint: string;
  readonly #region: string;

  constructor({
    clientFactory = createDefaultS3Client,
    credentialProvider,
    endpoint,
    region,
  }: S3ReplicaRepositoryDependencies) {
    if (!isHttpsOrigin(endpoint) || !isRegion(region)) {
      throw repositoryError(
        'configuration-required',
        'configure',
        'Remote replica configuration is invalid.',
      );
    }

    this.#clientFactory = clientFactory;
    this.#credentialProvider = credentialProvider;
    this.#endpoint = endpoint;
    this.#region = region;
  }

  async get(pageKey: string): Promise<NoteRecordV1 | undefined> {
    if (!isPageKey(pageKey)) {
      throw repositoryError(
        'invalid-input',
        'get',
        'A valid PagePerch page key is required.',
      );
    }

    return this.#withContext('get', async ({ bucket, client }) => {
      let output: unknown;

      try {
        output = await client.send(
          new GetObjectCommand({
            Bucket: bucket,
            Key: getRemoteNoteKey(pageKey),
          }),
        );
      } catch (error) {
        if (isS3NotFound(error)) {
          return undefined;
        }

        throw error;
      }

      return parseRemoteRecord(output, pageKey, 'get');
    });
  }

  async put(record: NoteRecordV1): Promise<void> {
    if (!isNoteRecordV1(record)) {
      throw repositoryError(
        'invalid-input',
        'put',
        'A valid PagePerch note record is required.',
      );
    }

    const snapshot = cloneRecord(record);
    const body = serializeRecord(snapshot);

    if (new TextEncoder().encode(body).byteLength > MAX_REMOTE_NOTE_BYTES) {
      throw repositoryError(
        'invalid-input',
        'put',
        'The PagePerch note record is too large for remote storage.',
      );
    }

    await this.#withContext('put', async ({ bucket, client }) => {
      await client.send(
        new PutObjectCommand({
          Body: body,
          Bucket: bucket,
          ContentType: 'application/json',
          Key: getRemoteNoteKey(snapshot.pageKey),
        }),
      );
    });
  }

  async listAll(): Promise<readonly NoteRecordV1[]> {
    return this.#withContext('list', async ({ bucket, client }) => {
      const listedPageKeys = new Set<string>();
      const seenContinuationTokens = new Set<string>();
      let continuationToken: string | undefined;

      while (true) {
        const output = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: REMOTE_NOTE_KEY_PREFIX,
            ...(continuationToken === undefined
              ? {}
              : { ContinuationToken: continuationToken }),
          }),
        );

        if (!isRecord(output)) {
          throw invalidRemoteData('list');
        }

        const contents = output.Contents === undefined ? [] : output.Contents;

        if (!Array.isArray(contents)) {
          throw invalidRemoteData('list');
        }

        for (const object of contents) {
          if (!isRecord(object)) {
            throw invalidRemoteData('list');
          }

          const pageKey = pageKeyFromRemoteKey(object.Key, 'list');

          if (listedPageKeys.has(pageKey)) {
            throw invalidRemoteData('list');
          }

          listedPageKeys.add(pageKey);
        }

        if (
          output.IsTruncated !== undefined &&
          typeof output.IsTruncated !== 'boolean'
        ) {
          throw invalidRemoteData('list');
        }

        if (output.IsTruncated !== true) {
          break;
        }

        const nextToken = output.NextContinuationToken;

        if (
          typeof nextToken !== 'string' ||
          nextToken === '' ||
          seenContinuationTokens.has(nextToken)
        ) {
          throw invalidRemoteData('list');
        }

        seenContinuationTokens.add(nextToken);
        continuationToken = nextToken;
      }

      const records: NoteRecordV1[] = [];

      for (const pageKey of [...listedPageKeys].sort()) {
        let output: unknown;

        try {
          output = await client.send(
            new GetObjectCommand({
              Bucket: bucket,
              Key: getRemoteNoteKey(pageKey),
            }),
          );
        } catch {
          throw repositoryError(
            'remote-failed',
            'list',
            'Remote PagePerch notes could not be listed safely. Retry.',
          );
        }

        records.push(await parseRemoteRecord(output, pageKey, 'list'));
      }

      return Object.freeze(records);
    });
  }

  async #createContext(
    operation: Extract<S3ReplicaOperation, 'get' | 'list' | 'put'>,
  ): Promise<OperationContext> {
    let credentials: S3ReplicaTemporaryCredentials;

    try {
      credentials = await this.#credentialProvider.get();
    } catch {
      throw repositoryError(
        'credential-failed',
        operation,
        'Temporary remote storage credentials are unavailable. Reconnect and retry.',
      );
    }

    if (
      !isRecord(credentials) ||
      !isNonEmptyTrimmed(credentials.accessKeyId) ||
      !isNonEmptyTrimmed(credentials.secretAccessKey) ||
      !isNonEmptyTrimmed(credentials.bucket) ||
      credentials.bucket.includes('/')
    ) {
      throw repositoryError(
        'credential-failed',
        operation,
        'Temporary remote storage credentials are invalid. Reconnect and retry.',
      );
    }

    let client: S3ReplicaClient;

    try {
      client = this.#clientFactory({
        credentials: {
          accessKeyId: credentials.accessKeyId,
          secretAccessKey: credentials.secretAccessKey,
        },
        endpoint: this.#endpoint,
        forcePathStyle: true,
        region: this.#region,
      });
    } catch {
      throw repositoryError(
        'remote-failed',
        operation,
        'Remote storage could not be prepared safely. Retry.',
      );
    }

    return { bucket: credentials.bucket, client };
  }

  async #withContext<T>(
    operation: Extract<S3ReplicaOperation, 'get' | 'list' | 'put'>,
    perform: (context: OperationContext) => Promise<T>,
  ): Promise<T> {
    const context = await this.#createContext(operation);

    try {
      return await perform(context);
    } catch (error) {
      if (error instanceof S3ReplicaRepositoryError) {
        throw error;
      }

      throw repositoryError(
        'remote-failed',
        operation,
        operation === 'list'
          ? 'Remote PagePerch notes could not be listed safely. Retry.'
          : operation === 'get'
            ? 'The remote PagePerch note could not be read safely. Retry.'
            : 'The remote PagePerch note could not be written safely. Retry.',
      );
    } finally {
      try {
        context.client.destroy?.();
      } catch {
        // Operation results remain authoritative; teardown failures expose no credential detail.
      }
    }
  }
}
