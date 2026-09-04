import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import {
  applyMutation,
  assertOperatorsMatch,
  collectMutationCandidates,
  compareToBaseline,
  findSymbolBody,
  MUTATION_OPERATORS,
  realFileSystem as fs,
  type MutationTargetSet,
  runTargetSet,
  spawnCommand as spawn,
} from './check-mutation';

const FIXTURE_DIR = join(import.meta.dir, 'fixtures/mutation');
const FIXTURE_FILE = join(FIXTURE_DIR, 'classify.ts');
const KILLED_TEST = join(FIXTURE_DIR, 'classify.killed.test.ts');
const SURVIVED_TEST = join(FIXTURE_DIR, 'classify.survived.test.ts');
const REPO_ROOT = join(import.meta.dir, '..');

describe('findSymbolBody', () => {
  it('locates a function declaration by name', () => {
    const body = findSymbolBody('function foo() { return 1; }', 'x.ts', 'foo');
    expect(body.statements.length).toBe(1);
  });

  it('locates a const-assigned arrow function by name', () => {
    const body = findSymbolBody('const foo = (x: number) => { return x; }', 'x.ts', 'foo');
    expect(body.statements.length).toBe(1);
  });

  it('locates a method inside an object literal by name', () => {
    const body = findSymbolBody('const obj = { foo() { return 1; } };', 'x.ts', 'foo');
    expect(body.statements.length).toBe(1);
  });

  it('throws when no implementation matches the symbol', () => {
    expect(() => findSymbolBody('function bar() {}', 'x.ts', 'foo')).toThrow(
      /No implementation of symbol "foo"/,
    );
  });

  it('throws when the symbol is ambiguous', () => {
    expect(() =>
      findSymbolBody(
        'function foo() { return 1; } const foo2 = () => { return foo; };',
        'x.ts',
        'foo',
      ),
    ).not.toThrow();
    expect(() =>
      findSymbolBody(
        'function foo() { return 1; } const obj = { foo() { return 2; } };',
        'x.ts',
        'foo',
      ),
    ).toThrow(/ambiguous/);
  });

  it('selects a specific same-named implementation by occurrence', () => {
    const source = 'function foo() { return 1; } const obj = { foo() { return 2; } };';
    const first = findSymbolBody(source, 'x.ts', 'foo', 1);
    const second = findSymbolBody(source, 'x.ts', 'foo', 2);
    expect(first.getText()).toContain('return 1');
    expect(second.getText()).toContain('return 2');
  });

  it('throws when the requested occurrence does not exist', () => {
    expect(() => findSymbolBody('function foo() { return 1; }', 'x.ts', 'foo', 2)).toThrow(
      /occurrence 2 does not exist/,
    );
  });

  it('does not match a same-named interface method signature (no block body)', () => {
    expect(() =>
      findSymbolBody('interface X { foo(): void; } function foo() { return 1; }', 'x.ts', 'foo'),
    ).not.toThrow();
  });
});

describe('collectMutationCandidates against the classify fixture', () => {
  it('finds one candidate per operator per applicable site', async () => {
    const text = await Bun.file(FIXTURE_FILE).text();
    const candidates = collectMutationCandidates(text, FIXTURE_FILE, 'classify');

    const byOperator = new Map<string, number>();
    for (const candidate of candidates) {
      byOperator.set(candidate.operator, (byOperator.get(candidate.operator) ?? 0) + 1);
    }

    expect(byOperator.get('negate-boolean-condition')).toBe(2);
    expect(byOperator.get('swap-comparison-operator')).toBe(1);
    // 2 `record(...)` calls plus 1 whole-guard-clause removal (the leading
    // `if (Number.isNaN(value)) return 'unknown';`).
    expect(byOperator.get('remove-statement')).toBe(3);
    expect(byOperator.get('replace-returned-literal-with-default')).toBe(3);
  });

  it('produces candidates whose original text round-trips through applyMutation', async () => {
    const text = await Bun.file(FIXTURE_FILE).text();
    const candidates = collectMutationCandidates(text, FIXTURE_FILE, 'classify');

    for (const candidate of candidates) {
      const mutated = applyMutation(text, candidate);
      expect(mutated).not.toBe(text);
      expect(text.slice(candidate.start, candidate.end)).toBe(candidate.originalText);
    }
  });
});

describe('collectMutationCandidates: guard-clause whole-removal', () => {
  it('removes a braceless guard clause (`if (cond) return;`) as one remove-statement candidate', () => {
    const source = 'function f(x: number) { if (x < 0) return -1; return x; }';
    const candidates = collectMutationCandidates(source, 'x.ts', 'f');
    const guardRemovals = candidates.filter(
      (c) => c.operator === 'remove-statement' && c.originalText.startsWith('if ('),
    );
    expect(guardRemovals.length).toBe(1);
    expect(guardRemovals[0]?.originalText).toBe('if (x < 0) return -1;');
  });

  it('removes a braced guard clause (`if (cond) { return; }`) as one remove-statement candidate', () => {
    const source = 'function f(x: number) { if (x < 0) { return -1; } return x; }';
    const candidates = collectMutationCandidates(source, 'x.ts', 'f');
    const guardRemovals = candidates.filter(
      (c) => c.operator === 'remove-statement' && c.originalText.startsWith('if ('),
    );
    expect(guardRemovals.length).toBe(1);
  });

  it('does not whole-remove an if/else (removal would change which branch remains, not delete a guard)', () => {
    const source = 'function f(x: number) { if (x < 0) { return -1; } else { return 1; } }';
    const candidates = collectMutationCandidates(source, 'x.ts', 'f');
    const guardRemovals = candidates.filter(
      (c) => c.operator === 'remove-statement' && c.originalText.startsWith('if ('),
    );
    expect(guardRemovals).toEqual([]);
  });

  it('does not whole-remove an if whose branch does more than return', () => {
    const source = 'function f(x: number) { if (x < 0) { log(x); return -1; } return x; }';
    const candidates = collectMutationCandidates(source, 'x.ts', 'f');
    const guardRemovals = candidates.filter(
      (c) => c.operator === 'remove-statement' && c.originalText.startsWith('if ('),
    );
    expect(guardRemovals).toEqual([]);
  });
});

describe('applyMutation', () => {
  it('splices the replacement text at the candidate boundaries', () => {
    const text = 'if (a === b) { return; }';
    const start = text.indexOf('===');
    const mutated = applyMutation(text, {
      operator: 'swap-comparison-operator',
      start,
      end: start + 3,
      originalText: '===',
      replacementText: '!==',
      line: 1,
    });
    expect(mutated).toBe('if (a !== b) { return; }');
  });
});

describe('spawnCommand', () => {
  it('runs a real command and captures its exit code and output', () => {
    const result = spawn(['bun', '--version'], REPO_ROOT);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim().length).toBeGreaterThan(0);
  });

  it('captures a non-zero exit code from a failing command', () => {
    const result = spawn(['bun', 'run', 'this-script-does-not-exist'], REPO_ROOT);
    expect(result.exitCode).not.toBe(0);
  });
});

describe('assertOperatorsMatch', () => {
  it('does not throw when the declared operators exactly match the fixed set, in any order', () => {
    expect(() => assertOperatorsMatch([...MUTATION_OPERATORS])).not.toThrow();
    expect(() => assertOperatorsMatch([...MUTATION_OPERATORS].reverse())).not.toThrow();
  });

  it('throws when a declared operator is missing', () => {
    const missingOne = MUTATION_OPERATORS.filter((op) => op !== 'remove-statement');
    expect(() => assertOperatorsMatch(missingOne)).toThrow(/Missing: remove-statement/);
  });

  it('throws when an unrecognized operator is declared', () => {
    expect(() => assertOperatorsMatch([...MUTATION_OPERATORS, 'delete-random-line'])).toThrow(
      /Unrecognized: delete-random-line/,
    );
  });

  it('throws when the array is empty', () => {
    expect(() => assertOperatorsMatch([])).toThrow(/Missing:/);
  });
});

describe('compareToBaseline', () => {
  it('reports no regression when survivors equal the recorded baseline', () => {
    const comparison = compareToBaseline('set-a', 2, { 'set-a': 2 });
    expect(comparison.regressed).toBe(false);
    expect(comparison.improved).toBe(false);
  });

  it('reports a regression when survivors exceed the recorded baseline', () => {
    const comparison = compareToBaseline('set-a', 3, { 'set-a': 2 });
    expect(comparison.regressed).toBe(true);
  });

  it('reports an improvement (never a failure) when survivors drop below the baseline', () => {
    const comparison = compareToBaseline('set-a', 1, { 'set-a': 2 });
    expect(comparison.regressed).toBe(false);
    expect(comparison.improved).toBe(true);
  });

  it('treats an unrecorded target set as a baseline of zero', () => {
    const comparison = compareToBaseline('unseen', 1, {});
    expect(comparison.baselineCount).toBe(0);
    expect(comparison.regressed).toBe(true);
  });
});

/**
 * The killed-versus-survived fixture pair (AB-284's own acceptance criterion): these two tests
 * genuinely spawn `bun test` against the real fixture files under `scripts/fixtures/mutation/`
 * through `runTargetSet`'s default (real) command runner — proving the tool detects an unasserted
 * branch, not merely that its own unit logic is self-consistent. `rebuild` is empty for both:
 * the fixture uses a relative import with no workspace package/dist boundary involved.
 */
describe('runTargetSet against the real classify fixture (proves the check itself)', () => {
  it('reports zero survivors against the test that asserts every branch and side effect', async () => {
    const before = await Bun.file(FIXTURE_FILE).text();
    try {
      const set: MutationTargetSet = {
        name: 'fixture-killed',
        description: 'fixture pair — killed half',
        targets: [{ file: relativeToRoot(FIXTURE_FILE), symbol: 'classify', why: 'fixture' }],
        tests: [{ path: relativeToRoot(KILLED_TEST) }],
      };
      const result = runTargetSet(
        {
          repoRoot: REPO_ROOT,
          runCommand: spawn,
          fileSystem: fs,
        },
        set,
      );
      expect(result.survived).toEqual([]);
      expect(result.killedCount).toBeGreaterThan(0);
    } finally {
      expect(await Bun.file(FIXTURE_FILE).text()).toBe(before);
    }
  }, 30_000);

  it('reports every applicable mutant as survived against the test that never asserts the outcome', async () => {
    const before = await Bun.file(FIXTURE_FILE).text();
    try {
      const set: MutationTargetSet = {
        name: 'fixture-survived',
        description: 'fixture pair — survived half',
        targets: [{ file: relativeToRoot(FIXTURE_FILE), symbol: 'classify', why: 'fixture' }],
        tests: [{ path: relativeToRoot(SURVIVED_TEST) }],
      };
      const result = runTargetSet(
        {
          repoRoot: REPO_ROOT,
          runCommand: spawn,
          fileSystem: fs,
        },
        set,
      );
      expect(result.killedCount).toBe(0);
      expect(result.survived.length).toBeGreaterThan(0);
      for (const mutant of result.survived) {
        expect(mutant.testsPassed).toContain(relativeToRoot(SURVIVED_TEST));
      }
    } finally {
      expect(await Bun.file(FIXTURE_FILE).text()).toBe(before);
    }
  }, 30_000);

  it('tags a survivor with its recorded equivalent-mutant reason, when the target declares one', async () => {
    const before = await Bun.file(FIXTURE_FILE).text();
    try {
      const set: MutationTargetSet = {
        name: 'fixture-equivalent',
        description: 'fixture pair — a declared equivalent mutant',
        targets: [
          {
            file: relativeToRoot(FIXTURE_FILE),
            symbol: 'classify',
            why: 'fixture',
            equivalentMutants: [
              {
                operator: 'remove-statement',
                reason: 'fixture: declared equivalent for this test',
              },
            ],
          },
        ],
        tests: [{ path: relativeToRoot(SURVIVED_TEST) }],
      };
      const result = runTargetSet({ repoRoot: REPO_ROOT, runCommand: spawn, fileSystem: fs }, set);
      const removeStatementSurvivors = result.survived.filter(
        (mutant) => mutant.operator === 'remove-statement',
      );
      expect(removeStatementSurvivors.length).toBeGreaterThan(0);
      for (const mutant of removeStatementSurvivors) {
        expect(mutant.equivalentReason).toBe('fixture: declared equivalent for this test');
      }
      // An operator NOT named in equivalentMutants is reported as a plain (unclassified) survivor.
      const otherSurvivors = result.survived.filter(
        (mutant) => mutant.operator !== 'remove-statement',
      );
      expect(otherSurvivors.length).toBeGreaterThan(0);
      for (const mutant of otherSurvivors) {
        expect(mutant.equivalentReason).toBeUndefined();
      }
    } finally {
      expect(await Bun.file(FIXTURE_FILE).text()).toBe(before);
    }
  }, 30_000);

  it('throws when the covering test does not pass against unmutated source', () => {
    const set: MutationTargetSet = {
      name: 'broken-suite',
      description: 'a covering test that already fails before any mutation',
      targets: [{ file: relativeToRoot(FIXTURE_FILE), symbol: 'classify', why: 'fixture' }],
      tests: [{ path: 'scripts/fixtures/mutation/does-not-exist.test.ts' }],
    };
    expect(() =>
      runTargetSet(
        {
          repoRoot: REPO_ROOT,
          runCommand: spawn,
          fileSystem: fs,
        },
        set,
      ),
    ).toThrow(/covering tests do not pass/);
  }, 30_000);

  it('counts a rebuild failure on a mutant as killed, not as a thrown error', async () => {
    const text = await Bun.file(FIXTURE_FILE).text();
    const candidateCount = collectMutationCandidates(text, FIXTURE_FILE, 'classify').length;
    let buildCalls = 0;
    const fakeRunCommand = (command: readonly string[]) => {
      if (command.includes('build')) {
        buildCalls += 1;
        // Call 1 is the pre-mutation sanity pass and must succeed, or `runTargetSet` throws
        // before any mutant runs. Calls 2..candidateCount+1 are one per mutant, and simulate a
        // mutation that broke the type-check (e.g. defeated a narrowing guard elsewhere in the
        // file) — this must count as the mutant being KILLED, not crash the whole check. The
        // FINAL call is `runTargetSet`'s own post-restore cleanup rebuild (restores `dist/` to
        // match the already-restored `src/`) and must also succeed, or that legitimate
        // (Copilot-review-driven) fail-fast throws and this test would be indistinguishable from
        // a real infrastructure failure.
        return buildCalls === 1 || buildCalls > candidateCount + 1
          ? { exitCode: 0, stdout: '', stderr: '' }
          : { exitCode: 1, stdout: '', stderr: 'type error' };
      }
      // Never reached for a killed-by-build mutant: `runTests` skips the `bun test` step
      // once its rebuild fails.
      return spawn(command, REPO_ROOT);
    };

    const set: MutationTargetSet = {
      name: 'fixture-build-failure',
      description: 'a covering test that requires a (fake, failing) rebuild',
      targets: [{ file: relativeToRoot(FIXTURE_FILE), symbol: 'classify', why: 'fixture' }],
      tests: [{ path: relativeToRoot(KILLED_TEST), rebuild: ['fixture-package'] }],
    };

    try {
      const result = runTargetSet(
        {
          repoRoot: REPO_ROOT,
          runCommand: fakeRunCommand,
          fileSystem: fs,
        },
        set,
      );
      expect(result.survived).toEqual([]);
      expect(result.killedCount).toBeGreaterThan(0);
    } finally {
      expect(await Bun.file(FIXTURE_FILE).text()).toBe(text);
    }
  }, 30_000);

  it('throws (fails fast) when the post-restore cleanup rebuild itself fails', async () => {
    const text = await Bun.file(FIXTURE_FILE).text();
    const candidateCount = collectMutationCandidates(text, FIXTURE_FILE, 'classify').length;
    let buildCalls = 0;
    // Every build call succeeds — sanity (call 1) and one per mutant (calls 2..candidateCount+1)
    // — EXCEPT the final call: `runTargetSet`'s own post-restore cleanup rebuild. That failure
    // must surface as a thrown error, never be silently swallowed (a Copilot-review-driven fix: a
    // swallowed failure here would leave `dist/` built from a mutant's `src/` while the
    // repository's own `src/` is already restored).
    const fakeRunCommand = (command: readonly string[]) => {
      if (command.includes('build')) {
        buildCalls += 1;
        return buildCalls > candidateCount + 1
          ? { exitCode: 1, stdout: '', stderr: 'build infra failure' }
          : { exitCode: 0, stdout: '', stderr: '' };
      }
      return spawn(command, REPO_ROOT);
    };

    const set: MutationTargetSet = {
      name: 'fixture-final-rebuild-failure',
      description: 'every rebuild fails, including the final cleanup one',
      targets: [{ file: relativeToRoot(FIXTURE_FILE), symbol: 'classify', why: 'fixture' }],
      tests: [{ path: relativeToRoot(KILLED_TEST), rebuild: ['fixture-package'] }],
    };

    try {
      expect(() =>
        runTargetSet({ repoRoot: REPO_ROOT, runCommand: fakeRunCommand, fileSystem: fs }, set),
      ).toThrow(/failed to rebuild package "fixture-package" after restoring source/);
    } finally {
      // The source file itself is still restored even though the cleanup rebuild threw — the
      // per-mutant `finally` (not the target-set-level one that does the rebuild) already
      // wrote it back before the throw ever happens.
      expect(await Bun.file(FIXTURE_FILE).text()).toBe(text);
    }
  }, 30_000);

  it('refuses to run against a target file with uncommitted changes', async () => {
    const set: MutationTargetSet = {
      name: 'dirty-guard',
      description: 'refuses a dirty target file',
      targets: [{ file: relativeToRoot(FIXTURE_FILE), symbol: 'classify', why: 'fixture' }],
      tests: [{ path: relativeToRoot(KILLED_TEST) }],
    };
    expect(() =>
      runTargetSet(
        {
          repoRoot: REPO_ROOT,
          runCommand: spawn,
          fileSystem: fs,
          checkGitClean: () => false,
        },
        set,
      ),
    ).toThrow(/uncommitted changes/);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function relativeToRoot(path: string): string {
  return path.startsWith(`${REPO_ROOT}/`) ? path.slice(REPO_ROOT.length + 1) : path;
}
