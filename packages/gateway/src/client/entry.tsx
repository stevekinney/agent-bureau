import { hydrateRoot } from 'react-dom/client';

import { App } from '../ui/app';

declare global {
  interface Window {
    __INITIAL_DATA__: unknown;
  }
}

const root = document.getElementById('root');
if (root) {
  hydrateRoot(
    root,
    <App
      initialData={window.__INITIAL_DATA__ as Record<string, unknown>}
      pathname={window.location.pathname}
    />,
  );
}
