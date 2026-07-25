import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type {
  NotePageInput,
  NoteRecordV1,
  SavePageDraftInput,
} from '../domain/note';
import type { PageIdentity } from '../domain/pageIdentity';
import type { NoteRepository } from '../repositories/noteRepository';
import { DefaultPageIdentityService } from './pageIdentity';
import {
  DefaultNoteService,
  normalizeGutenbergContent,
  NoteServiceValidationError,
  type NoteLocalMutationObserver,
} from './note';

const SAVED_AT = '2026-07-25T10:00:00.000Z';
const NEXT_SAVED_AT = '2026-07-25T10:01:00.000Z';
const CONTENT = '<!-- wp:paragraph -->\n<p>Hello</p>\n<!-- /wp:paragraph -->';
const EMPTY_CONTENT_HASH = '47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU';
const CONTENT_HASH = 'gMQ-9EpO7kKNozwfqm2aD0sFcyd0eidcokLn3moeVXc';

function independentHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

async function identify(rawUrl: string): Promise<PageIdentity> {
  const result = await new DefaultPageIdentityService().identify(rawUrl);

  if (result.status !== 'supported') {
    throw new Error(`Expected ${rawUrl} to have a supported identity.`);
  }

  return result.identity;
}

function pageInput(
  identity: PageIdentity,
  overrides: Partial<NotePageInput> = {},
): NotePageInput {
  return {
    identity,
    representativeUrl: identity.canonicalUrl,
    activeTabTitle: 'Example page',
    ...overrides,
  };
}

function draftInput(
  identity: PageIdentity,
  overrides: Partial<SavePageDraftInput> = {},
): SavePageDraftInput {
  return {
    ...pageInput(identity),
    contentHtml: CONTENT,
    ...overrides,
  };
}

function record(
  identity: PageIdentity,
  overrides: Partial<NoteRecordV1> = {},
): NoteRecordV1 {
  const contentHtml = overrides.contentHtml ?? CONTENT;

  return {
    schemaVersion: 1,
    pageKey: identity.pageKey,
    canonicalUrl: identity.canonicalUrl,
    representativeUrl: identity.canonicalUrl,
    origin: identity.origin,
    title: 'Example page',
    contentHtml,
    contentHash: independentHash(contentHtml),
    savedAt: SAVED_AT,
    revisionId: 'revision-1',
    ...overrides,
  };
}

class MemoryNoteRepository implements NoteRepository {
  readonly records = new Map<string, NoteRecordV1>();
  readonly getCalls: string[] = [];
  readonly putCalls: NoteRecordV1[] = [];
  readonly listByOriginCalls: string[] = [];
  getFailure?: Error;
  putFailure?: Error;
  listByOriginFailure?: Error;
  beforePut?: (record: NoteRecordV1) => Promise<void>;
  listedRecords?: readonly NoteRecordV1[];

  constructor(records: readonly NoteRecordV1[] = []) {
    for (const current of records) {
      this.records.set(current.pageKey, { ...current });
    }
  }

  get(pageKey: string): Promise<NoteRecordV1 | undefined> {
    this.getCalls.push(pageKey);

    if (this.getFailure !== undefined) {
      return Promise.reject(this.getFailure);
    }

    const current = this.records.get(pageKey);

    return Promise.resolve(current === undefined ? undefined : { ...current });
  }

  async put(current: NoteRecordV1): Promise<void> {
    const snapshot = { ...current };
    this.putCalls.push(snapshot);

    if (this.beforePut !== undefined) {
      await this.beforePut(snapshot);
    }

    if (this.putFailure !== undefined) {
      throw this.putFailure;
    }

    this.records.set(snapshot.pageKey, snapshot);
  }

  async putIfCurrent(
    expected: NoteRecordV1 | undefined,
    current: NoteRecordV1,
  ): Promise<'applied' | 'mismatch'> {
    const existing = this.records.get(current.pageKey);

    if (JSON.stringify(existing) !== JSON.stringify(expected)) {
      return 'mismatch';
    }

    await this.put(current);
    return 'applied';
  }

  delete(pageKey: string): Promise<void> {
    this.records.delete(pageKey);

    return Promise.resolve();
  }

  listByOrigin(origin: string): Promise<readonly NoteRecordV1[]> {
    this.listByOriginCalls.push(origin);

    if (this.listByOriginFailure !== undefined) {
      return Promise.reject(this.listByOriginFailure);
    }

    const values =
      this.listedRecords ??
      [...this.records.values()].filter((current) => current.origin === origin);

    return Promise.resolve(values.map((current) => ({ ...current })));
  }

  listAll(): Promise<readonly NoteRecordV1[]> {
    return Promise.resolve(
      [...this.records.values()].map((current) => ({ ...current })),
    );
  }
}

function createService(
  repository: NoteRepository,
  options: {
    readonly onLocalMutation?: NoteLocalMutationObserver;
    readonly savedAt?: string;
    readonly revisionId?: string;
  } = {},
): {
  readonly service: DefaultNoteService;
  readonly clock: ReturnType<typeof vi.fn<() => Date>>;
  readonly revisionIdFactory: ReturnType<typeof vi.fn<() => string>>;
} {
  const clock = vi.fn(() => new Date(options.savedAt ?? NEXT_SAVED_AT));
  const revisionIdFactory = vi.fn(() => options.revisionId ?? 'revision-2');

  return {
    service: new DefaultNoteService({
      repository,
      clock,
      onLocalMutation: options.onLocalMutation,
      revisionIdFactory,
    }),
    clock,
    revisionIdFactory,
  };
}

describe('normalizeGutenbergContent', () => {
  it('normalizes line endings and ignores outer serialization whitespace', () => {
    expect(
      normalizeGutenbergContent(
        ' \r\n<!-- wp:paragraph -->\r<p>Hello</p>\r\n<!-- /wp:paragraph -->\r\n ',
      ),
    ).toBe(CONTENT);
  });

  it.each([
    '',
    ' \r\n\t ',
    '<!-- wp:paragraph -->\n<p></p>\n<!-- /wp:paragraph -->',
    ' \r\n<!-- wp:paragraph -->\r\n<p> \t\r\n</p>\r\n<!-- /wp:paragraph --> \r\n',
  ])('recognizes untouched or cleared serialization %j', (contentHtml) => {
    expect(normalizeGutenbergContent(contentHtml)).toBe('');
  });

  it.each([
    '<!-- wp:paragraph -->\n<p><br></p>\n<!-- /wp:paragraph -->',
    '<!-- wp:paragraph -->\n<p>&nbsp;</p>\n<!-- /wp:paragraph -->',
    '<!-- wp:code -->\n<pre class="wp-block-code"><code>  \n</code></pre>\n<!-- /wp:code -->',
    '<!-- wp:preformatted -->\n<pre class="wp-block-preformatted">  \n</pre>\n<!-- /wp:preformatted -->',
  ])(
    'retains meaningful paragraph/code/preformatted content %j',
    (contentHtml) => {
      expect(normalizeGutenbergContent(contentHtml)).toBe(contentHtml);
    },
  );
});

describe('DefaultNoteService mutations', () => {
  it('creates one normalized local record with a deterministic content hash', async () => {
    const identity = await identify('https://example.com/path');
    const repository = new MemoryNoteRepository();
    const { service, clock, revisionIdFactory } = createService(repository);

    const result = await service.saveDraft(
      draftInput(identity, {
        activeTabTitle: '  Page title  ',
        representativeUrl:
          'https://user:secret@example.com/path?utm_source=mail&view=full#section',
        contentHtml:
          '\r\n<!-- wp:paragraph -->\r\n<p>Hello</p>\r\n<!-- /wp:paragraph --> \r\n',
      }),
    );

    expect(result).toEqual({
      status: 'saved',
      change: 'created',
      record: {
        schemaVersion: 1,
        pageKey: identity.pageKey,
        canonicalUrl: identity.canonicalUrl,
        representativeUrl: 'https://example.com/path?utm_source=mail&view=full',
        origin: identity.origin,
        title: 'Page title',
        contentHtml: CONTENT,
        contentHash: CONTENT_HASH,
        savedAt: NEXT_SAVED_AT,
        revisionId: 'revision-2',
      },
    });
    expect(repository.putCalls).toEqual([
      (result as { record: NoteRecordV1 }).record,
    ]);
    expect(clock).toHaveBeenCalledOnce();
    expect(revisionIdFactory).toHaveBeenCalledOnce();
  });

  it('runs the local-mutation observer after durable persistence inside same-page sequencing', async () => {
    const identity = await identify('https://example.com/observer-order');
    const repository = new MemoryNoteRepository();
    let releaseObserver = (): void => undefined;
    const observerGate = new Promise<void>((resolve) => {
      releaseObserver = resolve;
    });
    const observer = vi.fn(async (current: Readonly<NoteRecordV1>) => {
      expect(repository.records.get(current.pageKey)).toEqual(current);
      await observerGate;
    });
    const { service } = createService(repository, {
      onLocalMutation: observer,
    });

    const save = service.saveDraft(draftInput(identity));
    await vi.waitFor(() => {
      expect(observer).toHaveBeenCalledOnce();
    });
    const clear = service.clearPage(pageInput(identity));
    await Promise.resolve();
    expect(repository.getCalls).toEqual([identity.pageKey]);

    releaseObserver();
    await expect(save).resolves.toMatchObject({ status: 'saved' });
    await expect(clear).resolves.toMatchObject({
      status: 'saved',
      change: 'deleted',
    });
    expect(observer).toHaveBeenCalledTimes(2);
  });

  it('keeps a durable save successful when its observer fails and never observes unchanged saves', async () => {
    const identity = await identify('https://example.com/observer-failure');
    const repository = new MemoryNoteRepository();
    const observer = vi.fn<NoteLocalMutationObserver>(() => {
      throw new Error('worker messaging failed');
    });
    const { service } = createService(repository, {
      onLocalMutation: observer,
    });

    const saved = await service.saveDraft(draftInput(identity));
    const unchanged = await service.saveDraft(draftInput(identity));

    expect(saved).toMatchObject({ status: 'saved', change: 'created' });
    expect(unchanged).toMatchObject({ status: 'unchanged' });
    expect(observer).toHaveBeenCalledOnce();
    expect(Object.isFrozen(observer.mock.calls[0]?.[0])).toBe(true);
  });

  it.each([
    ['', EMPTY_CONTENT_HASH],
    ['abc', 'ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0'],
    [CONTENT, CONTENT_HASH],
  ])(
    'matches the independent SHA-256/base64url fixed vector for %j',
    async (contentHtml, expectedHash) => {
      const identity = await identify('https://example.com/vector');
      const existing = contentHtml === '' ? record(identity) : undefined;
      const repository = new MemoryNoteRepository(
        existing === undefined ? [] : [existing],
      );
      const { service } = createService(repository);

      const result =
        contentHtml === ''
          ? await service.clearPage(pageInput(identity))
          : await service.saveDraft(draftInput(identity, { contentHtml }));

      expect(result.status).toBe('saved');

      if (result.status === 'saved') {
        expect(result.record.contentHash).toBe(expectedHash);
        expect(result.record.contentHash).toBe(independentHash(contentHtml));
        expect(result.record.contentHash).toMatch(
          /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u,
        );
      }
    },
  );

  it('updates content and advances exactly one timestamp and revision', async () => {
    const identity = await identify('https://example.com/update');
    const existing = record(identity);
    const repository = new MemoryNoteRepository([existing]);
    const { service, clock, revisionIdFactory } = createService(repository);
    const updatedContent =
      '<!-- wp:paragraph -->\n<p>Updated</p>\n<!-- /wp:paragraph -->';

    const result = await service.saveDraft(
      draftInput(identity, { contentHtml: updatedContent }),
    );

    expect(result).toMatchObject({
      status: 'saved',
      change: 'updated',
      record: {
        contentHtml: updatedContent,
        contentHash: independentHash(updatedContent),
        savedAt: NEXT_SAVED_AT,
        revisionId: 'revision-2',
      },
    });
    expect(clock).toHaveBeenCalledOnce();
    expect(revisionIdFactory).toHaveBeenCalledOnce();
    expect(repository.putCalls).toHaveLength(1);
  });

  it('resurrects a tombstone and removes deletedAt', async () => {
    const identity = await identify('https://example.com/resurrect');
    const tombstone = record(identity, {
      contentHtml: '',
      contentHash: EMPTY_CONTENT_HASH,
      deletedAt: SAVED_AT,
    });
    const repository = new MemoryNoteRepository([tombstone]);
    const { service } = createService(repository);

    const result = await service.saveDraft(draftInput(identity));

    expect(result).toMatchObject({
      status: 'saved',
      change: 'resurrected',
      record: {
        contentHtml: CONTENT,
        contentHash: CONTENT_HASH,
        savedAt: NEXT_SAVED_AT,
        revisionId: 'revision-2',
      },
    });

    if (result.status === 'saved') {
      expect(result.record).not.toHaveProperty('deletedAt');
    }
  });

  it.each([
    '',
    ' \r\n\t ',
    '<!-- wp:paragraph -->\n<p></p>\n<!-- /wp:paragraph -->',
  ])(
    'does not create a record for untouched empty content %j',
    async (contentHtml) => {
      const identity = await identify('https://example.com/untouched');
      const repository = new MemoryNoteRepository();
      const { service, clock, revisionIdFactory } = createService(repository);

      await expect(
        service.saveDraft(draftInput(identity, { contentHtml })),
      ).resolves.toEqual({
        status: 'unchanged',
        reason: 'no-record',
      });
      expect(repository.getCalls).toEqual([identity.pageKey]);
      expect(repository.putCalls).toEqual([]);
      expect(clock).not.toHaveBeenCalled();
      expect(revisionIdFactory).not.toHaveBeenCalled();
    },
  );

  it('skips normalized unchanged content and metadata', async () => {
    const identity = await identify('https://example.com/unchanged');
    const existing = record(identity);
    const repository = new MemoryNoteRepository([existing]);
    const { service, clock, revisionIdFactory } = createService(repository);

    const result = await service.saveDraft(
      draftInput(identity, {
        contentHtml:
          ' \r\n<!-- wp:paragraph -->\r\n<p>Hello</p>\r\n<!-- /wp:paragraph -->\r\n',
      }),
    );

    expect(result).toEqual({
      status: 'unchanged',
      reason: 'unchanged',
      record: existing,
    });
    expect(repository.putCalls).toEqual([]);
    expect(clock).not.toHaveBeenCalled();
    expect(revisionIdFactory).not.toHaveBeenCalled();
  });

  it.each([
    [
      'title',
      { activeTabTitle: 'A changed title' },
      { title: 'A changed title' },
    ],
    [
      'representative URL',
      {
        representativeUrl: 'https://example.com/metadata?utm_source=active-tab',
      },
      {
        representativeUrl: 'https://example.com/metadata?utm_source=active-tab',
      },
    ],
  ] as const)(
    'persists a %s-only change',
    async (_description, inputOverride, expectedRecord) => {
      const identity = await identify('https://example.com/metadata');
      const existing = record(identity);
      const repository = new MemoryNoteRepository([existing]);
      const { service } = createService(repository);

      const result = await service.saveDraft(
        draftInput(identity, inputOverride),
      );

      expect(result).toMatchObject({
        status: 'saved',
        change: 'updated',
        record: {
          ...expectedRecord,
          savedAt: NEXT_SAVED_AT,
          revisionId: 'revision-2',
        },
      });
      expect(repository.putCalls).toHaveLength(1);
    },
  );

  it.each([
    ['https://example.com/', '/'],
    ['https://example.com/path', '/path'],
    ['https://example.com/path?view=full', '/path?view=full'],
    [
      'https://example.com/%E2%9C%93%20notes?name=a+b',
      '/%E2%9C%93%20notes?name=a+b',
    ],
  ])(
    'uses canonical path/query title fallback for %s',
    async (rawUrl, expectedTitle) => {
      const identity = await identify(rawUrl);
      const repository = new MemoryNoteRepository();
      const { service } = createService(repository);

      const result = await service.saveDraft(
        draftInput(identity, { activeTabTitle: ' \n\t ' }),
      );

      expect(result).toMatchObject({
        status: 'saved',
        record: { title: expectedTitle },
      });
    },
  );

  it('writes a full tombstone with one shared deletion timestamp and preserved metadata', async () => {
    const identity = await identify('https://example.com/delete');
    const existing = record(identity, {
      representativeUrl: 'https://example.com/delete?utm_source=original',
      title: 'Original title',
    });
    const repository = new MemoryNoteRepository([existing]);
    const { service, clock, revisionIdFactory } = createService(repository);

    const result = await service.clearPage(
      pageInput(identity, {
        representativeUrl: 'https://example.com/delete?view=new#fragment',
        activeTabTitle: 'Changed while clearing',
      }),
    );

    expect(result).toEqual({
      status: 'saved',
      change: 'deleted',
      record: {
        ...existing,
        contentHtml: '',
        contentHash: EMPTY_CONTENT_HASH,
        savedAt: NEXT_SAVED_AT,
        revisionId: 'revision-2',
        deletedAt: NEXT_SAVED_AT,
      },
    });
    expect(repository.putCalls).toEqual([
      (result as { record: NoteRecordV1 }).record,
    ]);
    expect(clock).toHaveBeenCalledOnce();
    expect(revisionIdFactory).toHaveBeenCalledOnce();
  });

  it('treats an empty draft as a logical clear', async () => {
    const identity = await identify('https://example.com/delete-from-save');
    const repository = new MemoryNoteRepository([record(identity)]);
    const { service } = createService(repository);

    await expect(
      service.saveDraft(draftInput(identity, { contentHtml: ' \r\n ' })),
    ).resolves.toMatchObject({
      status: 'saved',
      change: 'deleted',
      record: { deletedAt: NEXT_SAVED_AT },
    });
  });

  it('skips a repeated clear without changing tombstone metadata', async () => {
    const identity = await identify('https://example.com/deleted');
    const tombstone = record(identity, {
      contentHtml: '',
      contentHash: EMPTY_CONTENT_HASH,
      deletedAt: SAVED_AT,
    });
    const repository = new MemoryNoteRepository([tombstone]);
    const { service, clock, revisionIdFactory } = createService(repository);

    await expect(service.clearPage(pageInput(identity))).resolves.toEqual({
      status: 'unchanged',
      reason: 'already-deleted',
      record: tombstone,
    });
    expect(repository.putCalls).toEqual([]);
    expect(clock).not.toHaveBeenCalled();
    expect(revisionIdFactory).not.toHaveBeenCalled();
  });

  it.each(['clearPage', 'saveDraft'] as const)(
    'writes a first tombstone when %s receives an existing live empty record',
    async (operation) => {
      const identity = await identify(
        `https://example.com/live-empty-${operation}`,
      );
      const existing = record(identity, {
        contentHtml: '',
        contentHash: EMPTY_CONTENT_HASH,
      });
      const repository = new MemoryNoteRepository([existing]);
      const { service, clock, revisionIdFactory } = createService(repository);

      const result =
        operation === 'clearPage'
          ? await service.clearPage(pageInput(identity))
          : await service.saveDraft(
              draftInput(identity, {
                contentHtml:
                  '<!-- wp:paragraph -->\n<p></p>\n<!-- /wp:paragraph -->',
              }),
            );

      expect(result).toEqual({
        status: 'saved',
        change: 'deleted',
        record: {
          ...existing,
          savedAt: NEXT_SAVED_AT,
          revisionId: 'revision-2',
          deletedAt: NEXT_SAVED_AT,
        },
      });
      expect(repository.putCalls).toEqual([
        (result as { record: NoteRecordV1 }).record,
      ]);
      expect(clock).toHaveBeenCalledOnce();
      expect(revisionIdFactory).toHaveBeenCalledOnce();
    },
  );

  it('does not resolve success until the local write completes', async () => {
    const identity = await identify('https://example.com/local-first');
    const repository = new MemoryNoteRepository();
    let releasePut: (() => void) | undefined;
    const putBlocked = new Promise<void>((resolve) => {
      releasePut = resolve;
    });
    repository.beforePut = () => putBlocked;
    const { service } = createService(repository);
    let settled = false;

    const pending = service.saveDraft(draftInput(identity)).finally(() => {
      settled = true;
    });

    await vi.waitFor(() => {
      expect(repository.putCalls).toHaveLength(1);
    });
    expect(settled).toBe(false);
    releasePut?.();
    await expect(pending).resolves.toMatchObject({
      status: 'saved',
      change: 'created',
    });
    expect(settled).toBe(true);
  });

  it('serializes overlapping save and clear mutations for the same page', async () => {
    const identity = await identify('https://example.com/concurrent');
    const repository = new MemoryNoteRepository();
    let releaseFirstPut: (() => void) | undefined;
    const firstPutBlocked = new Promise<void>((resolve) => {
      releaseFirstPut = resolve;
    });
    repository.beforePut = async () => {
      if (repository.putCalls.length === 1) {
        await firstPutBlocked;
      }
    };
    const { service } = createService(repository);

    const save = service.saveDraft(draftInput(identity));
    await vi.waitFor(() => {
      expect(repository.putCalls).toHaveLength(1);
    });
    const clear = service.clearPage(pageInput(identity));
    await Promise.resolve();
    expect(repository.getCalls).toEqual([identity.pageKey]);

    releaseFirstPut?.();
    const [saveResult, clearResult] = await Promise.all([save, clear]);

    expect(saveResult).toMatchObject({ status: 'saved', change: 'created' });
    expect(clearResult).toMatchObject({ status: 'saved', change: 'deleted' });
    expect(repository.getCalls).toEqual([identity.pageKey, identity.pageKey]);
    expect(repository.records.get(identity.pageKey)).toMatchObject({
      contentHtml: '',
      deletedAt: NEXT_SAVED_AT,
    });
  });

  it('does not block mutations for different pages', async () => {
    const firstIdentity = await identify('https://example.com/first');
    const secondIdentity = await identify('https://example.com/second');
    const repository = new MemoryNoteRepository();
    let releaseFirstPut: (() => void) | undefined;
    const firstPutBlocked = new Promise<void>((resolve) => {
      releaseFirstPut = resolve;
    });
    repository.beforePut = async (current) => {
      if (current.pageKey === firstIdentity.pageKey) {
        await firstPutBlocked;
      }
    };
    const { service } = createService(repository);

    const firstSave = service.saveDraft(draftInput(firstIdentity));
    await vi.waitFor(() => {
      expect(repository.putCalls).toHaveLength(1);
    });
    const secondSave = service.saveDraft(draftInput(secondIdentity));

    await vi.waitFor(() => {
      expect(repository.putCalls).toHaveLength(2);
    });
    await expect(secondSave).resolves.toMatchObject({
      status: 'saved',
      change: 'created',
    });

    releaseFirstPut?.();
    await expect(firstSave).resolves.toMatchObject({
      status: 'saved',
      change: 'created',
    });
  });
});

describe('DefaultNoteService validation and failures', () => {
  it('reports malformed runtime inputs as promise rejections', async () => {
    const identity = await identify('https://example.com/runtime-input');
    const repository = new MemoryNoteRepository();
    const { service } = createService(repository);

    await expect(
      service.saveDraft(undefined as unknown as SavePageDraftInput),
    ).rejects.toMatchObject({ field: 'identity.pageKey' });
    await expect(
      service.saveDraft(
        draftInput(identity, {
          contentHtml: 7 as unknown as string,
        }),
      ),
    ).rejects.toMatchObject({ field: 'contentHtml' });
    expect(repository.getCalls).toEqual([]);
  });

  it.each([
    [
      'origin',
      (identity: PageIdentity) => ({
        ...identity,
        origin: 'https://other.example',
      }),
      'identity.origin',
    ],
    [
      'pathname',
      (identity: PageIdentity) => ({ ...identity, pathname: '/wrong' }),
      'identity.pathname',
    ],
    [
      'root flag',
      (identity: PageIdentity) => ({ ...identity, isRoot: true }),
      'identity.isRoot',
    ],
    [
      'canonical URL serialization',
      (identity: PageIdentity) => ({
        ...identity,
        canonicalUrl: 'https://user:secret@example.com/validate#fragment',
      }),
      'identity.canonicalUrl',
    ],
    [
      'canonical URL hash',
      (identity: PageIdentity) => ({
        ...identity,
        pageKey: `${'A'.repeat(42)}A`,
      }),
      'identity.pageKey',
    ],
  ] as const)(
    'rejects an invalid identity %s relationship before repository access',
    async (_description, mutateIdentity, expectedField) => {
      const identity = await identify('https://example.com/validate');
      const repository = new MemoryNoteRepository();
      const { service } = createService(repository);

      await expect(
        service.saveDraft(draftInput(mutateIdentity(identity))),
      ).rejects.toMatchObject({
        name: 'NoteServiceValidationError',
        field: expectedField,
      });
      expect(repository.getCalls).toEqual([]);
      expect(repository.putCalls).toEqual([]);
    },
  );

  it('rejects a canonical URL with an empty raw fragment before its correctly recomputed page key', async () => {
    const canonicalUrl = 'https://example.com/path#';
    const identity: PageIdentity = {
      canonicalUrl,
      isRoot: false,
      origin: 'https://example.com',
      pageKey: independentHash(canonicalUrl),
      pathname: '/path',
    };
    const repository = new MemoryNoteRepository();
    const { service } = createService(repository);

    await expect(
      service.saveDraft(
        draftInput(identity, {
          representativeUrl: 'https://example.com/path',
        }),
      ),
    ).rejects.toMatchObject({
      name: 'NoteServiceValidationError',
      field: 'identity.canonicalUrl',
    });
    expect(repository.getCalls).toEqual([]);
  });

  it('rejects a canonical URL with a raw empty query before its correctly recomputed page key', async () => {
    const canonicalUrl = 'https://example.com/path?';
    const identity: PageIdentity = {
      canonicalUrl,
      isRoot: false,
      origin: 'https://example.com',
      pageKey: independentHash(canonicalUrl),
      pathname: '/path',
    };
    const repository = new MemoryNoteRepository();
    const { service } = createService(repository);

    await expect(
      service.saveDraft(
        draftInput(identity, {
          representativeUrl: 'https://example.com/path',
        }),
      ),
    ).rejects.toMatchObject({
      name: 'NoteServiceValidationError',
      field: 'identity.canonicalUrl',
    });
    expect(repository.getCalls).toEqual([]);
  });

  it.each([
    ['cross-origin', 'https://other.example/path'],
    ['unsupported scheme', 'file:///tmp/note'],
    ['invalid', 'not a URL'],
  ])(
    'rejects a %s representative URL',
    async (_description, representativeUrl) => {
      const identity = await identify('https://example.com/representative');
      const repository = new MemoryNoteRepository();
      const { service } = createService(repository);

      await expect(
        service.saveDraft(draftInput(identity, { representativeUrl })),
      ).rejects.toBeInstanceOf(NoteServiceValidationError);
      expect(repository.getCalls).toEqual([]);
    },
  );

  it('rejects invalid page-key loads and origin listings before repository access', async () => {
    const repository = new MemoryNoteRepository();
    const { service } = createService(repository);

    await expect(service.loadLive('invalid')).rejects.toMatchObject({
      field: 'pageKey',
    });
    await expect(
      service.listRecentByOrigin('https://example.com/path'),
    ).rejects.toMatchObject({ field: 'origin' });
    expect(repository.getCalls).toEqual([]);
    expect(repository.listByOriginCalls).toEqual([]);
  });

  it('rejects a clock that does not return a valid Date before revision or write', async () => {
    const identity = await identify('https://example.com/clock');
    const repository = new MemoryNoteRepository();
    const revisionIdFactory = vi.fn(() => 'revision');
    const service = new DefaultNoteService({
      repository,
      clock: () => new Date(Number.NaN),
      revisionIdFactory,
    });

    await expect(service.saveDraft(draftInput(identity))).rejects.toMatchObject(
      {
        name: 'NoteServiceValidationError',
        field: 'clock',
      },
    );
    expect(revisionIdFactory).not.toHaveBeenCalled();
    expect(repository.putCalls).toEqual([]);
  });

  it.each(['', ' ', ' revision '])(
    'rejects invalid revision factory output %j before write',
    async (revisionId) => {
      const identity = await identify('https://example.com/revision');
      const repository = new MemoryNoteRepository();
      const service = new DefaultNoteService({
        repository,
        clock: () => new Date(NEXT_SAVED_AT),
        revisionIdFactory: () => revisionId,
      });

      await expect(
        service.saveDraft(draftInput(identity)),
      ).rejects.toMatchObject({
        name: 'NoteServiceValidationError',
        field: 'revisionIdFactory',
      });
      expect(repository.putCalls).toEqual([]);
    },
  );

  it('propagates repository read failure without generating a mutation version', async () => {
    const identity = await identify('https://example.com/read-failure');
    const repository = new MemoryNoteRepository();
    const failure = new Error('read failed');
    repository.getFailure = failure;
    const { service, clock, revisionIdFactory } = createService(repository);

    await expect(service.saveDraft(draftInput(identity))).rejects.toBe(failure);
    expect(clock).not.toHaveBeenCalled();
    expect(revisionIdFactory).not.toHaveBeenCalled();
    expect(repository.putCalls).toEqual([]);
  });

  it('propagates repository write failure instead of reporting local success', async () => {
    const identity = await identify('https://example.com/write-failure');
    const repository = new MemoryNoteRepository();
    const failure = new Error('write failed');
    repository.putFailure = failure;
    const { service } = createService(repository);

    await expect(service.saveDraft(draftInput(identity))).rejects.toBe(failure);
    expect(repository.records.has(identity.pageKey)).toBe(false);
  });

  it('propagates repository list failure', async () => {
    const repository = new MemoryNoteRepository();
    const failure = new Error('list failed');
    repository.listByOriginFailure = failure;
    const { service } = createService(repository);

    await expect(
      service.listRecentByOrigin('https://example.com'),
    ).rejects.toBe(failure);
  });

  it('continues a queued same-page mutation after the preceding write fails', async () => {
    const identity = await identify('https://example.com/retry');
    const repository = new MemoryNoteRepository();
    const failure = new Error('first write failed');
    let releaseFirstPut: (() => void) | undefined;
    const firstPutBlocked = new Promise<void>((resolve) => {
      releaseFirstPut = resolve;
    });
    repository.beforePut = async () => {
      if (repository.putCalls.length === 1) {
        await firstPutBlocked;
        throw failure;
      }
    };
    const { service } = createService(repository);

    const firstSave = service.saveDraft(draftInput(identity));
    const firstFailure = expect(firstSave).rejects.toBe(failure);
    await vi.waitFor(() => {
      expect(repository.putCalls).toHaveLength(1);
    });
    const secondContent =
      '<!-- wp:paragraph -->\n<p>Second save</p>\n<!-- /wp:paragraph -->';
    const secondSave = service.saveDraft(
      draftInput(identity, { contentHtml: secondContent }),
    );
    await Promise.resolve();
    expect(repository.getCalls).toEqual([identity.pageKey]);

    releaseFirstPut?.();
    await firstFailure;
    await expect(secondSave).resolves.toMatchObject({
      status: 'saved',
      change: 'created',
      record: {
        contentHtml: secondContent,
        contentHash: independentHash(secondContent),
      },
    });
    expect(repository.putCalls).toHaveLength(2);
  });
});

describe('DefaultNoteService reads and indexes', () => {
  it('loads a defensive live record and hides a tombstone as absence', async () => {
    const liveIdentity = await identify('https://example.com/live');
    const deletedIdentity = await identify('https://example.com/deleted');
    const live = record(liveIdentity);
    const deleted = record(deletedIdentity, {
      contentHtml: '',
      contentHash: EMPTY_CONTENT_HASH,
      deletedAt: SAVED_AT,
    });
    const repository = new MemoryNoteRepository([live, deleted]);
    const { service } = createService(repository);

    const loaded = await service.loadLive(liveIdentity.pageKey);

    expect(loaded).toEqual(live);
    expect(loaded).not.toBe(live);
    await expect(
      service.loadLive(deletedIdentity.pageKey),
    ).resolves.toBeUndefined();
  });

  it('filters tombstones and sorts exact-origin records by time, revision, then page key without mutation', async () => {
    const firstIdentity = await identify('https://example.com/first');
    const secondIdentity = await identify('https://example.com/second');
    const thirdIdentity = await identify('https://example.com/third');
    const fourthIdentity = await identify('https://example.com/fourth');
    const deletedIdentity = await identify('https://example.com/deleted');
    const first = record(firstIdentity, {
      savedAt: '2026-07-25T10:03:00Z',
      revisionId: 'revision-a',
    });
    const second = record(secondIdentity, {
      savedAt: '2026-07-25T10:03:00.000Z',
      revisionId: 'revision-z',
    });
    const third = record(thirdIdentity, {
      savedAt: '2026-07-25T10:02:00Z',
      revisionId: 'same-revision',
    });
    const fourth = record(fourthIdentity, {
      savedAt: '2026-07-25T10:02:00.000Z',
      revisionId: 'same-revision',
    });
    const deleted = record(deletedIdentity, {
      savedAt: '2026-07-25T10:04:00Z',
      contentHtml: '',
      contentHash: EMPTY_CONTENT_HASH,
      deletedAt: '2026-07-25T10:04:00Z',
    });
    const source = [third, deleted, first, fourth, second];
    const repository = new MemoryNoteRepository();
    repository.listedRecords = source;
    const { service } = createService(repository);

    const listed = await service.listRecentByOrigin('https://example.com');
    const equalRevisionPair = [third, fourth].sort((left, right) =>
      left.pageKey < right.pageKey ? -1 : 1,
    );

    expect(listed.map(({ pageKey }) => pageKey)).toEqual([
      second.pageKey,
      first.pageKey,
      ...equalRevisionPair.map(({ pageKey }) => pageKey),
    ]);
    expect(repository.listByOriginCalls).toEqual(['https://example.com']);
    expect(source).toEqual([third, deleted, first, fourth, second]);
    expect(listed[0]).not.toBe(second);
  });

  it('keeps a live origin-root record visible for the UI to include or omit', async () => {
    const rootIdentity = await identify('https://example.com/');
    const childIdentity = await identify('https://example.com/child');
    const deletedIdentity = await identify('https://example.com/deleted-child');
    const root = record(rootIdentity, {
      title: 'Origin root',
      savedAt: '2026-07-25T10:02:00Z',
    });
    const child = record(childIdentity, {
      title: 'Child',
      savedAt: '2026-07-25T10:01:00Z',
    });
    const deleted = record(deletedIdentity, {
      contentHtml: '',
      contentHash: EMPTY_CONTENT_HASH,
      deletedAt: '2026-07-25T10:03:00Z',
      savedAt: '2026-07-25T10:03:00Z',
    });
    const repository = new MemoryNoteRepository();
    repository.listedRecords = [deleted, child, root];
    const { service } = createService(repository);

    await expect(
      service.listRecentByOrigin('https://example.com'),
    ).resolves.toEqual([root, child]);
  });

  it('hashes and stores a large Gutenberg document without truncation', async () => {
    const identity = await identify('https://example.com/large');
    const repository = new MemoryNoteRepository();
    const { service } = createService(repository);
    const paragraph =
      '<!-- wp:paragraph -->\n<p>Large note.</p>\n<!-- /wp:paragraph -->';
    const contentHtml = paragraph.repeat(20_000);

    const result = await service.saveDraft(
      draftInput(identity, { contentHtml }),
    );

    expect(result).toMatchObject({
      status: 'saved',
      record: {
        contentHtml,
        contentHash: independentHash(contentHtml),
      },
    });
    expect(repository.records.get(identity.pageKey)?.contentHtml).toHaveLength(
      contentHtml.length,
    );
  });
});
