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

```ts
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

In an agent loop, call `catalogHook.prepareStep(context)` on step 0 and inject the returned string into the conversation. Add `skillTools` to the active toolbox so the agent can activate skills and load resources when the catalog says one is relevant.

## Ingesting Skills

Use `scanDirectory()` when skills live on disk:

```ts
import { createStorageSkillProvider, scanDirectory } from 'skills';

const provider = createStorageSkillProvider(textValueStore);

const result = await scanDirectory('/path/to/skills', provider);

if (result.errors.length > 0) {
  console.error(result.errors);
}
```

Each directory containing a `SKILL.md` becomes one skill. Other files in that same directory become resources for that skill.

Use `fetchFromRegistry()` when a registry serves skill files at `{baseUrl}/{name}/SKILL.md`:

```ts
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

## Public Entry Points

- Parsing: `parseSkillMarkdown()`, `serializeSkillMarkdown()`, `isValidSkillName()`
- Providers: `createStaticSkillProvider()`, `createStorageSkillProvider()`
- Ingestion: `scanDirectory()`, `fetchFromRegistry()`
- Runtime state: `createSkillSession()`
- Runtime hooks: `createSkillCatalogHook()`, `createSkillMemoryHooks()`
- Tools: `createSkillToolbox()`, `createActivateSkillTool()`, `createLoadSkillResourceTool()`, `createDeactivateSkillTool()`, `createListSkillsTool()`
- Memory: `createSkillMemory()`
- Proposals: `createProposalToolbox()`, `saveProposal()`, `acceptProposal()`, `rejectProposal()`, `listProposals()`

## Development

Run package checks from this directory:

```bash
bun run validate
bun run build
```
