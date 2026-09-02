/**
 * Determinism gate focused runner (AB-278).
 *
 * `eslint.config.base.ts` wires `determinism/no-real-runtime-call` and
 * `determinism/no-global-transport-mutation` into every package's own `eslint .` via
 * `baseConfig`, so `turbo run lint` (and therefore `bun run validate`) already catches ordinary
 * violations. This script re-runs the SAME two rules — imported from `eslint.config.base.ts`,
 * not reimplemented — through ESLint's `ESLint` class in an isolated configuration where no
 * other rule is registered. Because nothing else shares that configuration, setting
 * `linterOptions.noInlineConfig: true` here disables inline `eslint-disable` comments for these
 * two rules ONLY, with no collateral effect on any other rule anywhere in the repository. That
 * is the gate's actual non-bypass guarantee (see the comment above `createDeterminismConfig` in
 * `eslint.config.base.ts` for why the per-package integration can't provide it for the
 * repo-wide transport-mutation rule without disabling inline-disable for every rule under
 * `packages/`). This script is wired into `bun run validate` directly — not merely available as
 * `bun run check-determinism` for a focused run — so that guarantee actually holds in CI.
 *
 * Usage: `bun run scripts/check-determinism.ts` (wired to `bun run check-determinism`).
 * Exit code 0 = no determinism violation found; 1 = at least one violation, printed with file,
 * line, and the offending call.
 */
import { resolve } from 'node:path';

import { ESLint } from 'eslint';
import globals from 'globals';
import tseslint from 'typescript-eslint';

import { createDeterminismConfig, determinismManifest } from '../eslint.config.base.ts';

export interface DeterminismViolation {
  readonly filePath: string;
  readonly line: number;
  readonly ruleId: string;
  readonly message: string;
}

/** Pure extraction from ESLint's own results — no filesystem access, unit-testable in isolation. */
export function extractDeterminismViolations(
  results: readonly ESLint.LintResult[],
): DeterminismViolation[] {
  const violations: DeterminismViolation[] = [];

  for (const result of results) {
    for (const message of result.messages) {
      if (!message.ruleId || !message.ruleId.startsWith('determinism/')) continue;
      violations.push({
        filePath: result.filePath,
        line: message.line,
        ruleId: message.ruleId,
        message: message.message,
      });
    }
  }

  return violations;
}

export function formatDeterminismViolation(violation: DeterminismViolation): string {
  return `${violation.filePath}:${violation.line} — ${violation.message}`;
}

/** Builds the isolated ESLint instance described above: only the two determinism rules, cwd-independent. */
function createDeterminismEslint(repoRoot: string): ESLint {
  return new ESLint({
    cwd: repoRoot,
    overrideConfigFile: true,
    overrideConfig: [
      { ignores: ['**/{dist,build,coverage,.bun}/**', '**/node_modules/**'] },
      {
        files: ['packages/**/*.{js,jsx,cjs,mjs,ts,tsx}'],
        languageOptions: {
          parser: tseslint.parser,
          ecmaVersion: 'latest' as const,
          sourceType: 'module' as const,
          // `setTimeout`/`crypto`/`performance`/`fetch`/`WebSocket`/`EventSource` are HOST
          // globals, not ECMAScript builtins — unlike `Date`/`Math`/`globalThis`, ESLint's scope
          // analysis does NOT recognize them as the ambient global without this. Without it, the
          // determinism rules' `isGlobalReference` checks (added to stop flagging a destructured
          // injected runtime — see eslint.config.base.ts) would see every one of these as an
          // unconfigured, unresolved reference and silently never flag them at all. Matches the
          // globals baseConfig itself configures, since this run must behave identically.
          globals: { ...globals.node, ...globals.browser },
        },
        linterOptions: { noInlineConfig: true },
      },
      ...createDeterminismConfig(determinismManifest, repoRoot),
    ],
  });
}

/** End-to-end check for a repository root: lints every `packages/**\/*.{ts,tsx}` file and returns every violation found. */
export async function runDeterminismGate(repoRoot: string): Promise<DeterminismViolation[]> {
  const eslint = createDeterminismEslint(repoRoot);
  const results = await eslint.lintFiles(['packages/**/*.{js,jsx,cjs,mjs,ts,tsx}']);
  return extractDeterminismViolations(results);
}

if (import.meta.main) {
  try {
    const repoRoot = resolve(import.meta.dir, '..');
    const violations = await runDeterminismGate(repoRoot);

    if (violations.length > 0) {
      console.error(`✖ ${violations.length} determinism violation(s):`);
      for (const violation of violations) {
        console.error(`  ${formatDeterminismViolation(violation)}`);
      }
      process.exit(1);
    }

    console.log(
      '✓ No real clocks, timers, identifiers, randomness, or global transport mutation found ' +
        'outside scripts/determinism-manifest.json.',
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`✖ ${message}`);
    process.exit(1);
  }
}
