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
