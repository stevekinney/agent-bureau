// Cinder is import-order-sensitive: import the base layer once, FIRST, then
// import styles for the components Gateway actually renders. The client
// bundle's CSS output is concatenated into /public/styles.css by the build,
// and the same stylesheet is linked in the SSR shell for a styled first paint.
import '@lostgradient/cinder/styles';
import '@lostgradient/cinder/badge/styles';
import '@lostgradient/cinder/callout/styles';
import '@lostgradient/cinder/chat/styles';
import '@lostgradient/cinder/code-block/styles';
import '@lostgradient/cinder/data-list/styles';
import '@lostgradient/cinder/description-list/styles';
import '@lostgradient/cinder/empty-state/styles';
import '@lostgradient/cinder/event-stream-viewer/styles';
import '@lostgradient/cinder/link/styles';
import '@lostgradient/cinder/payload-inspector/styles';
import '@lostgradient/cinder/run-step-timeline/styles';
import '@lostgradient/cinder/section-heading/styles';
import '@lostgradient/cinder/side-navigation/styles';
import '@lostgradient/cinder/sidebar/styles';
import '@lostgradient/cinder/stacked-list-item/styles';
import '@lostgradient/cinder/stat/styles';
import '@lostgradient/cinder/stat-group/styles';
import '@lostgradient/cinder/status-dot/styles';
import '@lostgradient/cinder/table/styles';
import '@lostgradient/cinder/table-body/styles';
import '@lostgradient/cinder/table-cell/styles';
import '@lostgradient/cinder/table-header/styles';
import '@lostgradient/cinder/table-header-cell/styles';
import '@lostgradient/cinder/table-row/styles';

import { hydrate } from 'svelte';

import type { ConfigurationResponse, RunDetail, RunSummary } from '../types';
import App from '../ui/app.svelte';

/**
 * The canonical hydration payload injected by the server into
 * `window.__INITIAL_DATA__`. Matches the app's `InitialData` contract;
 * each route populates exactly the key it owns.
 */
interface InitialData {
  runs?: RunSummary[];
  run?: RunDetail;
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
