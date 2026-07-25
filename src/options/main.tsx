import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { createByosClient } from '../background/byosClient';
import { ChromeLocalIdentityMigrationPersistence } from '../repositories/chromeLocalIdentityMigrationPersistence';
import { ChromeLocalSettingsRepository } from '../repositories/chromeLocalSettingsRepository';
import { IdentityMigrationExecutor } from '../services/identityMigrationExecutor';
import { DefaultPageIdentityService } from '../services/pageIdentity';
import { OptionsApp } from './App';

const rootElement = document.querySelector('#root');

if (!(rootElement instanceof HTMLElement)) {
  throw new Error('PagePerch options root is missing.');
}

const settings = new ChromeLocalSettingsRepository();
const pageIdentity = new DefaultPageIdentityService();
const byosClient = createByosClient();
const clock = () => new Date();
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
        settings,
      }}
    />
  </StrictMode>,
);
