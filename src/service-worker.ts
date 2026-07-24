import { enableActionSidePanel } from './background/sidePanelBehavior';

async function configureToolbarAction(): Promise<void> {
  try {
    await enableActionSidePanel(chrome.sidePanel);
  } catch {
    console.error(
      'PagePerch could not configure the toolbar side panel behavior.',
    );
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void configureToolbarAction();
});

void configureToolbarAction();
