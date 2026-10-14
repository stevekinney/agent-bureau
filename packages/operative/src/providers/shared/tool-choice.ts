/**
 * Models that reject forced tool choice (`tool_choice` `{"type": "any"}` or
 * `{"type": "tool", "name": ...}`, this package's `'required'` and `{ tool }`)
 * with a 400, while `auto` and `none` stay valid. Per
 * https://platform.claude.com/docs/en/build-with-claude/thinking (Thinking with
 * tool use), confirmed 2026-10-14: "Adaptive thinking, including on models
 * where thinking is on by default, supports forced tool use, except on Claude
 * Opus 5.5, Claude Sonnet 5.5, Claude Fable 5.1, and Claude Mythos 5.1". The
 * Opus 5.5 migration guide and the Fable 5.1 what's-new page say the same, the
 * latter quoting the error "tool_choice: type "tool" and "any" are not
 * supported for this model."
 *
 * Every other model is unguarded: the page's exception list names only these
 * four, so Fable 5, Mythos 5, Opus 5, Sonnet 5 and earlier models are treated
 * as accepting forced choice (manual thinking's own restriction is a separate
 * rule, enforced by `assertThinkingParametersCompatible`).
 */
export const ANTHROPIC_FORCED_TOOL_CHOICE_REJECTED: ReadonlySet<string> = new Set([
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'claude-fable-5-1',
  'claude-mythos-5-1',
]);
