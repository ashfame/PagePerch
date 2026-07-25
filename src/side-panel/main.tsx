import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { readByosClientConfig } from '../background/byosClient';
import {
  requestSyncFollowUp,
  SyncRuntimeMessagePort,
} from '../background/syncRuntimeMessages';
import { ChromeLocalNoteRepository } from '../repositories/chromeLocalNoteRepository';
import { ChromeLocalSettingsRepository } from '../repositories/chromeLocalSettingsRepository';
import { ChromeLocalSyncQueue } from '../repositories/chromeLocalSyncQueue';
import { DefaultNoteService } from '../services/note';
import { DefaultPageIdentityService } from '../services/pageIdentity';
import { SidePanelApp, type CreateActivePageSessionController } from './App';
import { PageNoteEditor } from './PageNoteEditor';
import { ActivePageSessionController } from './activePageSession';
import { ChromeActivePageTabs } from './chromeActivePageTabs';
import { ChromeCanonicalPageOpener } from './chromeCanonicalPageOpener';
import { ChromeRecentNoteChanges } from './chromeRecentNoteChanges';
import {
  PageNoteDraftController,
  PendingPageSaveCoordinator,
} from './pageNoteDraft';
import {
  DefaultPageNoteOwnership,
  type CreatePageNoteDraftRuntime,
  type RegisterPendingPageSave,
} from './pageNoteOwnership';
import { DefaultRootRecentNotesIndex } from './rootRecentNotes';
import { SettingsPageIdentityExclusions } from './settingsPageIdentityExclusions';
import { createLocalMutationSyncObserver } from './localMutationSync';

const rootElement = document.querySelector('#root');

if (!(rootElement instanceof HTMLElement)) {
  throw new Error('PagePerch side panel root is missing.');
}

const tabs = new ChromeActivePageTabs();
const settingsRepository = new ChromeLocalSettingsRepository();
const noteRepository = new ChromeLocalNoteRepository();
const syncClock = () => new Date();
const syncMessages = new SyncRuntimeMessagePort();
const syncQueue = new ChromeLocalSyncQueue({
  clock: syncClock,
  random: Math.random,
});
const noteService = new DefaultNoteService({
  repository: noteRepository,
  onLocalMutation: createLocalMutationSyncObserver({
    config: readByosClientConfig(),
    settings: settingsRepository,
    queue: syncQueue,
    messages: syncMessages,
  }),
});
const pageOpener = new ChromeCanonicalPageOpener();
const recentNotesIndex = new DefaultRootRecentNotesIndex(
  noteService,
  new ChromeRecentNoteChanges(),
);
const pendingPageSave = new PendingPageSaveCoordinator();
const settings = new SettingsPageIdentityExclusions(settingsRepository);
const identity = new DefaultPageIdentityService();
const registerPendingSave: RegisterPendingPageSave = (handler) =>
  pendingPageSave.register(handler);
const createDraftRuntime: CreatePageNoteDraftRuntime = (
  pageContext,
  emitState,
) =>
  new PageNoteDraftController({
    noteService,
    settingsRepository,
    pageContext,
    emitState,
  });
const draftOwnership = new DefaultPageNoteOwnership(
  createDraftRuntime,
  registerPendingSave,
);
const createController: CreateActivePageSessionController = (emitState) =>
  new ActivePageSessionController({
    tabs,
    settings,
    identity,
    flushPendingSave: () => pendingPageSave.flushPendingSave(),
    emitState,
  });

void requestSyncFollowUp(syncMessages, 'panel-open');

createRoot(rootElement).render(
  <StrictMode>
    <SidePanelApp
      createController={createController}
      draftOwnership={draftOwnership}
      Editor={PageNoteEditor}
      openSettings={() => chrome.runtime.openOptionsPage()}
      pageOpener={pageOpener}
      recentNotesIndex={recentNotesIndex}
    />
  </StrictMode>,
);
