import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { createByosClient } from '../background/byosClient';
import { SyncRuntimeMessagePort } from '../background/syncRuntimeMessages';
import { ChromeLocalIdentityMigrationPersistence } from '../repositories/chromeLocalIdentityMigrationPersistence';
import { ChromeLocalSettingsRepository } from '../repositories/chromeLocalSettingsRepository';
import { ChromeLocalSyncQueue } from '../repositories/chromeLocalSyncQueue';
import { ChromeSyncVisibilityChanges } from '../repositories/chromeSyncVisibilityChanges';
import { IdentityMigrationExecutor } from '../services/identityMigrationExecutor';
import { DefaultPageIdentityService } from '../services/pageIdentity';
import { DefaultPendingSyncCount } from '../sync/syncVisibility';
import { OptionsApp } from './App';

const rootElement = document.querySelector('#root');

if (!(rootElement instanceof HTMLElement)) {
  throw new Error('PagePerch options root is missing.');
}

const settings = new ChromeLocalSettingsRepository();
const pageIdentity = new DefaultPageIdentityService();
const byosClient = createByosClient();
const syncMessages = new SyncRuntimeMessagePort();
const clock = () => new Date();
const pendingSyncCount = new DefaultPendingSyncCount({
  changes: new ChromeSyncVisibilityChanges(),
  queue: new ChromeLocalSyncQueue({
    clock,
    random: Math.random,
  }),
});
const migration = new IdentityMigrationExecutor({
  persistence: new ChromeLocalIdentityMigrationPersistence(),
  pageIdentityService: pageIdentity,
  clock,
  operationIdFactory: () => crypto.randomUUID(),
  revisionIdFactory: () => crypto.randomUUID(),
});

createRoot(rootElement).render(
  <StrictMode>
    <OptionsApp
      dependencies={{
        builtInExclusions: pageIdentity.builtInExclusions,
        byos: {
          clock,
          config: byosClient.config,
          connection: byosClient.coordinator,
        },
        migration,
        pendingSyncCount,
        settings,
        syncMessages,
      }}
    />
  </StrictMode>,
);
