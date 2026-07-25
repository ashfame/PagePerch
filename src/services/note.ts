import {
  NOTE_SCHEMA_VERSION,
  type NoteMutationResult,
  type NotePageInput,
  type NoteRecordV1,
  type NoteService,
  type SavePageDraftInput,
} from '../domain/note';
import type { PageIdentity } from '../domain/pageIdentity';
import type { NoteRepository } from '../repositories/noteRepository';
import {
  isExactHttpOrigin,
  isPageKey,
  isUtcIsoTimestamp,
} from '../repositories/validation';

export type NoteClock = () => Date;
export type NoteRevisionIdFactory = () => string;
export type NoteLocalMutationObserver = (
  record: Readonly<NoteRecordV1>,
) => Promise<void> | void;

export interface DefaultNoteServiceDependencies {
  readonly repository: NoteRepository;
  readonly clock?: NoteClock;
  readonly revisionIdFactory?: NoteRevisionIdFactory;
  readonly onLocalMutation?: NoteLocalMutationObserver;
}

export class NoteServiceValidationError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'NoteServiceValidationError';
    this.field = field;
  }
}

const EMPTY_GUTENBERG_PARAGRAPH =
  /^<!-- wp:paragraph -->\s*<p>\s*<\/p>\s*<!-- \/wp:paragraph -->$/u;

function compareCodeUnits(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
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

async function createSha256Hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );

  return encodeBase64Url(new Uint8Array(digest));
}

export function normalizeGutenbergContent(contentHtml: string): string {
  const normalized = contentHtml.replace(/\r\n?/gu, '\n');
  const serializationTrimmed = normalized.trim();

  return EMPTY_GUTENBERG_PARAGRAPH.test(serializationTrimmed)
    ? ''
    : serializationTrimmed;
}

function cloneRecord(record: NoteRecordV1): NoteRecordV1 {
  return { ...record };
}

function assertString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string') {
    throw new NoteServiceValidationError(field, `${field} must be a string.`);
  }
}

function parseCanonicalIdentityUrl(identity: PageIdentity): URL {
  assertString(identity.canonicalUrl, 'identity.canonicalUrl');

  let parsed: URL;

  try {
    parsed = new URL(identity.canonicalUrl);
  } catch {
    throw new NoteServiceValidationError(
      'identity.canonicalUrl',
      'The canonical URL must be an absolute HTTP(S) URL.',
    );
  }

  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.hash !== '' ||
    identity.canonicalUrl.includes('#') ||
    parsed.href !== identity.canonicalUrl ||
    (parsed.search === '' && identity.canonicalUrl.includes('?'))
  ) {
    throw new NoteServiceValidationError(
      'identity.canonicalUrl',
      'The canonical URL must use canonical HTTP(S) serialization without credentials or a fragment.',
    );
  }

  return parsed;
}

async function validateIdentity(identity: unknown): Promise<PageIdentity> {
  if (typeof identity !== 'object' || identity === null) {
    throw new NoteServiceValidationError(
      'identity',
      'A supported page identity is required.',
    );
  }

  const candidate = identity as PageIdentity;
  const parsed = parseCanonicalIdentityUrl(candidate);

  if (
    !isExactHttpOrigin(candidate.origin) ||
    candidate.origin !== parsed.origin
  ) {
    throw new NoteServiceValidationError(
      'identity.origin',
      'The identity origin must exactly match the canonical URL origin.',
    );
  }

  if (
    typeof candidate.pathname !== 'string' ||
    candidate.pathname !== parsed.pathname
  ) {
    throw new NoteServiceValidationError(
      'identity.pathname',
      'The identity pathname must exactly match the canonical URL pathname.',
    );
  }

  if (
    typeof candidate.isRoot !== 'boolean' ||
    candidate.isRoot !== (parsed.pathname === '/' && parsed.search === '')
  ) {
    throw new NoteServiceValidationError(
      'identity.isRoot',
      'The identity root flag must match its canonical path and query.',
    );
  }

  if (
    !isPageKey(candidate.pageKey) ||
    candidate.pageKey !== (await createSha256Hash(candidate.canonicalUrl))
  ) {
    throw new NoteServiceValidationError(
      'identity.pageKey',
      'The page key must be the canonical SHA-256/base64url hash of the canonical URL.',
    );
  }

  return candidate;
}

function sanitizeRepresentativeUrl(
  rawUrl: unknown,
  expectedOrigin: string,
): string {
  assertString(rawUrl, 'representativeUrl');

  let parsed: URL;

  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new NoteServiceValidationError(
      'representativeUrl',
      'The representative URL must be an absolute HTTP(S) URL.',
    );
  }

  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.origin !== expectedOrigin
  ) {
    throw new NoteServiceValidationError(
      'representativeUrl',
      'The representative URL must belong to the page identity exact origin.',
    );
  }

  return `${parsed.origin}${parsed.pathname}${parsed.search}`;
}

function createTitle(rawTitle: unknown, canonicalUrl: URL): string {
  assertString(rawTitle, 'activeTabTitle');

  const title = rawTitle.trim();

  return title === ''
    ? `${canonicalUrl.pathname}${canonicalUrl.search}`
    : title;
}

interface ValidatedPageInput {
  readonly identity: PageIdentity;
  readonly representativeUrl: string;
  readonly title: string;
}

async function validatePageInput(
  input: NotePageInput,
): Promise<ValidatedPageInput> {
  if (typeof input !== 'object' || input === null) {
    throw new NoteServiceValidationError(
      'input',
      'Page note input is required.',
    );
  }

  const identity = await validateIdentity(input.identity);
  const canonicalUrl = new URL(identity.canonicalUrl);

  return {
    identity,
    representativeUrl: sanitizeRepresentativeUrl(
      input.representativeUrl,
      identity.origin,
    ),
    title: createTitle(input.activeTabTitle, canonicalUrl),
  };
}

function hasSameLiveData(
  record: NoteRecordV1,
  input: ValidatedPageInput,
  contentHtml: string,
  contentHash: string,
): boolean {
  return (
    record.deletedAt === undefined &&
    record.pageKey === input.identity.pageKey &&
    record.canonicalUrl === input.identity.canonicalUrl &&
    record.representativeUrl === input.representativeUrl &&
    record.origin === input.identity.origin &&
    record.title === input.title &&
    record.contentHtml === contentHtml &&
    record.contentHash === contentHash
  );
}

function defaultRevisionIdFactory(): string {
  return crypto.randomUUID();
}

export class DefaultNoteService implements NoteService {
  readonly #repository: NoteRepository;
  readonly #clock: NoteClock;
  readonly #onLocalMutation: NoteLocalMutationObserver;
  readonly #revisionIdFactory: NoteRevisionIdFactory;
  readonly #pageMutations = new Map<string, Promise<void>>();

  constructor({
    repository,
    clock = () => new Date(),
    revisionIdFactory = defaultRevisionIdFactory,
    onLocalMutation = () => undefined,
  }: DefaultNoteServiceDependencies) {
    this.#repository = repository;
    this.#clock = clock;
    this.#revisionIdFactory = revisionIdFactory;
    this.#onLocalMutation = onLocalMutation;
  }

  async loadLive(pageKey: string): Promise<NoteRecordV1 | undefined> {
    if (!isPageKey(pageKey)) {
      throw new NoteServiceValidationError(
        'pageKey',
        'The page key must be a canonical SHA-256/base64url digest.',
      );
    }

    const record = await this.#repository.get(pageKey);

    return record === undefined || record.deletedAt !== undefined
      ? undefined
      : cloneRecord(record);
  }

  async saveDraft(input: SavePageDraftInput): Promise<NoteMutationResult> {
    const pageKey = this.#readMutationPageKey(input);

    return this.#enqueuePageMutation(pageKey, async () => {
      assertString(input.contentHtml, 'contentHtml');

      return this.#saveValidated(input, input.contentHtml);
    });
  }

  async clearPage(input: NotePageInput): Promise<NoteMutationResult> {
    const pageKey = this.#readMutationPageKey(input);

    return this.#enqueuePageMutation(pageKey, () =>
      this.#saveValidated(input, ''),
    );
  }

  async listRecentByOrigin(origin: string): Promise<readonly NoteRecordV1[]> {
    if (!isExactHttpOrigin(origin)) {
      throw new NoteServiceValidationError(
        'origin',
        'The origin must be an exact normalized HTTP(S) origin.',
      );
    }

    const records = await this.#repository.listByOrigin(origin);

    return records
      .filter((record) => record.deletedAt === undefined)
      .map(cloneRecord)
      .sort((left, right) => {
        const savedAtComparison =
          new Date(right.savedAt).valueOf() - new Date(left.savedAt).valueOf();

        if (savedAtComparison !== 0) {
          return savedAtComparison;
        }

        const revisionComparison = compareCodeUnits(
          right.revisionId,
          left.revisionId,
        );

        return revisionComparison === 0
          ? compareCodeUnits(left.pageKey, right.pageKey)
          : revisionComparison;
      });
  }

  #readMutationPageKey(input: NotePageInput): string {
    if (
      typeof input !== 'object' ||
      input === null ||
      typeof input.identity !== 'object' ||
      input.identity === null ||
      typeof input.identity.pageKey !== 'string'
    ) {
      throw new NoteServiceValidationError(
        'identity.pageKey',
        'A page key is required to sequence the page mutation.',
      );
    }

    return input.identity.pageKey;
  }

  #enqueuePageMutation(
    pageKey: string,
    operation: () => Promise<NoteMutationResult>,
  ): Promise<NoteMutationResult> {
    const predecessor = this.#pageMutations.get(pageKey) ?? Promise.resolve();
    const result = predecessor.then(operation, operation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );

    this.#pageMutations.set(pageKey, settled);
    void settled.then(() => {
      if (this.#pageMutations.get(pageKey) === settled) {
        this.#pageMutations.delete(pageKey);
      }
    });

    return result;
  }

  async #saveValidated(
    input: NotePageInput,
    rawContentHtml: string,
  ): Promise<NoteMutationResult> {
    const validated = await validatePageInput(input);
    const contentHtml = normalizeGutenbergContent(rawContentHtml);
    const contentHash = await createSha256Hash(contentHtml);
    const existing = await this.#repository.get(validated.identity.pageKey);

    if (existing === undefined && contentHtml === '') {
      return {
        status: 'unchanged',
        reason: 'no-record',
      };
    }

    if (existing?.deletedAt !== undefined && contentHtml === '') {
      return {
        status: 'unchanged',
        reason: 'already-deleted',
        record: cloneRecord(existing),
      };
    }

    if (
      contentHtml !== '' &&
      existing !== undefined &&
      hasSameLiveData(existing, validated, contentHtml, contentHash)
    ) {
      return {
        status: 'unchanged',
        reason: 'unchanged',
        record: cloneRecord(existing),
      };
    }

    const { savedAt, revisionId } = this.#createMutationVersion();
    let record: NoteRecordV1;
    let change: 'created' | 'updated' | 'deleted' | 'resurrected';

    if (existing !== undefined && contentHtml === '') {
      // Product decision: retain a full tombstone indefinitely so an older replica cannot resurrect a cleared note.
      record = {
        ...existing,
        contentHtml: '',
        contentHash,
        savedAt,
        revisionId,
        deletedAt: savedAt,
      };
      change = 'deleted';
    } else {
      record = {
        schemaVersion: NOTE_SCHEMA_VERSION,
        pageKey: validated.identity.pageKey,
        canonicalUrl: validated.identity.canonicalUrl,
        representativeUrl: validated.representativeUrl,
        origin: validated.identity.origin,
        title: validated.title,
        contentHtml,
        contentHash,
        savedAt,
        revisionId,
      };
      change =
        existing === undefined
          ? 'created'
          : existing.deletedAt === undefined
            ? 'updated'
            : 'resurrected';
    }

    await this.#repository.put(record);

    try {
      await this.#onLocalMutation(Object.freeze(cloneRecord(record)));
    } catch {
      // Local persistence is authoritative; later triggers can recover a failed observer notification.
    }

    return {
      status: 'saved',
      change,
      record: cloneRecord(record),
    };
  }

  #createMutationVersion(): {
    readonly savedAt: string;
    readonly revisionId: string;
  } {
    const clockValue = this.#clock();

    if (!(clockValue instanceof Date) || Number.isNaN(clockValue.valueOf())) {
      throw new NoteServiceValidationError(
        'clock',
        'The note clock must return a valid Date.',
      );
    }

    // Product decision: only an actual local write advances conflict time, so unchanged autosaves cannot win reconciliation.
    const savedAt = clockValue.toISOString();

    if (!isUtcIsoTimestamp(savedAt)) {
      throw new NoteServiceValidationError(
        'clock',
        'The note clock must produce a UTC ISO timestamp.',
      );
    }

    const revisionId = this.#revisionIdFactory();

    if (
      typeof revisionId !== 'string' ||
      revisionId.length === 0 ||
      revisionId.trim() !== revisionId
    ) {
      throw new NoteServiceValidationError(
        'revisionIdFactory',
        'The revision ID factory must return a non-empty string without surrounding whitespace.',
      );
    }

    return { savedAt, revisionId };
  }
}
