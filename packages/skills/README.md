# Skills

`skills` manages reusable procedural knowledge for Agent Bureau. It parses `SKILL.md` content, loads skill resources from static or storage-backed providers, injects active skill context into agent runs, and exposes tools for skill activation and self-improvement workflows.

## What It Does

- Parses and serializes `SKILL.md` files.
- Loads skills from static collections, storage, registries, and directories.
- Creates skill sessions that track active skills.
- Creates catalog hooks that inject active skill content into runtime context.
- Exposes tools for listing, activating, deactivating, and loading skill resources.
- Stores proposal workflows for accepting, rejecting, listing, and viewing suggested skill changes.
- Provides memory hooks for capturing useful skill context.

## How It Works

Skill content is represented as metadata plus Markdown body and optional resources. Providers expose that content through a common `SkillProvider` interface. Sessions decide which skills are active for a run, catalog hooks render the active skill context, and toolboxes let an agent or product surface manage the active set.

The storage-backed provider and proposal helpers use durable key-value storage so skill state can survive process restarts. Static providers and directory scanning keep local development and tests simple.

## Project Role

`skills` is the procedural knowledge layer. `gateway` can wire it into runtime composition, `operative` consumes it through hooks and tools, `armorer` exposes skill operations as validated tools, and `memory` can persist skill-related learning.

## Public Entry Points

- `parseSkillMarkdown()` and `serializeSkillMarkdown()`
- `createStaticSkillProvider()` and `createStorageSkillProvider()`
- `scanDirectory()` and `fetchFromRegistry()`
- `createSkillSession()`
- `createSkillCatalogHook()`
- `createSkillToolbox()` and individual skill tools
- `createProposalToolbox()` and proposal management helpers
- `createSkillMemory()` and `createSkillMemoryHooks()`

## Development

Run package checks from this directory:

```bash
bun run validate
bun run build
```
