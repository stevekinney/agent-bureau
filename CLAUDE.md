# CLAUDE.md

This file provides guidance to Claude Code when working with code in the agent-bureau monorepo.

## Fix Problems, Do Not Report Them

When you encounter pre-existing warnings, lint errors, type errors, or other issues — fix them. Do not report them, do not ask permission to fix them, do not list them as "pre-existing issues." Just fix them.

This applies to everything: compiler warnings, ESLint violations, TypeScript errors, test failures, deprecation warnings, console.log leftovers, unused imports, unused variables. If you see it, fix it.

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
