# IDE And Worktree Workflows

## Goal

Make the coding-agent experience a first-class product surface instead of an incidental use of tools. The focus is local code understanding, isolated edit surfaces, and developer-friendly review loops.

## In Scope

- file search, symbol search, and LSP-backed navigation
- isolated worktree management for delegated coding tasks
- code edit planning with explicit write ownership
- local verification hooks tied to the task lifecycle
- UI affordances for patch review, apply, reject, and re-run

## Out of Scope

- a full IDE replacement
- language-server implementation inside this repository
- generalized container orchestration for build sandboxes

## Acceptance Signals

- a coding task can open an isolated worktree, make changes, and report the write set
- the UI can show pending edits and verification status before changes are accepted
- symbol-aware search can answer navigation questions better than plain text search alone
- delegated coding runs can complete without clobbering unrelated local work
