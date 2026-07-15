// Import Cinder's base layer once. Component entrypoints import their own CSS,
// so the rendered component graph remains the single source of style imports.
// The build concatenates that CSS into the stylesheet linked by the SSR shell.
import '@lostgradient/cinder/styles';

import { hydrate } from 'svelte';

import type { RunDetailResponse } from '../routes/runs';
import type { ConfigurationResponse, RunSummary } from '../types';
import App from '../ui/app.svelte';

/**
 * The canonical hydration payload injected by the server into
 * `window.__INITIAL_DATA__`. Matches the app's `InitialData` contract;
 * each route populates exactly the key it owns.
 */
interface InitialData {
  runs?: RunSummary[];
  run?: RunDetailResponse;
  config?: ConfigurationResponse;
}

declare global {
  interface Window {
    // Typed as `unknown` and narrowed below: the value crosses the
    // server/client boundary as serialized JSON and must be validated
    // before it is trusted as `InitialData`.
    __INITIAL_DATA__: unknown;
  }
}

/**
 * Narrows the server-injected payload to {@link InitialData}. Any object is
 * a structurally valid payload here because every field is optional and the
 * app applies its own per-key fallbacks; this guard only rejects the
 * non-object cases (`undefined`, `null`, primitives) that would crash
 * hydration.
 */
function toInitialData(value: unknown): InitialData {
  return typeof value === 'object' && value !== null ? (value as InitialData) : {};
}

const root = document.getElementById('root');

if (root) {
  hydrate(App, {
    target: root,
    props: {
      initialData: toInitialData(window.__INITIAL_DATA__),
      pathname: window.location.pathname,
    },
  });
}
