# CLAUDE.md

This file provides guidance to Claude Code when working with code in the agent-bureau monorepo.

## Fix Problems, Do Not Report Them

When you encounter pre-existing warnings, lint errors, type errors, or other issues — fix them. Do not report them, do not ask permission to fix them, do not list them as "pre-existing issues." Just fix them.

This applies to everything: compiler warnings, ESLint violations, TypeScript errors, test failures, deprecation warnings, console.log leftovers, unused imports, unused variables. If you see it, fix it.

## Filing Work in Upstream Dependencies (weft, cinder)

This monorepo consumes **weft** (`@lostgradient/weft`) and **cinder** (`@lostgradient/cinder`) as published npm packages. Both live in sibling repositories: `../weft` and `../cinder`. When you hit a bug, missing feature, or needed change that belongs _in one of those libraries_ — not in our consuming code — file it against that repository instead of working around it here.

**Decide whose problem it is first.** Is the defect in the dependency's published surface, or in how we consume it? If ours, fix it here. If theirs, file it upstream. Do not patch `node_modules/@lostgradient/weft`, vendor a copy, or build a shim layer to route around an upstream bug — those are exactly the compatibility-bridge patterns we don't allow.

**File in the owning Linear team first, not a local ticket.** Both of these repos have an owning Linear team in the `lost-gradient` workspace today — `weft` is `WFT`, `cinder` is `CIN` — per the team map in `~/.claude/CLAUDE.md`'s "Lost Gradient Linear operating rules" and `~/Vaults/Lost Gradient/Linear Plan.md`. File the issue there with a minimal repro, the version agent-bureau consumes, expected vs. actual behavior, and what we need from the fix. If the agent-bureau work this came from is itself a Linear issue, create a native `blocked by` relation from it to the new upstream issue — never only a mention in prose. Only fall back to filing locally with Scrumlord's `tasks create --project <owner/repo>` (bare names like `--project weft` work when unambiguous; still the right tool for agent-bureau's own local task graph) when the affected repository has no owning Linear team.

**As the primary coordinator, file it yourself, then report.** These are all the user's own repositories, so go ahead and create the Linear issue without asking first. Per the standing Lost Gradient rule, the primary coordinator is the sole Linear writer — do the write directly rather than delegating it to a subagent, read the created issue back to confirm it landed, and report its identifier and URL so the user can track it.

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
