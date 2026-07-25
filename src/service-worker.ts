import { recoverPendingIdentityMigration } from './background/identityMigrationRecovery';
import { enableActionSidePanel } from './background/sidePanelBehavior';

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

chrome.runtime.onInstalled.addListener(() => {
  void configureToolbarAction();
});

void configureToolbarAction();
void resumePendingIdentityMigration();
