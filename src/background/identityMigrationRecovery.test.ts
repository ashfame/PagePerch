import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { NoteRecordV1 } from '../domain/note';
import type { PageIdentityExclusionRule } from '../domain/pageIdentity';
import type { SettingsRecordV1 } from '../domain/settings';
import { ChromeLocalIdentityMigrationPersistence } from '../repositories/chromeLocalIdentityMigrationPersistence';
import {
  ChromeLocalNoteRepository,
  getNoteOriginIndexStorageKey,
  getNoteStorageKey,
  NOTE_STORAGE_KEY_PREFIX,
} from '../repositories/chromeLocalNoteRepository';
import {
  ChromeLocalSettingsRepository,
  SETTINGS_STORAGE_KEY,
} from '../repositories/chromeLocalSettingsRepository';
import {
  planIdentityMigration,
  type PlannedIdentityMigration,
} from '../services/identityMigration';
import {
  createIdentityMigrationJournal,
  IDENTITY_MIGRATION_JOURNAL_STORAGE_KEY,
  type IdentityMigrationJournalPhase,
  type IdentityMigrationJournalV1,
} from '../services/identityMigrationPersistence';
import { DefaultPageIdentityService } from '../services/pageIdentity';
import { InMemoryChromeStorage } from '../../test/inMemoryChromeStorage';
import {
  recoverPendingIdentityMigration,
  recoverPendingIdentityMigrationForTest,
  type IdentityMigrationRecoveryTestOptions,
} from './identityMigrationRecovery';

const ORIGIN = 'https://example.com';
const PLANNED_AT = '2026-07-25T16:00:00.000Z';

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

function settings(
  pageIdentityExclusions: readonly PageIdentityExclusionRule[] = [],
  overrides: Partial<SettingsRecordV1> = {},
): SettingsRecordV1 {
  return {
    schemaVersion: 1,
    editorMode: 'text-focused-blocks',
    showRecentNotesOnOrigin: false,
    pageIdentityExclusions,
    ...overrides,
  };
}

async function note(
  rawUrl: string,
  currentSettings: SettingsRecordV1,
  title: string,
  contentHtml: string,
  overrides: Partial<NoteRecordV1> = {},
): Promise<NoteRecordV1> {
  const result = await new DefaultPageIdentityService().identify(
    rawUrl,
    currentSettings.pageIdentityExclusions,
  );

  if (result.status !== 'supported') {
    throw new Error('Expected a supported recovery fixture URL.');
  }

  return {
    schemaVersion: 1,
    pageKey: result.identity.pageKey,
    canonicalUrl: result.identity.canonicalUrl,
    representativeUrl: new URL(rawUrl).href,
    origin: result.identity.origin,
    title,
    contentHtml,
    contentHash: hash(contentHtml),
    savedAt: '2026-07-24T10:00:00.000Z',
    revisionId: `source-${hash(rawUrl).slice(0, 12)}`,
    ...overrides,
  };
}

function seededStorage(
  currentSettings: SettingsRecordV1,
  records: readonly NoteRecordV1[],
): InMemoryChromeStorage {
  const values: Record<string, unknown> = {
    [SETTINGS_STORAGE_KEY]: currentSettings,
  };
  const originPageKeys = new Map<string, string[]>();

  for (const record of records) {
    values[getNoteStorageKey(record.pageKey)] = record;
    const pageKeys = originPageKeys.get(record.origin) ?? [];
    pageKeys.push(record.pageKey);
    originPageKeys.set(record.origin, pageKeys);
  }

  for (const [origin, pageKeys] of originPageKeys) {
    values[getNoteOriginIndexStorageKey(origin)] = {
      schemaVersion: 1,
      origin,
      pageKeys: pageKeys.sort(),
    };
  }

  return new InMemoryChromeStorage(values);
}

async function collisionFixture(): Promise<{
  readonly current: SettingsRecordV1;
  readonly plan: PlannedIdentityMigration;
  readonly requested: SettingsRecordV1;
  readonly sources: readonly NoteRecordV1[];
}> {
  const current = settings();
  const requested = settings([{ origin: ORIGIN, parameterNames: ['variant'] }]);
  const sources = [
    await note(
      `${ORIGIN}/article?variant=one`,
      current,
      'Oldest title',
      '<!-- wp:paragraph -->\n<p>First private body</p>\n<!-- /wp:paragraph -->',
      {
        savedAt: '2026-07-23T10:00:00.000Z',
        revisionId: 'source-first',
      },
    ),
    await note(
      `${ORIGIN}/article?variant=two`,
      current,
      'Newer title',
      '<!-- wp:paragraph -->\n<p>Second private body</p>\n<!-- /wp:paragraph -->',
      {
        savedAt: '2026-07-24T10:00:00.000Z',
        revisionId: 'source-second',
      },
    ),
  ];
  let revision = 0;
  const plan = await planIdentityMigration({
    currentSettings: current,
    requestedSettings: requested,
    records: sources,
    clock: () => new Date(PLANNED_AT),
    operationIdFactory: () => 'recovery-operation',
    revisionIdFactory: () => `recovery-revision-${(revision += 1)}`,
    pageIdentityService: new DefaultPageIdentityService(),
  });

  if (plan.status !== 'planned') {
    throw new Error('Expected a planned recovery fixture.');
  }

  return { current, plan, requested, sources };
}

async function preparePhase(
  storage: InMemoryChromeStorage,
  plan: PlannedIdentityMigration,
  phase: IdentityMigrationJournalPhase,
): Promise<IdentityMigrationJournalV1> {
  const persistence = new ChromeLocalIdentityMigrationPersistence(storage);
  let journal = await createIdentityMigrationJournal(plan);
  await persistence.beginJournal(journal);

  if (phase !== 'planned') {
    journal = await persistence.applyDestinations(journal);
  }

  if (phase === 'tombstones-applied' || phase === 'settings-applied') {
    journal = await persistence.applyTombstones(journal);
  }

  if (phase === 'settings-applied') {
    journal = await persistence.applySettings(journal);
  }

  return journal;
}

function storedNotes(storage: InMemoryChromeStorage): readonly NoteRecordV1[] {
  return Object.entries(storage.snapshot())
    .filter(([storageKey]) => storageKey.startsWith(NOTE_STORAGE_KEY_PREFIX))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => value as NoteRecordV1);
}

describe('identity migration worker recovery', () => {
  it('uses chrome.storage.local by default and performs only a pending resume check', async () => {
    const storage = new InMemoryChromeStorage();
    vi.stubGlobal('chrome', { storage: { local: storage } });
    const randomUUID = vi.spyOn(crypto, 'randomUUID');

    await expect(recoverPendingIdentityMigration()).resolves.toEqual({
      status: 'no-op',
      reason: 'no-pending-operation',
    });
    expect(randomUUID).not.toHaveBeenCalled();
    expect(storage.setCalls).toEqual([]);
    expect(storage.removeCalls).toEqual([]);
  });

  it.each([
    'planned',
    'destinations-applied',
    'tombstones-applied',
    'settings-applied',
  ] as const)(
    'finishes a %s journal through the production dependency graph without regenerating planned note data',
    async (phase) => {
      const { current, plan, requested, sources } = await collisionFixture();
      const storage = seededStorage(current, sources);
      await preparePhase(storage, plan, phase);
      const randomUUID = vi
        .spyOn(crypto, 'randomUUID')
        .mockImplementation(() => {
          throw new Error('Recovery must not generate a new identifier.');
        });

      await expect(
        recoverPendingIdentityMigrationForTest({ storageArea: storage }),
      ).resolves.toEqual({
        status: 'resumed',
        operationId: plan.operationId,
        fromPhase: phase,
      });

      expect(randomUUID).not.toHaveBeenCalled();
      expect(
        storage.snapshot()[IDENTITY_MIGRATION_JOURNAL_STORAGE_KEY],
      ).toBeUndefined();
      expect(storage.snapshot()[SETTINGS_STORAGE_KEY]).toEqual(requested);
      expect(storedNotes(storage)).toEqual(
        [...plan.destinations, ...plan.sourceTombstones]
          .map(({ record }) => record)
          .sort((left, right) => left.pageKey.localeCompare(right.pageKey)),
      );
      const destinationContent = plan.destinations[0]?.record.contentHtml ?? '';
      expect(destinationContent.match(/wp:heading/gu)).toHaveLength(4);
      expect(destinationContent.match(/First private body/gu)).toHaveLength(1);
      expect(destinationContent.match(/Second private body/gu)).toHaveLength(1);
    },
  );

  it('blocks mutations that reach the shared storage lock after journal creation, then restores ordinary writes after recovery', async () => {
    const { current, plan, requested, sources } = await collisionFixture();
    const storage = seededStorage(current, sources);
    const persistence = new ChromeLocalIdentityMigrationPersistence(storage);
    const notes = new ChromeLocalNoteRepository(storage);
    const settingsRepository = new ChromeLocalSettingsRepository(storage);
    const lockRequest = vi.fn(
      (
        _name: string,
        _options: LockOptions,
        callback: () => Promise<unknown>,
      ) => callback(),
    );
    vi.stubGlobal('navigator', { locks: { request: lockRequest } });
    let releaseSave: (() => void) | undefined;
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const ordinary = await note(
      `${ORIGIN}/ordinary`,
      current,
      'Ordinary note',
      '<!-- wp:paragraph --><p>Ordinary body</p><!-- /wp:paragraph -->',
    );
    const saveStartedBeforeJournal = (async () => {
      await saveGate;
      return notes.put(ordinary);
    })();
    const journal = await createIdentityMigrationJournal(plan);

    await persistence.beginJournal(journal);
    releaseSave?.();

    await expect(saveStartedBeforeJournal).rejects.toMatchObject({
      name: 'RepositoryPendingIdentityMigrationError',
      code: 'pending-identity-migration',
      operation: 'put',
    });
    await expect(
      settingsRepository.put(
        settings(requested.pageIdentityExclusions, {
          editorMode: 'paragraphs-only',
        }),
      ),
    ).rejects.toMatchObject({
      name: 'RepositoryPendingIdentityMigrationError',
      code: 'pending-identity-migration',
      operation: 'put',
    });
    expect(storage.snapshot()).not.toHaveProperty(
      getNoteStorageKey(ordinary.pageKey),
    );

    await recoverPendingIdentityMigrationForTest({ storageArea: storage });

    await expect(notes.put(ordinary)).resolves.toBeUndefined();
    const postRecoverySettings = settings(requested.pageIdentityExclusions, {
      editorMode: 'paragraphs-only',
    });
    await expect(
      settingsRepository.put(postRecoverySettings),
    ).resolves.toBeUndefined();
    expect(storage.snapshot()[getNoteStorageKey(ordinary.pageKey)]).toEqual(
      ordinary,
    );
    expect(storage.snapshot()[SETTINGS_STORAGE_KEY]).toEqual(
      postRecoverySettings,
    );
    expect(lockRequest).toHaveBeenCalled();
    expect(
      lockRequest.mock.calls.every(
        ([name]) =>
          name === 'pageperch:v1:chrome-storage-repository-operations',
      ),
    ).toBe(true);
  });

  it('keeps an injected resumer confined to the explicit test seam', async () => {
    const outcome = {
      status: 'no-op',
      reason: 'no-pending-operation',
    } as const;
    const resumer = {
      resumePending: vi.fn(() => Promise.resolve(outcome)),
    };
    const options: IdentityMigrationRecoveryTestOptions = { resumer };

    await expect(
      recoverPendingIdentityMigrationForTest(options),
    ).resolves.toEqual(outcome);
    expect(resumer.resumePending).toHaveBeenCalledOnce();
  });
});
