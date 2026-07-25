import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { ChromeLocalSettingsRepository } from '../repositories/chromeLocalSettingsRepository';
import { DefaultPageIdentityService } from '../services/pageIdentity';
import { SidePanelApp, type CreateActivePageSessionController } from './App';
import { ActivePageSessionController } from './activePageSession';
import { ChromeActivePageTabs } from './chromeActivePageTabs';
import { SettingsPageIdentityExclusions } from './settingsPageIdentityExclusions';

const rootElement = document.querySelector('#root');

if (!(rootElement instanceof HTMLElement)) {
  throw new Error('PagePerch side panel root is missing.');
}

const tabs = new ChromeActivePageTabs();
const settings = new SettingsPageIdentityExclusions(
  new ChromeLocalSettingsRepository(),
);
const identity = new DefaultPageIdentityService();
const createController: CreateActivePageSessionController = (emitState) =>
  new ActivePageSessionController({
    tabs,
    settings,
    identity,
    // No editor is mounted in this milestone, so there is no pending note state to flush.
    flushPendingSave: () => Promise.resolve(),
    emitState,
  });

createRoot(rootElement).render(
  <StrictMode>
    <SidePanelApp
      createController={createController}
      openSettings={() => chrome.runtime.openOptionsPage()}
    />
  </StrictMode>,
);
