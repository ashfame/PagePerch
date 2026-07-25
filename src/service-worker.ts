import { recoverPendingIdentityMigration } from './background/identityMigrationRecovery';
import { enableActionSidePanel } from './background/sidePanelBehavior';
import { createProductionByosSyncRuntime } from './background/byosSyncRuntime';
import { createSyncRuntimeMessageListener } from './background/syncRuntimeMessages';

const IDENTITY_MIGRATION_RECOVERY_ERROR_MESSAGE =
  'PagePerch could not finish a pending note identity update. Open PagePerch settings and retry.';

async function configureToolbarAction(): Promise<void> {
  try {
    await enableActionSidePanel(chrome.sidePanel);
  } catch {
    console.error(
      'PagePerch could not configure the toolbar side panel behavior.',
    );
  }
}

async function resumePendingIdentityMigration(): Promise<void> {
  try {
    await recoverPendingIdentityMigration();
  } catch {
    console.error(IDENTITY_MIGRATION_RECOVERY_ERROR_MESSAGE);
  }
}

const syncRuntime = createProductionByosSyncRuntime();

async function startSyncRuntime(): Promise<void> {
  await resumePendingIdentityMigration();
  await syncRuntime.start();
}

chrome.runtime.onInstalled.addListener(() => {
  void configureToolbarAction();
  void startSyncRuntime();
});
chrome.runtime.onStartup.addListener(() => {
  void startSyncRuntime();
});
chrome.runtime.onMessage.addListener(
  createSyncRuntimeMessageListener(syncRuntime),
);
chrome.alarms.onAlarm.addListener((alarm) => {
  void syncRuntime.handleAlarm(alarm.name);
});

void configureToolbarAction();
void startSyncRuntime();
