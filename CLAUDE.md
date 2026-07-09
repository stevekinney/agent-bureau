# CLAUDE.md

This file provides guidance to Claude Code when working with code in the agent-bureau monorepo.

## Fix Problems, Do Not Report Them

When you encounter pre-existing warnings, lint errors, type errors, or other issues — fix them. Do not report them, do not ask permission to fix them, do not list them as "pre-existing issues." Just fix them.

This applies to everything: compiler warnings, ESLint violations, TypeScript errors, test failures, deprecation warnings, console.log leftovers, unused imports, unused variables. If you see it, fix it.

## Filing Work in Upstream Dependencies (weft, cinder)

This monorepo consumes **weft** (`@lostgradient/weft`) and **cinder** (`@lostgradient/cinder`) as published npm packages. Both live in sibling repositories: `../weft` and `../cinder`. When you hit a bug, missing feature, or needed change that belongs _in one of those libraries_ — not in our consuming code — file a ticket against that repository instead of working around it here.

**Decide whose problem it is first.** Is the defect in the dependency's published surface, or in how we consume it? If ours, fix it here. If theirs, file a ticket. Do not patch `node_modules/@lostgradient/weft`, vendor a copy, or build a shim layer to route around an upstream bug — those are exactly the compatibility-bridge patterns we don't allow.

**Target the other repo with `--project`.** The `tasks` CLI defaults to the current repository, but `tasks create --project <owner/repo>` files against any registered project from anywhere — no `cd` required. Bare names work when unambiguous (`--project weft`, `--project cinder`). The same flag works on `tasks list` and `tasks get`, so you can read back what you filed without leaving agent-bureau.

```bash
tasks create --project weft \
  --title "Engine.recoverAll throws on duplicate run id" \
  --description "Consumed from agent-bureau via the @lostgradient/weft version declared in package.json.

Repro: ...
Expected: ...
Actual: ...
What we need: ..." \
  --tag agent-bureau --tag upstream
```

Write a ticket you'd want to receive: a minimal repro, the version agent-bureau consumes, the expected vs. actual behavior, and what we need from the fix. Always tag it `agent-bureau` so the originating project is findable from the other repo's backlog.

**Auto-file, then report.** These are all the user's own repositories and a misfile is reversible (`tasks delete`), so go ahead and create the ticket without asking first — then report the created task ID (and URL, if returned) back so the user can track it. Use `--draft` only if the request is genuinely ambiguous and needs the user's refinement before it's actionable.

## Session Hygiene

### When an Approach Fails

Save the failure to memory immediately as a `feedback` memory. Include what was tried, why it failed, and what the root cause was. Do not wait until the end of the session — future sessions will retry the failed approach without this record.

### Multi-Package Changes

When working through a multi-phase change across packages, suggest committing at phase boundaries. A commit after completing each layer of the dependency graph gives a named restore point and makes rollback straightforward.

### Long Sessions and Compaction

When context is getting long (many files read, many edits made), proactively summarize critical state before compaction occurs:

- What has been accomplished so far
- What remains to be done
- Any decisions made and their rationale
- Failed approaches already tried

Write this to TodoWrite or memory as appropriate — TodoWrite for current-session tracking, memory for knowledge that should survive across sessions.
