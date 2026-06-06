export const meta = {
  name: 'gateway-cinder-migration',
  description: 'Rip out the gateway React UI and rebuild it in Svelte 5 using @lostgradient/cinder',
  whenToUse: 'Cross-framework migration of packages/gateway UI from React 19 to Svelte 5 + cinder',
  phases: [
    { title: 'Investigate', detail: 'parallel readers: toolchain, render topology, component mapping, cinder API' },
    { title: 'Tracer', detail: 'prove Bun SSR+hydrate of one Svelte route w/ a real cinder component (gate)' },
    { title: 'Rewrite', detail: 'fan out page/hook/component rewrites in one shared worktree, partitioned files' },
    { title: 'Verify', detail: 'validate + completeness grep for residual React' },
  ],
};

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------
const GATEWAY = 'packages/gateway';
const CINDER = '@lostgradient/cinder';

// Files that constitute the React UI surface to be removed/rewritten. Captured
// from pre-flight scouting in the parent conversation; the Investigate phase
// confirms and refines this list.
const REACT_UI_FILES = [
  'src/ui/app.tsx',
  'src/ui/layout.tsx',
  'src/ui/router.ts',
  'src/ui/router.test.ts',
  'src/ui/pages/dashboard.tsx',
  'src/ui/pages/configuration.tsx',
  'src/ui/pages/chat.tsx',
  'src/ui/pages/run-detail.tsx',
  'src/ui/components/run-row.tsx',
  'src/ui/components/message-list.tsx',
  'src/ui/components/status-badge.tsx',
  'src/ui/components/connection-indicator.tsx',
  'src/ui/hooks/use-chat.ts',
  'src/ui/hooks/use-run-detail.ts',
  'src/ui/hooks/use-runs.ts',
  'src/ui/hooks/use-websocket.ts',
  'src/ui/hooks/tool-activity.ts',
  'src/ui/hooks/tool-activity.test.ts',
  'src/ui/styles/base.css',
  'src/ui/styles/layout.css',
  'src/ui/styles/components.css',
  'src/ui/styles/dashboard.css',
  'src/ui/styles/chat.css',
  'src/ui/styles/run-detail.css',
  'src/client/entry.tsx',
  'src/server/render.tsx',
  'src/server/render.test.tsx',
  'src/server/pages.tsx',
  'src/server/pages.test.ts',
];

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const TOOLCHAIN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['cinderConsumptionMode', 'bunSvelteStory', 'requiredDeps', 'buildPlan', 'risks', 'confidence'],
  properties: {
    cinderConsumptionMode: {
      type: 'string',
      enum: ['raw-svelte-source', 'precompiled-dist', 'mixed'],
      description: 'How cinder must be consumed: does the gateway bundler compile its .svelte source, or import precompiled output?',
    },
    cinderEvidence: { type: 'string', description: 'Concrete evidence (package.json exports, dist contents, a node_modules path inspected)' },
    bunSvelteStory: {
      type: 'string',
      description: 'Exactly how Bun.build will compile .svelte: which plugin (name + npm package + version), or Bun-native support if real, or "must use vite/other". Cite the verification.',
    },
    requiredDeps: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['name', 'version', 'why'], properties: { name: { type: 'string' }, version: { type: 'string' }, why: { type: 'string' } } },
      description: 'Every dep/devDep to add to gateway package.json (svelte, the bun svelte plugin, cinder, etc.) with the version to pin and why',
    },
    depsToRemove: { type: 'array', items: { type: 'string' }, description: 'React-related deps/devDeps to remove from gateway package.json' },
    buildPlan: {
      type: 'string',
      description: 'How scripts/build.ts changes: server SSR pass (svelte/server render to string) + client hydrate pass, plugin wiring, externals changes, how cinder source gets into the bundle scope, how cinder CSS/tokens are emitted',
    },
    ssrApi: { type: 'string', description: 'The exact Svelte 5 SSR + hydrate API to use (e.g. render() from svelte/server -> {head, body}; hydrate() from svelte), verified against installed svelte version' },
    risks: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
};

const TOPOLOGY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['renderTopology', 'routes', 'serverWiring', 'duplicationFindings'],
  properties: {
    renderTopology: { type: 'string', description: 'Plain-language map of how the server produces HTML and how the client hydrates: who renders what, where #root comes from, the two-surface (placeholder vs hydrated app) situation' },
    routes: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['path', 'ssrComponent', 'clientComponent', 'data', 'liveData'], properties: {
        path: { type: 'string' }, ssrComponent: { type: 'string' }, clientComponent: { type: 'string' },
        data: { type: 'string', description: 'initial data shape injected for SSR/hydration' },
        liveData: { type: 'string', description: 'websocket/SSE live-update behavior for this route, if any' },
      } },
    },
    serverWiring: { type: 'string', description: 'Where pages app is mounted (create-gateway.ts/index.ts), how static assets (entry.js, styles.css, manifest.json) are served, websocket handler location' },
    duplicationFindings: { type: 'string', description: 'Any mismatch between SSR placeholder output and the hydrated app; anything the rewrite should fix rather than faithfully reproduce' },
    nonUiCouplings: { type: 'array', items: { type: 'string' }, description: 'Non-UI files that import from ui/ or reference react and will need touching (e.g. types.ts, index.ts exports)' },
  },
};

const MAPPING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['pages', 'sharedComponents', 'cinderImportsNeeded'],
  properties: {
    pages: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['reactFile', 'svelteTarget', 'cinderComponents', 'logicToPort', 'notes'], properties: {
        reactFile: { type: 'string' }, svelteTarget: { type: 'string' },
        cinderComponents: { type: 'array', items: { type: 'string' }, description: 'cinder subpath exports this page will use, e.g. @lostgradient/cinder/card' },
        logicToPort: { type: 'string', description: 'hooks/state/effects this page depends on and the runes equivalent' },
        notes: { type: 'string' },
      } },
    },
    sharedComponents: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['reactFile', 'decision', 'cinderReplacement'], properties: {
        reactFile: { type: 'string' },
        decision: { type: 'string', enum: ['replace-with-cinder', 'rewrite-as-local-svelte', 'delete'], description: 'replace-with-cinder if a cinder export covers it; rewrite-as-local-svelte if app-specific; delete if redundant' },
        cinderReplacement: { type: 'string', description: 'the cinder export to use, or "n/a"' },
      } },
    },
    hooks: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['reactFile', 'svelteTarget', 'runesStrategy'], properties: {
        reactFile: { type: 'string' }, svelteTarget: { type: 'string' },
        runesStrategy: { type: 'string', description: 'how the React hook (useState/useEffect/useRef) becomes Svelte 5 runes ($state/$derived/$effect) or a .svelte.ts module' },
      } },
    },
    cinderImportsNeeded: { type: 'array', items: { type: 'string' }, description: 'deduped list of every cinder subpath export the whole migration needs' },
  },
};

const CINDER_API_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['components', 'stylesSetup', 'gotchas'],
  properties: {
    components: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['name', 'importPath', 'props', 'ssrSafe'], properties: {
        name: { type: 'string' },
        importPath: { type: 'string' },
        props: { type: 'string', description: 'key props/snippets/events from the component schema, enough to use it correctly' },
        ssrSafe: { type: 'string', enum: ['yes', 'no', 'unknown'], description: 'does it render under SSR without browser-only APIs at module/render time' },
      } },
    },
    stylesSetup: { type: 'string', description: 'Exactly which cinder style entrypoints to import (styles/all? styles/tokens + per-component styles?) and where, for the gateway to look correct' },
    gotchas: { type: 'array', items: { type: 'string' }, description: 'SSR caveats, peer-dep needs, runtime requirements (e.g. shiki/mermaid for markdown), client-only components' },
  },
};

const TRACER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'whatWasBuilt', 'commands', 'evidence', 'blockers', 'correctionsToPlan'],
  properties: {
    status: { type: 'string', enum: ['green', 'red'], description: 'green ONLY if a real Svelte route SSRs to HTML and hydrates with a real cinder component visible, proven by running it' },
    whatWasBuilt: { type: 'string' },
    commands: { type: 'array', items: { type: 'string' }, description: 'the exact build/run/verify commands executed' },
    evidence: { type: 'string', description: 'proof it worked: server HTML snippet containing cinder markup, successful build output, a curl/console result. NOT "it should work".' },
    blockers: { type: 'array', items: { type: 'string' }, description: 'if red: precisely why, so the parent can decide whether to fix the toolchain or stop' },
    correctionsToPlan: { type: 'string', description: 'anything the tracer learned that invalidates or refines the toolchain/build plan from Investigate' },
    scaffoldFiles: { type: 'array', items: { type: 'string' }, description: 'files created/modified by the tracer that the rewrite phase builds on (build.ts, render, entry, a page)' },
  },
};

const REWRITE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'filesWritten', 'filesDeleted', 'cinderUsed', 'selfCheck', 'notes'],
  properties: {
    status: { type: 'string', enum: ['done', 'partial', 'blocked'] },
    filesWritten: { type: 'array', items: { type: 'string' } },
    filesDeleted: { type: 'array', items: { type: 'string' } },
    cinderUsed: { type: 'array', items: { type: 'string' } },
    selfCheck: { type: 'string', description: 'result of type-checking / building just the touched files, or why that was not possible' },
    notes: { type: 'string', description: 'decisions, deviations, anything the integrator must know' },
  },
};

const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['validateResult', 'residualReact', 'completeness', 'remainingWork'],
  properties: {
    validateResult: { type: 'string', description: 'output summary of running the gateway validate pipeline (format/lint/types/test)' },
    residualReact: {
      type: 'object', additionalProperties: false, required: ['clean', 'findings'],
      properties: { clean: { type: 'boolean' }, findings: { type: 'array', items: { type: 'string' }, description: 'any remaining react / react-dom / .tsx UI / renderToReadableStream / @types/react references' } },
    },
    completeness: { type: 'string', description: 'judgment on whether ALL custom React UI is gone and replaced, per the rip-out-all requirement' },
    remainingWork: { type: 'array', items: { type: 'string' }, description: 'concrete follow-ups the parent must drive in the live build-run-fix loop' },
  },
};

// ---------------------------------------------------------------------------
// Phase 1 — Investigate (parallel readers, barrier so the tracer sees all)
// ---------------------------------------------------------------------------
phase('Investigate');
log('Mapping the toolchain, render topology, component surface, and cinder API before touching code.');

const READ_CTX = `You are investigating a cross-framework UI migration in a Bun monorepo.

REPO: /Users/stevekinney/Developer/agent-bureau (the gateway package lives at ${GATEWAY})
CINDER SOURCE (sibling repo, for reference): /Users/stevekinney/Developer/cinder — the published package is ${CINDER}, a Svelte 5 component library (peer dep svelte >=5.55.0 <6).

GOAL: replace the gateway's custom React 19 UI entirely with Svelte 5 + ${CINDER} components. Server is Hono on Bun; current UI is React SSR (renderToReadableStream) + client hydration (hydrateRoot).

Read real files. Cite paths and line numbers. Do not speculate where you can verify. Return ONLY the structured object.`;

const [toolchain, topology, mapping, cinderApi] = await parallel([
  () => agent(
    `${READ_CTX}

YOUR FOCUS: the BUILD TOOLCHAIN. This is the load-bearing investigation — the whole migration depends on it.
1. Resolve how ${CINDER} must be consumed. Inspect /Users/stevekinney/Developer/cinder/packages/components/package.json exports, the dist/ contents, and the "files" array. The "svelte" condition points at raw source (src/index.ts) while dist/ holds a compiled SSR build. Determine which the gateway bundler should use and what that implies (must svelte compile .svelte from node_modules?).
2. CRITICAL: determine exactly how Bun.build will compile .svelte files. Bun does NOT compile Svelte natively. Find the real, currently-available Bun Svelte plugin (exact npm package name + version), verify it supports BOTH server (SSR/generate:'server') and client (DOM) compilation, and that it can compile cinder's source from node_modules. Use ToolSearch to load context7 (resolve-library-id + query-docs) for "bun svelte plugin" and "svelte 5 server-side rendering Bun" to verify against current docs. If no viable Bun plugin exists, say so loudly — that changes the build strategy (e.g. a separate vite/svelte client build).
3. Pin every dep to add to ${GATEWAY}/package.json (svelte, the plugin, ${CINDER}@^0.1.1) and list every React dep to remove.
4. Read ${GATEWAY}/scripts/build.ts and write the concrete new build plan: server SSR pass + client hydrate pass, plugin wiring, externals, how cinder CSS/tokens are emitted to dist/public.
5. Verify the Svelte 5 SSR + hydrate API against the installed svelte version (render() from 'svelte/server' returning {head,body,...}; hydrate() from 'svelte').`,
    { label: 'investigate:toolchain', phase: 'Investigate', schema: TOOLCHAIN_SCHEMA },
  ),

  () => agent(
    `${READ_CTX}

YOUR FOCUS: the RENDER TOPOLOGY of the current gateway. Map reality, not the happy path.
1. Read ${GATEWAY}/src/server/pages.tsx, ${GATEWAY}/src/server/render.tsx, ${GATEWAY}/src/client/entry.tsx, ${GATEWAY}/src/ui/app.tsx, ${GATEWAY}/src/ui/router.ts, ${GATEWAY}/src/create-gateway.ts, and ${GATEWAY}/src/index.ts.
2. There appear to be TWO UI surfaces: pages.tsx renders minimal inline SSR placeholder components, while client/entry.tsx hydrates the much richer ui/app.tsx over #root. Confirm this and document the mismatch precisely — the rewrite must reconcile it, not faithfully duplicate it.
3. For every route, record: path, what SSRs, what hydrates, the initial-data shape, and any websocket/SSE live-update behavior (read ${GATEWAY}/src/websocket/ and ${GATEWAY}/src/live-events.ts as needed).
4. Document server wiring: where the pages app mounts, how /public assets + manifest.json + styles.css are served, where the WS handler lives.
5. List non-UI files that import from ui/ or reference react and will need touching.`,
    { label: 'investigate:topology', phase: 'Investigate', schema: TOPOLOGY_SCHEMA },
  ),

  () => agent(
    `${READ_CTX}

YOUR FOCUS: the COMPONENT MAPPING from React UI to Svelte/cinder. Produce the rewrite blueprint.
Read every file under ${GATEWAY}/src/ui/ (pages/*.tsx, components/*.tsx, hooks/*.ts, layout.tsx, app.tsx) and the styles in ${GATEWAY}/src/ui/styles/.
For each PAGE (dashboard, run-detail, configuration, chat): name the target .svelte file path, the cinder exports it should use (browse /Users/stevekinney/Developer/cinder/packages/components/src/components/ for the catalog — e.g. card, table, badge, button, message, timeline, stat, empty-state, connection-indicator, chat, code-block, form-field, input, textarea), and the stateful logic to port.
For each SHARED COMPONENT (run-row, message-list, status-badge, connection-indicator): decide replace-with-cinder (cinder has connection-indicator, badge/status-dot, message, data-list among ~150 exports), rewrite-as-local-svelte, or delete.
For each HOOK (use-chat, use-runs, use-run-detail, use-websocket, tool-activity): name its Svelte target (likely a .svelte.ts runes module) and the $state/$derived/$effect strategy.
Output a deduped list of every cinder subpath export the migration needs.`,
    { label: 'investigate:mapping', phase: 'Investigate', schema: MAPPING_SCHEMA },
  ),

  () => agent(
    `${READ_CTX}

YOUR FOCUS: the CINDER COMPONENT API for the components this migration will likely use.
The migration needs (at least): card, table (+ table-row/cell/header), badge, status-dot, button, link, message, chat, timeline (+ timeline-item), stat (+ stat-group), empty-state, connection-indicator, code-block, json-viewer, form-field, input, textarea, label, container, surface, navigation-bar/side-navigation, spinner.
For each, read its source under /Users/stevekinney/Developer/cinder/packages/components/src/components/<name>/ (schema.ts and the .svelte) and record: the exact import path (e.g. ${CINDER}/card), its key props/snippets/events, and whether it is SSR-safe (no window/document access at module load or during SSR render).
Then determine the STYLES setup: read /Users/stevekinney/Developer/cinder/packages/components/src/styles/ and the package "./styles*" exports — which entrypoints must the gateway import (styles/all vs tokens+foundation+per-component) and where, so it looks correct.
List gotchas: SSR caveats, required peer deps, client-only components, runtime needs (shiki/mermaid for markdown/code-block).`,
    { label: 'investigate:cinder-api', phase: 'Investigate', schema: CINDER_API_SCHEMA },
  ),
]);

if (!toolchain || !topology || !mapping || !cinderApi) {
  return {
    fatal: 'One or more investigation agents failed to return. Cannot proceed safely.',
    toolchain, topology, mapping, cinderApi,
  };
}

log(`Toolchain: cinder=${toolchain.cinderConsumptionMode}, bun-svelte=${toolchain.bunSvelteStory?.slice(0, 80)}…, confidence=${toolchain.confidence}`);

// ---------------------------------------------------------------------------
// Phase 2 — Tracer bullet (HARD GATE). One real route, SSR + hydrate, real
// cinder component, proven by running it. If red, STOP — do not mass-rewrite.
// Runs in a worktree so the whole migration accumulates one coherent diff.
// ---------------------------------------------------------------------------
phase('Tracer');
log('Proving the toolchain end-to-end on one route before any mass rewrite. This phase is a hard gate.');

const tracer = await agent(
  `You are proving a Bun + Svelte 5 SSR/hydrate toolchain works END TO END before a larger migration commits to it. You are working in the agent-bureau repo on the migration branch (the parent checked it out before launching); work inside ${GATEWAY}. Everything you create here — installed deps, build wiring, the proven route — persists into the same checkout for the rewrite phase, so make it correct and idiomatic, matching the repo conventions in ${GATEWAY}/CLAUDE.md and .claude/rules/.

THE PLAN FROM INVESTIGATION (authoritative unless you find it empirically wrong):
- Cinder consumption: ${toolchain.cinderConsumptionMode}. Evidence: ${toolchain.cinderEvidence}
- Bun .svelte compilation: ${toolchain.bunSvelteStory}
- SSR/hydrate API: ${toolchain.ssrApi}
- Deps to add: ${JSON.stringify(toolchain.requiredDeps)}
- Build plan: ${toolchain.buildPlan}
- Cinder styles setup: ${cinderApi.stylesSetup}
- A known-SSR-safe cinder component to use on screen: pick one marked ssrSafe:'yes' from ${JSON.stringify(cinderApi.components?.filter((c) => c.ssrSafe === 'yes').map((c) => ({ name: c.name, importPath: c.importPath, props: c.props })))}

YOUR TASK — the smallest vertical slice that proves the whole stack:
1. Add the required deps to ${GATEWAY}/package.json and install (bun install). NOTE: a fresh worktree may abort bun install on the lefthook prepare hook — if so, run \`bunx lefthook install --reset-hooks-path\` first, then retry.
2. Wire ${GATEWAY}/scripts/build.ts (or a minimal parallel build path) to compile .svelte for BOTH a server SSR pass and a client hydrate pass, including cinder's source from node_modules.
3. Create ONE Svelte route end to end: a .svelte page that renders a real cinder component (e.g. a card/button/badge) plus some text; an SSR render that produces an HTML string via Svelte 5's server render and injects it into the existing Hono HTML shell; a client entry that hydrates #root.
4. BUILD IT and RUN IT. Start the gateway (or a minimal harness) and fetch the route. PROVE the SSR HTML contains the cinder component's markup, and that the client bundle built without error. Capture the actual evidence (HTML snippet, build output). Do NOT claim success without running it.
5. If it will not go green after genuine effort, set status:'red' and document the precise blocker — the parent will decide whether to fix the toolchain or change strategy. Do not paper over failures.

Return the structured result. Keep the slice minimal but REAL — no stubs, no "this should work".`,
  { label: 'tracer:vertical-slice', phase: 'Tracer', schema: TRACER_SCHEMA },
);

if (!tracer || tracer.status !== 'green') {
  return {
    gateFailed: true,
    message: 'TRACER GATE FAILED — the Bun+Svelte SSR/hydrate toolchain was not proven. Mass rewrite was NOT attempted, per design. Decide whether to fix the toolchain or change strategy, then resume.',
    tracer,
    investigation: { toolchain, topology, mapping, cinderApi },
  };
}

log(`Tracer GREEN. Evidence: ${tracer.evidence?.slice(0, 140)}…  Fanning out the rewrite in the same checkout.`);

// All phases run in ONE shared checkout (the parent created the migration
// branch before launching; no agent uses worktree isolation). The tracer's
// installed deps + build.ts wiring + proven route therefore persist here, so
// the rewrite agents build on real scaffold. The four units are partitioned to
// non-overlapping files, making parallel mutation of the shared tree safe.

// ---------------------------------------------------------------------------
// Phase 3 — Rewrite (fan out, PARTITIONED non-overlapping file sets, ONE tree)
// ---------------------------------------------------------------------------
phase('Rewrite');
log('Tracer proved the scaffold. Rewriting the UI surface in partitioned, non-overlapping units.');

// Partition the work so no two agents touch the same file. Order: shared
// hooks/state first (pages depend on them), then pages, then teardown of React.
const rewritePlanContext = `MIGRATION PLAN (authoritative):
TOPOLOGY: ${topology.renderTopology}
ROUTES: ${JSON.stringify(topology.routes)}
SERVER WIRING: ${topology.serverWiring}
RECONCILE (do not duplicate): ${topology.duplicationFindings}
CINDER API: ${JSON.stringify(cinderApi.components)}
CINDER STYLES: ${cinderApi.stylesSetup}
CINDER GOTCHAS: ${JSON.stringify(cinderApi.gotchas)}
TRACER SCAFFOLD (build on these, do not redo): ${JSON.stringify(tracer.scaffoldFiles)}
TRACER CORRECTIONS: ${tracer.correctionsToPlan}
CONVENTIONS: TypeScript only, kebab-case files, Svelte 5 runes ($state/$derived/$effect), factory-function style, immutability via spread. Match ${GATEWAY}/CLAUDE.md and .claude/rules/.`;

const REWRITE_UNITS = [
  {
    key: 'state-hooks',
    label: 'rewrite:state-hooks',
    task: `Port the React hooks to Svelte 5 runes modules (.svelte.ts). Per the mapping: ${JSON.stringify(mapping.hooks)}.
Files in scope (yours alone): use-websocket, use-runs, use-run-detail, use-chat, tool-activity and their tests.
Convert useState->$state, useEffect->$effect, useRef->plain closure vars or $state, derived values->$derived. The websocket/live-event subscription logic and the tool-activity reducer are the hard parts — preserve their behavior exactly (read the originals). Rewrite the corresponding tests (tool-activity.test, router.test if applicable) for the runes versions. Type-check what you can.`,
  },
  {
    key: 'shared-components',
    label: 'rewrite:shared-components',
    task: `Rewrite the shared UI components and the layout as Svelte. Per the mapping: shared=${JSON.stringify(mapping.sharedComponents)}.
Files in scope (yours alone): layout.tsx->layout.svelte, components/{run-row,message-list,status-badge,connection-indicator}.tsx->.svelte, router.ts (keep as plain TS route matcher if framework-agnostic, else adapt).
Use cinder exports where the mapping says replace-with-cinder; write small local .svelte components otherwise. Do NOT touch the pages or hooks files (other agents own them) — import from their agreed paths.`,
  },
  {
    key: 'pages',
    label: 'rewrite:pages',
    task: `Rewrite the four pages as Svelte components using cinder. Per the mapping: ${JSON.stringify(mapping.pages)}.
Files in scope (yours alone): pages/{dashboard,run-detail,configuration,chat}.tsx -> .svelte, and the top-level app.tsx -> app.svelte that routes between them and mounts the layout.
Consume the runes state modules and shared components by their agreed import paths (do not redefine them). Use the cinder components named in the mapping. Reconcile the SSR-placeholder vs hydrated-app mismatch: SSR and client must render the same component tree for the same data.`,
  },
  {
    key: 'server-glue',
    label: 'rewrite:server-glue',
    task: `Rewrite the server render + client entry + pages router to drive the Svelte app, building on the tracer scaffold (do not redo it; generalize it to all routes).
Files in scope (yours alone): server/render.tsx->render.ts (Svelte SSR string render into the Hono HTML shell), server/pages.tsx->pages.ts (per-route SSR using the real Svelte page components + initial data), client/entry.tsx->entry.ts (hydrate the Svelte app over #root). Rewrite server/render.test + server/pages.test for the Svelte versions.
Ensure styles: import the cinder style entrypoints per ${cinderApi.stylesSetup} and ensure they reach dist/public/styles.css alongside any app CSS. Do NOT edit the page/component/hook files (other agents own them); import from their agreed paths. Keep scripts/build.ts consistent with the tracer's build wiring (extend it to all entries).`,
  },
];

const rewriteResults = await parallel(
  REWRITE_UNITS.map((u) => () =>
    agent(
      `You are one of four agents rewriting the gateway UI from React to Svelte 5 + cinder, working in a SHARED git worktree. STAY STRICTLY within your assigned files — other agents own the rest, and overlapping edits corrupt the shared tree.

${rewritePlanContext}

YOUR UNIT: ${u.key}
${u.task}

Agreed cross-unit import paths (so units compose): hooks live at src/ui/hooks/*.svelte.ts; shared components at src/ui/components/*.svelte and src/ui/layout.svelte; pages at src/ui/pages/*.svelte and the app at src/ui/app.svelte; server glue at src/server/{render,pages}.ts and src/client/entry.ts. Import across units by these paths; never redefine another unit's file.

Write real, idiomatic, complete code — no stubs, no TODOs, no placeholder content. Return the structured result listing every file written and deleted.`,
      { label: u.label, phase: 'Rewrite', schema: REWRITE_SCHEMA },
    ),
  ),
);

const goodRewrites = rewriteResults.filter(Boolean);
log(`Rewrite units returned: ${goodRewrites.map((r, i) => `${REWRITE_UNITS[i]?.key}=${r.status}`).join(', ')}`);

// ---------------------------------------------------------------------------
// Phase 4 — Verify (validate pipeline + residual-React completeness grep)
// ---------------------------------------------------------------------------
phase('Verify');
log('Running the gateway validate pipeline and grepping for any residual React.');

const verify = await agent(
  `You are the integration/verification pass for the gateway React->Svelte migration, in the shared worktree.

1. From ${GATEWAY}, run the validate pipeline: \`bun run validate\` (format:check, lint, check-types, test). Also build: \`bun run build\`. Capture results. Fix small breakages caused by unit seams (mismatched import paths, leftover React imports, type errors) — but do NOT silently re-architect; if a unit's output is fundamentally wrong, report it in remainingWork.
2. RIP-OUT-ALL completeness grep — the requirement is that NO custom React UI remains. Verify and report any findings:
   - \`grep -rn "react\\|react-dom" ${GATEWAY}/package.json\` should be empty (deps removed).
   - No \`.tsx\` files remain under ${GATEWAY}/src/ui, ${GATEWAY}/src/client, ${GATEWAY}/src/server (UI surface). \`find ${GATEWAY}/src -name '*.tsx'\`.
   - No \`renderToReadableStream\`, \`hydrateRoot\`, \`from 'react'\`, \`@types/react\` anywhere in ${GATEWAY}/src or package.json.
   - React removed from scripts/build.ts externals.
   The original React UI files that must be gone or rewritten: ${JSON.stringify(REACT_UI_FILES)}.
3. Report the validate result, the residual-React findings (clean true/false), a completeness judgment, and the concrete remaining work the parent must drive in a live build-run-fix loop (hydration mismatches, websocket reconnection, visual correctness — things only a running server reveals).

Return the structured result. Be honest: a one-shot fan-out rarely yields a fully green running cross-framework migration; surface what still needs the live loop.`,
  { label: 'verify:integrate', phase: 'Verify', schema: VERIFY_SCHEMA },
);

return {
  status: 'rewrite-applied',
  tracer: { status: tracer.status, evidence: tracer.evidence, scaffoldFiles: tracer.scaffoldFiles },
  investigation: { toolchain, topology, mapping, cinderApi },
  rewrite: goodRewrites,
  verify,
  handoff:
    'Tracer proved the toolchain; investigation + rewrite applied a Svelte/cinder UI on the migration branch. Per the migration design, the parent now drives the live build-run-fix loop: boot the gateway, load each route in a browser, fix hydration/websocket/visual issues the static validate cannot catch, then open a PR.',
};
