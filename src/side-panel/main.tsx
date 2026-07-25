import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { ChromeLocalNoteRepository } from '../repositories/chromeLocalNoteRepository';
import { ChromeLocalSettingsRepository } from '../repositories/chromeLocalSettingsRepository';
import { DefaultNoteService } from '../services/note';
import { DefaultPageIdentityService } from '../services/pageIdentity';
import { SidePanelApp, type CreateActivePageSessionController } from './App';
import { PageNoteEditor } from './PageNoteEditor';
import { ActivePageSessionController } from './activePageSession';
import { ChromeActivePageTabs } from './chromeActivePageTabs';
import {
  PageNoteDraftController,
  PendingPageSaveCoordinator,
} from './pageNoteDraft';
import {
  DefaultPageNoteOwnership,
  type CreatePageNoteDraftRuntime,
  type RegisterPendingPageSave,
} from './pageNoteOwnership';
import { SettingsPageIdentityExclusions } from './settingsPageIdentityExclusions';

const rootElement = document.querySelector('#root');

if (!(rootElement instanceof HTMLElement)) {
  throw new Error('PagePerch side panel root is missing.');
}

const tabs = new ChromeActivePageTabs();
const settingsRepository = new ChromeLocalSettingsRepository();
const noteRepository = new ChromeLocalNoteRepository();
const noteService = new DefaultNoteService({ repository: noteRepository });
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

createRoot(rootElement).render(
  <StrictMode>
    <SidePanelApp
      createController={createController}
      draftOwnership={draftOwnership}
      Editor={PageNoteEditor}
      openSettings={() => chrome.runtime.openOptionsPage()}
    />
  </StrictMode>,
);
