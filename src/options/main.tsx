import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { OptionsApp } from './App';

const rootElement = document.querySelector('#root');

if (!(rootElement instanceof HTMLElement)) {
  throw new Error('PagePerch options root is missing.');
}

createRoot(rootElement).render(
  <StrictMode>
    <OptionsApp />
  </StrictMode>,
);
