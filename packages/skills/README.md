# Skills

`skills` is the procedural knowledge layer for Agent Bureau. It lets the runtime keep a small catalog of available capabilities in context, load full instructions only when an agent chooses a relevant skill, and then fetch larger bundled resources on demand.

That matters because Agent Bureau is not only a one-shot prompt runner. The project has a gateway, persistent sessions, memory, identities, tools, schedulers, and long-running workflows. Skills give those pieces a shared way to package repeatable operating knowledge without hard-coding every procedure into system prompts or runtime code.

## Mental Model

Skills use progressive disclosure:

- **Catalog**: The agent sees a compact `<available_skills>` block with each skill name and description.
- **Instructions**: The agent calls `activate_skill` to load one skill's full `SKILL.md` body into context.
- **Resources**: The agent calls `load_skill_resource` for larger files bundled beside the skill, such as checklists, scripts, examples, or templates.

This keeps normal runs cheap and focused while still making specialized procedures available when the task calls for them.

## Why It Is Important

Agent Bureau has several extension points: `armorer` tools, `operative` hooks, `memory` recall, `gateway` runtime composition, and identity policies. Skills connect those extension points into one workflow:

- `gateway` can inject the skill catalog on the first step of a run and add skill management tools to the active toolbox.
- `operative` can consume skill hooks and enforce the tool policy from active skills.
- `armorer` provides the validated tools for activating skills, loading resources, and reviewing proposals.
- `memory` can store skill-specific learning in isolated `skill:{name}` namespaces.
- Storage-backed providers let skill state survive process restarts through the same durable storage model used elsewhere in the project.

Without this package, procedural knowledge would either live in large always-on prompts or in scattered product code. Skills make it portable, auditable, and activatable at runtime.

## Skill File Format

A skill is a `SKILL.md` file with YAML frontmatter and a Markdown body. Names must be kebab-case.

```md
---
name: code-review
description: Review code changes for correctness, tests, and maintainability.
allowed-tools: read, grep
denied-tools: deploy-production
metadata:
  owner: platform
---

Read the diff first. Prioritize correctness issues, regressions, missing tests,
and unclear ownership boundaries.

When a referenced checklist is needed, load `checklist.md`.
```

The parser treats `name` and `description` as required. Optional fields include `license`, `compatibility`, `allowed-tools`, `denied-tools`, and string metadata.

## How It Works

The package has four main parts:

- **Providers**: `SkillProvider` implementations list, load, save, delete, enable, disable, and serve resources for skills.
- **Sessions**: `createSkillSession()` tracks which skills are active for one run and merges their tool policies.
- **Hooks**: `createSkillCatalogHook()` returns a `prepareStep` hook that renders the catalog on step 0.
- **Tools**: `createSkillToolbox()` creates `activate_skill`, `load_skill_resource`, `deactivate_skill`, and `list_skills`.

The storage-backed provider writes skills under keys such as `skill:{name}:metadata`, `skill:{name}:body`, `skill:{name}:resource:{path}`, and `skill:{name}:enabled`. The static provider keeps the same interface in memory for tests, local bundles, and browser-safe use cases.

## Basic Usage

Use the static provider when you already have skill content in memory.

```typescript
import {
  createSkillCatalogHook,
  createSkillSession,
  createSkillToolbox,
  createStaticSkillProvider,
  parseSkillMarkdown,
} from 'skills';

const provider = createStaticSkillProvider([
  parseSkillMarkdown(`---
name: code-review
description: Review code changes before they ship.
---

Read the diff, identify concrete risks, and ask for missing tests when needed.
`),
]);

const session = createSkillSession();
const catalogHook = createSkillCatalogHook({ provider });
const skillTools = createSkillToolbox({ provider, session });
```

In an agent loop, call `catalogHook.prepareStep(context)` on step 0; it returns `string | undefined` (`undefined` when no skills are available or the provider errors), so inject the value only when it is defined. `createSkillToolbox` returns a plain object of four `Tool` instances, so spread them into your toolbox — `createToolbox([...Object.values(skillTools)])` — so the agent can activate skills and load resources when the catalog says one is relevant.

## Ingesting Skills

Use `scanDirectory()` when skills live on disk:

```typescript
import { createStorageSkillProvider, scanDirectory } from 'skills';
import { MemoryStorage, textValueStore } from '@lostgradient/weft/storage';

// createStorageSkillProvider needs a Weft TextValueStore. Use a real durable
// store in production; this in-memory one is enough to illustrate the API.
const store = textValueStore(new MemoryStorage());
const provider = createStorageSkillProvider(store);

const result = await scanDirectory('/path/to/skills', provider);
console.log(`discovered ${result.discovered}, loaded ${result.loaded}`);

// `errors` is an array of { path, error } objects, not strings.
for (const { path, error } of result.errors) {
  process.stderr.write(`${path}: ${error}\n`);
}
```

Each directory containing a `SKILL.md` becomes one skill. Other files in that same directory become resources for that skill.

Use `fetchFromRegistry()` when a registry serves skill files at `{baseUrl}/{name}/SKILL.md`:

```typescript
import { fetchFromRegistry } from 'skills';

await fetchFromRegistry({
  baseUrl: 'https://example.com/skills',
  names: ['code-review', 'incident-response'],
  provider,
});
```

## Gateway Integration

`gateway` uses the same package primitives when `GatewayOptions.skills` is provided. Runtime composition creates a skill session, injects the catalog on the first step, and combines the base toolbox with the skill management tools unless `includeTools` is disabled.

The flow inside a gateway run is:

- Step 0 gets an `<available_skills>` system message.
- The agent calls `activate_skill` when one catalog entry matches the task.
- The active skill's instructions are returned in a `<skill_content>` block.
- If the skill lists resources, the agent can call `load_skill_resource`.
- Active skill tool policies can narrow the available tool set for the run.

Use this package directly when building a custom runtime. Use `gateway` composition when the product surface should manage the wiring for you.

## Memory and Learning

`createSkillMemory(memory, skillName)` wraps any compatible memory implementation and forces reads and writes into the `skill:{name}` namespace. This prevents skill-specific learning from leaking into unrelated memory queries.

`createSkillMemoryHooks()` can recall skill-specific memories on the first step and store final responses as experiential skill learning. The hooks degrade gracefully: memory failures should not crash an agent run.

## Proposal Workflows

The self-improvement helpers store proposed changes in durable storage and expose review tools:

- `list_proposals`
- `view_proposal`
- `accept_proposal`
- `reject_proposal`

Accepting a skill proposal parses its content as `SKILL.md` and saves it through the configured `SkillProvider`. Rejecting a proposal records a content hash so the same content is not proposed again.

## Package Structure

### `skills` (root)

The primary API covering providers, parsing, ingestion, sessions, hooks, tools, proposals, and all public types.

```typescript
import {
  createSkillCatalogHook,
  createSkillSession,
  createSkillToolbox,
  createStaticSkillProvider,
  createStorageSkillProvider,
  parseSkillMarkdown,
  serializeSkillMarkdown,
  isValidSkillName,
  scanDirectory,
  fetchFromRegistry,
  createSkillMemory,
  createSkillMemoryHooks,
  createProposalToolbox,
  saveProposal,
  acceptProposal,
  rejectProposal,
  listProposals,
} from 'skills';
```

**Parsing:**

- **`parseSkillMarkdown(text)`**: Parses a `SKILL.md` string into a `SkillContent` object. Throws `SkillParseError` for invalid frontmatter or missing required fields.
- **`serializeSkillMarkdown(content)`**: Serializes a `SkillContent` object back to a `SKILL.md` string.
- **`isValidSkillName(name)`**: Returns `true` if the name matches the required kebab-case pattern (`SKILL_NAME_PATTERN`).

**Providers:**

- **`createStaticSkillProvider(skills?)`**: In-memory provider. Accepts an optional array of `SkillContent` values. Suitable for tests, local bundles, and browser contexts.
- **`createStorageSkillProvider(store)`**: Storage-backed provider that persists skills under structured keys in a `TextValueStore`.

**Ingestion:**

- **`scanDirectory(path, provider, options?)`**: Recursively scans a directory for `SKILL.md` files and loads them into the provider. Returns a `ScanResult` with `discovered` (count), `loaded` (count), and `errors` (an array of `{ path, error }` objects).
- **`fetchFromRegistry(options)`**: Fetches named skills from an HTTP registry by convention (`{baseUrl}/{name}/SKILL.md`) and saves them into the provider.

**Session:**

- **`createSkillSession()`**: Creates a `SkillSession` that tracks active skills and merges their tool policies (`allowed-tools`, `denied-tools`) across activations.

**Hooks:**

- **`createSkillCatalogHook(options)`**: Returns a `{ prepareStep }` hook. On step 0 its `prepareStep` returns the `<available_skills>` XML string (the caller injects it into the conversation; the hook does not inject it itself). Pass `{ provider, skillPolicy? }`.
- **`escapeXml(text)`**: Escapes characters that would break the `<available_skills>` XML block.

**Tools:**

- **`createSkillToolbox(options)`**: Returns a plain object of four `Tool` instances — `{ activateSkill, loadSkillResource, deactivateSkill, listSkills }` (the `activate_skill`, `load_skill_resource`, `deactivate_skill`, and `list_skills` tools). It is not an armorer `Toolbox`; spread the tools into `createToolbox([...])` to build one.
- **`createActivateSkillTool(options)`**: Creates just the `activate_skill` tool.
- **`createLoadSkillResourceTool(options)`**: Creates just the `load_skill_resource` tool.
- **`createDeactivateSkillTool(options)`**: Creates just the `deactivate_skill` tool.
- **`createListSkillsTool(options)`**: Creates just the `list_skills` tool.
- **`isSkillContent(message)`**: Returns `true` if a message string contains an embedded `<skill_content ...>` marker. Used by context compactors to detect injected skill content. Signature: `isSkillContent(message: string): boolean`.

**Memory:**

- **`createSkillMemory(memory, skillName)`**: Wraps a `MemoryLike` to namespace all reads and writes under `skill:{skillName}:`.
- **`createSkillMemoryHooks(options)`**: Returns a `{ prepareStep, onStep }` hook pair that recalls and stores skill-specific memory.

**Proposals:**

- **`createProposalToolbox(options)`**: Returns a plain object of four `Tool` instances — `{ listProposals, viewProposal, acceptProposal, rejectProposal }` (the `list_proposals`, `view_proposal`, `accept_proposal`, and `reject_proposal` tools). Like `createSkillToolbox`, it is not an armorer `Toolbox`; spread the tools into `createToolbox([...])` to build one.
- **`createAcceptProposalTool(options)`**, **`createListProposalsTool(options)`**, **`createRejectProposalTool(options)`**, **`createViewProposalTool(options)`**: Create individual proposal tools.
- **`saveProposal(store, content, options?)`**: Persists a skill proposal to storage.
- **`acceptProposal(store, id, provider, options?)`**: Parses the proposal as `SKILL.md` and saves it through the provider.
- **`rejectProposal(store, id, options?)`**: Records the proposal's content hash as rejected so duplicates are blocked.
- **`listProposals(store, options?)`**: Returns all stored proposals.
- **`getProposal(store, id)`**: Returns a single `Proposal` by ID, or `undefined`.
- **`clearProposals(store)`**: Removes all proposals from storage.
- **`isRejectedPattern(store, content)`**: Returns `true` if the content hash matches a previously rejected proposal.

---

### `skills/test`

Testing utilities for code that depends on `SkillProvider`. Both require no filesystem or network access, but their methods are async (Promise-returning) — `await` store and provider calls as the examples below do.

```typescript
import { createMockKeyValueStore, createMockSkillProvider } from 'skills/test';
import { parseSkillMarkdown } from 'skills';

// In-memory TextValueStore backed by Weft MemoryStorage—
// drop-in replacement for production stores in unit tests.
const store = createMockKeyValueStore();
await store.set('hello', 'world');
const value = await store.get('hello'); // 'world'

// Mock SkillProvider with full call tracking
const provider = createMockSkillProvider([
  parseSkillMarkdown(`---
name: code-review
description: Review code.
---
Body here.
`),
]);

const catalog = await provider.listSkills();
// [{ name: 'code-review', description: 'Review code.' }]

const skill = await provider.loadSkill('code-review');
// { metadata: { name: 'code-review', ... }, body: 'Body here.' }

// Inspect every method call for assertions
const calls = provider.calls;
// [{ method: 'listSkills', args: [] }, { method: 'loadSkill', args: ['code-review'] }]
```

**Key exports:**

- **`createMockKeyValueStore()`**: Returns a `TextValueStore` backed by Weft's `MemoryStorage`. No `init()` or setup is required, but all `TextValueStore` methods (`get`, `set`, `delete`, `list`, etc.) are async and return Promises — `await` them.
- **`createMockSkillProvider(initialSkills?)`**: Returns a `SkillProvider` plus a `calls` array. Every method call—`listSkills`, `loadSkill`, `saveSkill`, `deleteSkill`, `listResources`, `loadResource`, `saveResource`, `isEnabled`, `setEnabled`—is logged to `calls` as `{ method, args }`.

---

## Development

Run package checks from this directory:

```bash
bun run validate
bun run build
```
