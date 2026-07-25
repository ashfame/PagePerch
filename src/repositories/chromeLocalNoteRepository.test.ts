import { describe, expect, it } from 'vitest';

import type { NoteRecordV1 } from '../domain/note';
import { InMemoryChromeStorage } from '../../test/inMemoryChromeStorage';
import {
  ChromeLocalNoteRepository,
  getNoteOriginIndexStorageKey,
  getNoteStorageKey,
  NOTE_ORIGIN_INDEX_KEY_PREFIX,
  NOTE_STORAGE_KEY_PREFIX,
} from './chromeLocalNoteRepository';
import {
  RepositoryStoredDataError,
  RepositoryStorageError,
  RepositoryValidationError,
} from './repositoryErrors';
import { isPageKey } from './validation';

const PAGE_KEY_A = 'A'.repeat(43);
const PAGE_KEY_B = `${'B'.repeat(42)}A`;
const PAGE_KEY_C = `${'C'.repeat(42)}A`;
const PAGE_KEY_FUTURE = `${'F'.repeat(42)}A`;
const PAGE_KEY_MALFORMED = `${'M'.repeat(42)}A`;
const PAGE_KEY_MISSING = `${'N'.repeat(42)}A`;
const PAGE_KEY_OTHER = `${'O'.repeat(42)}A`;
const PAGE_KEY_PORT = `${'P'.repeat(42)}A`;
const PAGE_KEY_SUBDOMAIN = `${'S'.repeat(42)}A`;
const PAGE_KEY_HTTP = `${'T'.repeat(42)}A`;

function note(overrides: Partial<NoteRecordV1> = {}): NoteRecordV1 {
  return {
    schemaVersion: 1,
    pageKey: PAGE_KEY_A,
    canonicalUrl: 'https://example.com/a',
    representativeUrl: 'https://example.com/a?utm_source=reference',
    origin: 'https://example.com',
    title: 'Page A',
    contentHtml: '<!-- wp:paragraph --><p>A note</p><!-- /wp:paragraph -->',
    contentHash: 'hash-a',
    savedAt: '2026-07-25T10:00:00.000Z',
    revisionId: 'revision-a',
    ...overrides,
  };
}

function originIndex(
  origin: string,
  pageKeys: readonly string[],
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    origin,
    pageKeys,
  };
}

describe('ChromeLocalNoteRepository', () => {
  it('stores, gets, and lists one versioned record per exact page key', async () => {
    const storage = new InMemoryChromeStorage();
    const repository = new ChromeLocalNoteRepository(storage);
    const record = note();

    await repository.put(record);

    await expect(repository.get(record.pageKey)).resolves.toEqual(record);
    await expect(repository.listByOrigin(record.origin)).resolves.toEqual([
      record,
    ]);
    await expect(repository.listAll()).resolves.toEqual([record]);
    expect(storage.snapshot()[getNoteStorageKey(record.pageKey)]).toEqual(
      record,
    );
  });

  it('retains tombstones in origin and all-record listings', async () => {
    const repository = new ChromeLocalNoteRepository(
      new InMemoryChromeStorage(),
    );
    const tombstone = note({
      contentHtml: '',
      contentHash: 'empty-hash',
      deletedAt: '2026-07-25T10:00:00.000Z',
    });

    await repository.put(tombstone);

    await expect(repository.listByOrigin(tombstone.origin)).resolves.toEqual([
      tombstone,
    ]);
    await expect(repository.listAll()).resolves.toEqual([tombstone]);
  });

  it('physically deletes a current note and removes its origin membership', async () => {
    const storage = new InMemoryChromeStorage();
    const repository = new ChromeLocalNoteRepository(storage);
    await repository.put(note());

    await repository.delete(PAGE_KEY_A);

    await expect(repository.get(PAGE_KEY_A)).resolves.toBeUndefined();
    await expect(
      repository.listByOrigin('https://example.com'),
    ).resolves.toEqual([]);
    expect(storage.snapshot()).not.toHaveProperty(
      getNoteStorageKey(PAGE_KEY_A),
    );
  });

  it('treats physical deletion of a truly absent note as idempotent', async () => {
    const storage = new InMemoryChromeStorage();
    const repository = new ChromeLocalNoteRepository(storage);

    await expect(repository.delete(PAGE_KEY_MISSING)).resolves.toBeUndefined();
    expect(storage.setCalls).toEqual([]);
    expect(storage.removeCalls).toEqual([]);
  });

  it('repairs a dangling valid index when physical delete is retried after index-write failure', async () => {
    const storage = new InMemoryChromeStorage();
    const repository = new ChromeLocalNoteRepository(storage);
    await repository.put(note());
    storage.failNextSet(new Error('index write failed'));

    await expect(repository.delete(PAGE_KEY_A)).rejects.toBeInstanceOf(
      RepositoryStorageError,
    );
    expect(storage.snapshot()).not.toHaveProperty(
      getNoteStorageKey(PAGE_KEY_A),
    );
    expect(
      (
        storage.snapshot()[
          getNoteOriginIndexStorageKey('https://example.com')
        ] as { pageKeys: string[] }
      ).pageKeys,
    ).toContain(PAGE_KEY_A);

    await expect(repository.delete(PAGE_KEY_A)).resolves.toBeUndefined();
    await expect(
      repository.listByOrigin('https://example.com'),
    ).resolves.toEqual([]);
  });

  it('repairs only valid dangling indexes and preserves malformed or future indexes', async () => {
    const origin = 'https://example.com';
    const malformedIndexKey = `${NOTE_ORIGIN_INDEX_KEY_PREFIX}malformed`;
    const futureIndexKey = `${NOTE_ORIGIN_INDEX_KEY_PREFIX}future`;
    const malformedIndex = {
      schemaVersion: 1,
      origin: 'https://malformed.example',
      pageKeys: [PAGE_KEY_A, PAGE_KEY_A],
    };
    const futureIndex = {
      schemaVersion: 2,
      origin: 'https://future.example',
      pageKeys: [PAGE_KEY_A],
    };
    const storage = new InMemoryChromeStorage({
      [getNoteOriginIndexStorageKey(origin)]: originIndex(origin, [PAGE_KEY_A]),
      [malformedIndexKey]: malformedIndex,
      [futureIndexKey]: futureIndex,
    });
    const repository = new ChromeLocalNoteRepository(storage);

    await repository.delete(PAGE_KEY_A);

    expect(
      (
        storage.snapshot()[getNoteOriginIndexStorageKey(origin)] as {
          pageKeys: string[];
        }
      ).pageKeys,
    ).toEqual([]);
    expect(storage.snapshot()[malformedIndexKey]).toEqual(malformedIndex);
    expect(storage.snapshot()[futureIndexKey]).toEqual(futureIndex);
  });

  it('lists by exact origin through its index without scanning unrelated notes', async () => {
    const storage = new InMemoryChromeStorage();
    const repository = new ChromeLocalNoteRepository(storage);
    const exampleNote = note();
    const otherNote = note({
      pageKey: PAGE_KEY_OTHER,
      canonicalUrl: 'https://other.example/b',
      representativeUrl: 'https://other.example/b',
      origin: 'https://other.example',
      title: 'Other',
    });
    await repository.put(exampleNote);
    await repository.put(otherNote);
    storage.resetCalls();

    await expect(
      repository.listByOrigin('https://example.com'),
    ).resolves.toEqual([exampleNote]);

    expect(storage.getCalls).toEqual([
      getNoteOriginIndexStorageKey('https://example.com'),
      [getNoteStorageKey(PAGE_KEY_A)],
    ]);
    expect(storage.getCalls).not.toContain(null);
    expect(storage.getCalls.flat()).not.toContain(
      getNoteStorageKey(PAGE_KEY_OTHER),
    );
  });

  it.each([
    ['different scheme', 'http://example.com', PAGE_KEY_HTTP],
    ['different subdomain', 'https://www.example.com', PAGE_KEY_SUBDOMAIN],
    ['different non-default port', 'https://example.com:8443', PAGE_KEY_PORT],
  ])(
    'keeps %s in a separate origin index',
    async (_description, origin, pageKey) => {
      const repository = new ChromeLocalNoteRepository(
        new InMemoryChromeStorage(),
      );
      await repository.put(note());
      await repository.put(
        note({
          pageKey,
          origin,
          canonicalUrl: `${origin}/a`,
          representativeUrl: `${origin}/a`,
        }),
      );

      await expect(
        repository.listByOrigin('https://example.com'),
      ).resolves.toEqual([note()]);
      await expect(repository.listByOrigin(origin)).resolves.toHaveLength(1);
    },
  );

  it('moves a changed record between origin indexes in the same storage write', async () => {
    const storage = new InMemoryChromeStorage();
    const repository = new ChromeLocalNoteRepository(storage);
    await repository.put(note());
    storage.resetCalls();

    const moved = note({
      canonicalUrl: 'https://other.example/a',
      representativeUrl: 'https://other.example/a',
      origin: 'https://other.example',
      revisionId: 'revision-b',
      savedAt: '2026-07-25T10:01:00Z',
    });
    await repository.put(moved);

    await expect(
      repository.listByOrigin('https://example.com'),
    ).resolves.toEqual([]);
    await expect(
      repository.listByOrigin('https://other.example'),
    ).resolves.toEqual([moved]);
    expect(storage.setCalls).toHaveLength(1);
    expect(Object.keys(storage.setCalls[0] ?? {})).toEqual(
      expect.arrayContaining([
        getNoteStorageKey(PAGE_KEY_A),
        getNoteOriginIndexStorageKey('https://example.com'),
        getNoteOriginIndexStorageKey('https://other.example'),
      ]),
    );
  });

  it.each([
    [
      'malformed',
      { schemaVersion: 1, pageKey: PAGE_KEY_A, partial: true },
      'malformed',
    ],
    [
      'future',
      { schemaVersion: 9, pageKey: PAGE_KEY_A, futureData: true },
      'future-schema',
    ],
    ['key-mismatched', note({ pageKey: PAGE_KEY_B }), 'malformed'],
  ] as const)(
    'surfaces a typed recovery error from get for a %s owned record',
    async (_description, storedValue, expectedKind) => {
      const storageKey = getNoteStorageKey(PAGE_KEY_A);
      const storage = new InMemoryChromeStorage({
        [storageKey]: storedValue,
      });
      const repository = new ChromeLocalNoteRepository(storage);

      await expect(repository.get(PAGE_KEY_A)).rejects.toMatchObject({
        name: 'RepositoryStoredDataError',
        kind: expectedKind,
        storageKey,
      });
      expect(storage.snapshot()[storageKey]).toEqual(storedValue);
      expect(storage.removeCalls).toEqual([]);
    },
  );

  it('returns undefined only when the requested owned note key is truly missing', async () => {
    const repository = new ChromeLocalNoteRepository(
      new InMemoryChromeStorage({
        'another-extension:data': { pageKey: PAGE_KEY_A },
      }),
    );

    await expect(repository.get(PAGE_KEY_A)).resolves.toBeUndefined();
  });

  it.each([
    [
      'malformed',
      {
        schemaVersion: 1,
        origin: 'https://example.com',
        pageKeys: [PAGE_KEY_A, PAGE_KEY_A],
      },
      'malformed',
    ],
    [
      'future',
      {
        schemaVersion: 2,
        origin: 'https://example.com',
        pageKeys: [PAGE_KEY_A],
      },
      'future-schema',
    ],
  ] as const)(
    'surfaces a typed recovery error for a %s origin index',
    async (_description, storedIndex, expectedKind) => {
      const indexKey = getNoteOriginIndexStorageKey('https://example.com');
      const storage = new InMemoryChromeStorage({
        [indexKey]: storedIndex,
      });
      const repository = new ChromeLocalNoteRepository(storage);

      await expect(
        repository.listByOrigin('https://example.com'),
      ).rejects.toMatchObject({
        name: 'RepositoryStoredDataError',
        kind: expectedKind,
        storageKey: indexKey,
      });
      expect(storage.snapshot()[indexKey]).toEqual(storedIndex);
      expect(storage.removeCalls).toEqual([]);
    },
  );

  it('allows a harmless dangling index membership whose note is truly missing', async () => {
    const origin = 'https://example.com';
    const storage = new InMemoryChromeStorage({
      [getNoteOriginIndexStorageKey(origin)]: originIndex(origin, [
        PAGE_KEY_MISSING,
      ]),
    });
    const repository = new ChromeLocalNoteRepository(storage);

    await expect(repository.listByOrigin(origin)).resolves.toEqual([]);
  });

  it('orders an externally stored valid origin index by page-key code units without rewriting it', async () => {
    const origin = 'https://example.com';
    const uppercase = note({ pageKey: 'A'.repeat(43) });
    const underscore = note({ pageKey: `${'_'.repeat(42)}A` });
    const lowercase = note({ pageKey: `${'a'.repeat(42)}A` });
    const storedIndex = originIndex(origin, [
      lowercase.pageKey,
      uppercase.pageKey,
      underscore.pageKey,
    ]);
    const storage = new InMemoryChromeStorage({
      [getNoteOriginIndexStorageKey(origin)]: storedIndex,
      [getNoteStorageKey(uppercase.pageKey)]: uppercase,
      [getNoteStorageKey(underscore.pageKey)]: underscore,
      [getNoteStorageKey(lowercase.pageKey)]: lowercase,
    });
    const repository = new ChromeLocalNoteRepository(storage);

    await expect(repository.listByOrigin(origin)).resolves.toEqual([
      uppercase,
      underscore,
      lowercase,
    ]);
    expect(storage.snapshot()[getNoteOriginIndexStorageKey(origin)]).toEqual(
      storedIndex,
    );
    expect(storage.setCalls).toEqual([]);
  });

  it.each([
    [
      'malformed',
      { schemaVersion: 1, pageKey: PAGE_KEY_A, partial: true },
      'malformed',
    ],
    [
      'future',
      { schemaVersion: 2, pageKey: PAGE_KEY_A, futureData: true },
      'future-schema',
    ],
    ['key-mismatched', note({ pageKey: PAGE_KEY_B }), 'malformed'],
    [
      'wrong-origin',
      note({
        canonicalUrl: 'https://other.example/a',
        representativeUrl: 'https://other.example/a',
        origin: 'https://other.example',
      }),
      'malformed',
    ],
  ] as const)(
    'surfaces a typed recovery error for a %s indexed record',
    async (_description, storedRecord, expectedKind) => {
      const origin = 'https://example.com';
      const noteStorageKey = getNoteStorageKey(PAGE_KEY_A);
      const storage = new InMemoryChromeStorage({
        [noteStorageKey]: storedRecord,
        [getNoteOriginIndexStorageKey(origin)]: originIndex(origin, [
          PAGE_KEY_A,
        ]),
      });
      const repository = new ChromeLocalNoteRepository(storage);

      await expect(repository.listByOrigin(origin)).rejects.toMatchObject({
        name: 'RepositoryStoredDataError',
        kind: expectedKind,
        storageKey: noteStorageKey,
      });
      expect(storage.snapshot()[noteStorageKey]).toEqual(storedRecord);
      expect(storage.removeCalls).toEqual([]);
    },
  );

  it.each([
    [
      'malformed',
      getNoteStorageKey(PAGE_KEY_MALFORMED),
      { schemaVersion: 1, pageKey: PAGE_KEY_MALFORMED, partial: true },
      'malformed',
    ],
    [
      'future',
      getNoteStorageKey(PAGE_KEY_FUTURE),
      { schemaVersion: 7, pageKey: PAGE_KEY_FUTURE, futureData: true },
      'future-schema',
    ],
    [
      'key-mismatched',
      getNoteStorageKey(PAGE_KEY_A),
      note({ pageKey: PAGE_KEY_B }),
      'malformed',
    ],
    [
      'invalid-suffix',
      `${NOTE_STORAGE_KEY_PREFIX}not-an-exact-page-key`,
      note(),
      'malformed',
    ],
  ] as const)(
    'surfaces a typed recovery error from listAll for a %s owned value',
    async (_description, storageKey, storedValue, expectedKind) => {
      const storage = new InMemoryChromeStorage({
        [storageKey]: storedValue,
      });
      const repository = new ChromeLocalNoteRepository(storage);

      await expect(repository.listAll()).rejects.toMatchObject({
        name: 'RepositoryStoredDataError',
        kind: expectedKind,
        storageKey,
      });
      expect(storage.snapshot()[storageKey]).toEqual(storedValue);
      expect(storage.removeCalls).toEqual([]);
    },
  );

  it('preserves a malformed note and reports it instead of overwriting or deleting it', async () => {
    const storageKey = getNoteStorageKey(PAGE_KEY_A);
    const malformed = { schemaVersion: 1, pageKey: PAGE_KEY_A, partial: true };
    const storage = new InMemoryChromeStorage({ [storageKey]: malformed });
    const repository = new ChromeLocalNoteRepository(storage);

    await expect(repository.put(note())).rejects.toBeInstanceOf(
      RepositoryStoredDataError,
    );
    await expect(repository.delete(PAGE_KEY_A)).rejects.toBeInstanceOf(
      RepositoryStoredDataError,
    );
    expect(storage.snapshot()[storageKey]).toEqual(malformed);
  });

  it('isolates unrelated extension keys from owned note listings', async () => {
    const unrelated = {
      'another-extension:data': { private: true },
      'another-extension:pageperch:v1:notes:lookalike': note(),
    };
    const storage = new InMemoryChromeStorage(unrelated);
    const repository = new ChromeLocalNoteRepository(storage);
    await repository.put(note());

    await expect(repository.listAll()).resolves.toEqual([note()]);
    expect(storage.snapshot()).toMatchObject(unrelated);
  });

  it('serializes concurrent puts across repository instances without losing index membership', async () => {
    const storage = new InMemoryChromeStorage();
    const firstRepository = new ChromeLocalNoteRepository(storage);
    const secondRepository = new ChromeLocalNoteRepository(storage);
    const first = note();
    const second = note({
      pageKey: PAGE_KEY_B,
      canonicalUrl: 'https://example.com/b',
      representativeUrl: 'https://example.com/b',
      title: 'Page B',
      contentHash: 'hash-b',
      revisionId: 'revision-b',
    });

    await Promise.all([
      firstRepository.put(first),
      secondRepository.put(second),
    ]);

    await expect(
      firstRepository.listByOrigin('https://example.com'),
    ).resolves.toEqual([first, second]);
  });

  it('serializes interleaved physical deletes and puts', async () => {
    const repository = new ChromeLocalNoteRepository(
      new InMemoryChromeStorage(),
    );
    const second = note({
      pageKey: PAGE_KEY_B,
      canonicalUrl: 'https://example.com/b',
      representativeUrl: 'https://example.com/b',
    });
    const third = note({
      pageKey: PAGE_KEY_C,
      canonicalUrl: 'https://example.com/c',
      representativeUrl: 'https://example.com/c',
    });
    await repository.put(note());
    await repository.put(second);

    await Promise.all([repository.delete(PAGE_KEY_A), repository.put(third)]);

    await expect(
      repository.listByOrigin('https://example.com'),
    ).resolves.toEqual([second, third]);
  });

  it('uses deterministic code-unit ordering for origin and all-record listings', async () => {
    const repository = new ChromeLocalNoteRepository(
      new InMemoryChromeStorage(),
    );
    const uppercase = note({ pageKey: 'A'.repeat(43) });
    const underscore = note({ pageKey: `${'_'.repeat(42)}A` });
    const lowercase = note({ pageKey: `${'a'.repeat(42)}A` });

    await repository.put(lowercase);
    await repository.put(underscore);
    await repository.put(uppercase);

    await expect(
      repository.listByOrigin('https://example.com'),
    ).resolves.toEqual([uppercase, underscore, lowercase]);
    await expect(repository.listAll()).resolves.toEqual([
      uppercase,
      underscore,
      lowercase,
    ]);
  });

  it('stores large Gutenberg documents without truncation', async () => {
    const repository = new ChromeLocalNoteRepository(
      new InMemoryChromeStorage(),
    );
    const paragraph =
      '<!-- wp:paragraph --><p>Large local Gutenberg content.</p><!-- /wp:paragraph -->';
    const large = note({ contentHtml: paragraph.repeat(100_000) });

    await repository.put(large);

    const stored = await repository.get(large.pageKey);
    expect(stored?.contentHtml).toHaveLength(large.contentHtml.length);
    expect(stored?.contentHtml).toBe(large.contentHtml);
  });

  it('keeps duplicate puts idempotent without duplicate index entries', async () => {
    const storage = new InMemoryChromeStorage();
    const repository = new ChromeLocalNoteRepository(storage);
    const record = note();

    await repository.put(record);
    await repository.put(record);

    await expect(repository.listByOrigin(record.origin)).resolves.toEqual([
      record,
    ]);
    const index = storage.snapshot()[
      getNoteOriginIndexStorageKey(record.origin)
    ] as { pageKeys: string[] };
    expect(index.pageKeys).toEqual([PAGE_KEY_A]);
  });

  it('takes defensive input snapshots and returns mutation-isolated values', async () => {
    const repository = new ChromeLocalNoteRepository(
      new InMemoryChromeStorage(),
    );
    const input = note();
    const pendingPut = repository.put(input);
    (input as { title: string }).title = 'Mutated input';
    await pendingPut;

    const firstRead = await repository.get(PAGE_KEY_A);
    expect(firstRead?.title).toBe('Page A');
    (firstRead as { title: string }).title = 'Mutated result';

    await expect(repository.get(PAGE_KEY_A)).resolves.toMatchObject({
      title: 'Page A',
    });
    const listed = await repository.listAll();
    (listed[0] as { title: string }).title = 'Mutated listing';
    await expect(repository.get(PAGE_KEY_A)).resolves.toMatchObject({
      title: 'Page A',
    });
  });

  it('wraps storage failures with their cause and continues processing later mutations', async () => {
    const storage = new InMemoryChromeStorage();
    const repository = new ChromeLocalNoteRepository(storage);
    const readCause = new Error('storage unavailable');

    storage.failNextGet(readCause);
    await expect(repository.get(PAGE_KEY_A)).rejects.toMatchObject({
      name: 'RepositoryStorageError',
      operation: 'get',
      cause: readCause,
    });

    storage.failNextSet(new Error('quota exceeded'));
    await expect(repository.put(note())).rejects.toMatchObject({
      name: 'RepositoryStorageError',
      operation: 'put',
    });
    await expect(repository.put(note())).resolves.toBeUndefined();

    storage.failNextRemove(new Error('remove failed'));
    await expect(repository.delete(PAGE_KEY_A)).rejects.toBeInstanceOf(
      RepositoryStorageError,
    );
    await expect(repository.get(PAGE_KEY_A)).resolves.toEqual(note());
  });

  it.each([
    ['42 characters', 'A'.repeat(42)],
    ['44 characters', 'A'.repeat(44)],
    ['an invalid character', `${'A'.repeat(42)}!`],
    ['noncanonical terminal bits', `${'A'.repeat(42)}B`],
  ])('rejects a page-key argument with %s', async (_description, pageKey) => {
    const repository = new ChromeLocalNoteRepository(
      new InMemoryChromeStorage(),
    );

    await expect(repository.get(pageKey)).rejects.toBeInstanceOf(
      RepositoryValidationError,
    );
    await expect(repository.delete(pageKey)).rejects.toBeInstanceOf(
      RepositoryValidationError,
    );
  });

  it.each([
    ['42 characters', 'A'.repeat(42)],
    ['44 characters', 'A'.repeat(44)],
    ['an invalid character', `${'A'.repeat(42)}!`],
    ['noncanonical terminal bits', `${'A'.repeat(42)}B`],
  ])('rejects a record page key with %s', async (_description, pageKey) => {
    const repository = new ChromeLocalNoteRepository(
      new InMemoryChromeStorage(),
    );

    await expect(repository.put(note({ pageKey }))).rejects.toBeInstanceOf(
      RepositoryValidationError,
    );
  });

  it.each([
    ['42 characters', 'A'.repeat(42)],
    ['44 characters', 'A'.repeat(44)],
    ['an invalid character', `${'A'.repeat(42)}!`],
    ['noncanonical terminal bits', `${'A'.repeat(42)}B`],
  ])(
    'reports an origin index containing a page key with %s',
    async (_description, pageKey) => {
      const origin = 'https://example.com';
      const indexKey = getNoteOriginIndexStorageKey(origin);
      const storage = new InMemoryChromeStorage({
        [indexKey]: originIndex(origin, [pageKey]),
      });
      const repository = new ChromeLocalNoteRepository(storage);

      await expect(repository.listByOrigin(origin)).rejects.toMatchObject({
        name: 'RepositoryStoredDataError',
        kind: 'malformed',
        storageKey: indexKey,
      });
    },
  );

  it.each([...`AEIMQUYcgkosw048`])(
    'accepts canonical SHA-256 base64url terminal character %s',
    (terminalCharacter) => {
      expect(isPageKey(`${'A'.repeat(42)}${terminalCharacter}`)).toBe(true);
    },
  );

  it.each(['B', 'C', 'D', 'F', 'Z', 'a', 'z', '1', '9', '-', '_'])(
    'rejects alphabet-valid terminal character %s with nonzero padding bits',
    (terminalCharacter) => {
      expect(isPageKey(`${'A'.repeat(42)}${terminalCharacter}`)).toBe(false);
    },
  );

  it('rejects noncanonical page-key lengths and alphabet characters', () => {
    expect(isPageKey('A'.repeat(42))).toBe(false);
    expect(isPageKey('A'.repeat(43))).toBe(true);
    expect(isPageKey('A'.repeat(44))).toBe(false);
    expect(isPageKey(`${'A'.repeat(42)}!`)).toBe(false);
  });

  it.each([
    'DxFdsGK3wN0DCxaHjJnepcNUtJ3DezjriEYXnHeD6dc',
    'lKsgh_TEzhnSSM-6ueKxnMUGXkQ1EPfzfKtzR6qn3ww',
  ])('accepts PP-002 fixed SHA-256 page key %s', (pageKey) => {
    expect(isPageKey(pageKey)).toBe(true);
  });

  it.each([
    [
      'canonical URL credentials',
      'canonicalUrl',
      'https://user:password@example.com/a',
    ],
    [
      'representative URL credentials',
      'representativeUrl',
      'https://user@example.com/a',
    ],
    ['canonical URL fragment', 'canonicalUrl', 'https://example.com/a#section'],
    [
      'representative URL fragment',
      'representativeUrl',
      'https://example.com/a#',
    ],
    [
      'noncanonical canonical URL serialization',
      'canonicalUrl',
      'https://EXAMPLE.com:443/a',
    ],
    [
      'noncanonical representative URL serialization',
      'representativeUrl',
      'https://example.com/a b',
    ],
    [
      'an empty canonical query delimiter',
      'canonicalUrl',
      'https://example.com/a?',
    ],
    [
      'an empty representative query delimiter',
      'representativeUrl',
      'https://example.com/a?',
    ],
  ] as const)('rejects %s', async (_description, field, value) => {
    const repository = new ChromeLocalNoteRepository(
      new InMemoryChromeStorage(),
    );

    await expect(
      repository.put(note({ [field]: value })),
    ).rejects.toBeInstanceOf(RepositoryValidationError);
  });

  it('validates URL serialization while leaving query ordering and page-key recomputation to PageIdentityService', async () => {
    const repository = new ChromeLocalNoteRepository(
      new InMemoryChromeStorage(),
    );
    const record = note({
      canonicalUrl: 'https://example.com/a?z=2&a=1',
    });

    await expect(repository.put(record)).resolves.toBeUndefined();
    await expect(repository.get(PAGE_KEY_A)).resolves.toEqual(record);
  });

  it('rejects an impossible calendar timestamp even when it matches the UTC ISO shape', async () => {
    const repository = new ChromeLocalNoteRepository(
      new InMemoryChromeStorage(),
    );

    await expect(
      repository.put(note({ savedAt: '2026-02-30T10:00:00Z' })),
    ).rejects.toBeInstanceOf(RepositoryValidationError);
  });

  it('rejects invalid origin listings clearly', async () => {
    const repository = new ChromeLocalNoteRepository(
      new InMemoryChromeStorage(),
    );

    await expect(
      repository.listByOrigin('https://example.com/path'),
    ).rejects.toBeInstanceOf(RepositoryValidationError);
  });

  it('uses deterministic versioned storage paths', () => {
    expect(getNoteStorageKey(PAGE_KEY_A)).toBe(
      `${NOTE_STORAGE_KEY_PREFIX}${PAGE_KEY_A}`,
    );
    expect(getNoteOriginIndexStorageKey('https://example.com:8443')).toBe(
      'pageperch:v1:note-origin-indexes:https%3A%2F%2Fexample.com%3A8443',
    );
    expect(NOTE_ORIGIN_INDEX_KEY_PREFIX).not.toBe(NOTE_STORAGE_KEY_PREFIX);
  });
});
