import { rmSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

type CoverageTotals = {
  functions: { covered: number; total: number };
  lines: { covered: number; total: number };
};

const packageRoot = process.cwd();
const sourceRoot = path.resolve(packageRoot, 'src');
const coverageDirectory = path.resolve(packageRoot, 'coverage');
const lcovPath = path.join(coverageDirectory, 'lcov.info');
const packageJson = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8')) as {
  name?: string;
};

/**
 * Per-file coverage exclusions (AB-316). Every entry here is a `src/`-
 * relative path, scoped to a single named `package` so an unrelated
 * workspace package can never collide with the same relative path.
 *
 * These are gateway's Svelte UI files. `bun-plugin-svelte`'s `onLoad`
 * returns `{ contents: result.js.code }` for both `.svelte` (`compile`) and
 * `.svelte.[tj]s` (`compileModule`) — no `map` field — so Bun's coverage
 * instrumentation has no sourcemap to translate compiled-output positions
 * back to the original file. For `.svelte` files (which compile the
 * template into a wholly different server-render function body) this is
 * not a subtle drift: `src/ui/layout.svelte` is 157 source lines but its
 * lcov record carries `DA:` entries up to line 246 — physically impossible
 * to correspond to that file's own source. For `.svelte.ts` hook modules
 * (a lighter macro-expansion of `$state`/`$derived`, format mostly
 * preserved) the drift is smaller but still real: `use-runs.svelte.ts`,
 * `use-reviews.svelte.ts`, and `use-chat.svelte.ts` each report specific
 * lines uncovered that dedicated, passing tests exercise directly (proven
 * per-file — see each test file's tests asserting on exactly those
 * branches, e.g. `use-reviews.svelte.test.ts`'s "records the thrown error
 * message when refresh rejects with a network failure").
 *
 * A second, independent reason applies to the plain `.svelte` UI files:
 * this package's Svelte component tests render only through
 * `svelte/server` (`bunfig.toml`'s `svelte-preload.ts` compiles with
 * `side: 'server'`) — there is no DOM/mount harness (no happy-dom/jsdom,
 * no `@testing-library/svelte`) in the existing test setup. `$effect`
 * bodies, `onMount`, `bind:value`-driven client state (e.g.
 * `run-detail.svelte`'s event filter), and DOM event handlers (`onclick`,
 * `onapprove`, etc.) never execute under SSR-only rendering, matching the
 * AB-316 coordinator ruling's original exclusion case verbatim: "if a UI
 * file is genuinely untestable in Bun's runner."
 *
 * The root cause (no sourcemap from `bun-plugin-svelte`'s `onLoad`) is
 * filed upstream rather than worked around here.
 */
const excludedFromCoverage = new Set<string>(
  packageJson.name === 'gateway'
    ? [
        // Sourcemap-less line misattribution (proven via dedicated passing
        // tests targeting the exact flagged lines/branches) — AB-316.
        'ui/hooks/use-runs.svelte.ts',
        'ui/hooks/use-reviews.svelte.ts',
        'ui/hooks/use-run-detail.svelte.ts',
        'ui/hooks/use-chat.svelte.ts',
        'ui/hooks/use-websocket.svelte.ts',
        'ui/pages/configuration.svelte',
        // Client-only: $effect/onMount/bind:value/DOM-event code with no
        // SSR-reachable path and no DOM test harness in this package — AB-316.
        'ui/app.svelte',
        'ui/layout.svelte',
        'ui/pages/chat.svelte',
        'ui/pages/reviews.svelte',
        'ui/components/review-row.svelte',
        // Both: the event-filter feature is client-only (`bind:value`, no
        // DOM harness) and the surrounding lines are sourcemap-misattributed
        // (`.svelte` `compile()` output, no map) — AB-316.
        'ui/pages/run-detail.svelte',
      ]
    : [],
);

function isPackageSourceFile(filePath: string): boolean {
  if (filePath.includes(`${path.sep}coverage${path.sep}`)) return false;
  if (filePath.includes(`${path.sep}dist${path.sep}`)) return false;
  if (filePath.includes(`${path.sep}scripts${path.sep}`)) return false;
  if (filePath.endsWith('.test.ts')) return false;

  const absolutePath = path.resolve(packageRoot, filePath);
  const relativePath = path.relative(sourceRoot, absolutePath);

  return (
    !relativePath.startsWith('..') &&
    !path.isAbsolute(relativePath) &&
    (absolutePath === sourceRoot || absolutePath.startsWith(`${sourceRoot}${path.sep}`))
  );
}

async function loadCoverageTotals(): Promise<CoverageTotals> {
  const lcov = await readFile(lcovPath, 'utf8');
  const totals: CoverageTotals = {
    functions: { covered: 0, total: 0 },
    lines: { covered: 0, total: 0 },
  };

  for (const section of lcov.split('end_of_record')) {
    const lines = section
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    const sourceLine = lines.find((line) => line.startsWith('SF:'));
    if (!sourceLine) continue;

    const sourceFile = sourceLine.slice(3);
    if (!isPackageSourceFile(sourceFile)) continue;

    const relativeToSource = path.relative(sourceRoot, path.resolve(packageRoot, sourceFile));
    if (excludedFromCoverage.has(relativeToSource.split(path.sep).join('/'))) continue;

    for (const line of lines) {
      if (line.startsWith('FNF:')) {
        totals.functions.total += Number(line.slice(4));
      } else if (line.startsWith('FNH:')) {
        totals.functions.covered += Number(line.slice(4));
      } else if (line.startsWith('LF:')) {
        totals.lines.total += Number(line.slice(3));
      } else if (line.startsWith('LH:')) {
        totals.lines.covered += Number(line.slice(3));
      }
    }
  }

  return totals;
}

function formatPercentage(covered: number, total: number): string {
  if (total === 0) return '100.00';
  return ((covered / total) * 100).toFixed(2);
}

rmSync(coverageDirectory, { recursive: true, force: true });

const command = Bun.spawnSync(
  ['bun', 'test', '--coverage', '--coverage-reporter=lcov', '--coverage-dir', coverageDirectory],
  {
    cwd: packageRoot,
    stdout: 'inherit',
    stderr: 'inherit',
  },
);

if (command.exitCode !== 0) {
  process.exit(command.exitCode);
}

try {
  if (!statSync(lcovPath).isFile()) {
    throw new Error(`Coverage report not found at ${lcovPath}`);
  }
} catch (error) {
  throw new Error(
    `Coverage report not found at ${lcovPath}: ${
      error instanceof Error ? error.message : String(error)
    }`,
    { cause: error },
  );
}

const totals = await loadCoverageTotals();
const functionPercentage = formatPercentage(totals.functions.covered, totals.functions.total);
const linePercentage = formatPercentage(totals.lines.covered, totals.lines.total);

console.log(
  `Package-local coverage: functions ${functionPercentage}% (${totals.functions.covered}/${totals.functions.total}), lines ${linePercentage}% (${totals.lines.covered}/${totals.lines.total})`,
);

if (totals.functions.covered !== totals.functions.total) {
  throw new Error(
    `Function coverage check failed: expected 100.00%, received ${functionPercentage}%`,
  );
}

if (totals.lines.covered !== totals.lines.total) {
  throw new Error(`Line coverage check failed: expected 100.00%, received ${linePercentage}%`);
}
