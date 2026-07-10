/**
 * AB-99 — a minimal, real git repository standing in for the checked-out
 * repository Tribunal's runner operates against. `read_base_file` (mirroring
 * `run-agent.mjs`'s `createGitBaseFileReader`) shells out to
 * `git show <baseSha>:<path>`, so the fixture needs an actual git history —
 * a base commit and a head commit with one changed file — not just files on
 * disk.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TribunalFixtureRepo {
  /** Real (non-symlinked) repository root — the coding toolbox's jail root. */
  repositoryPath: string;
  baseSha: string;
  headSha: string;
  /** Repository-relative path of the file changed between base and head. */
  changedFilePath: string;
  /** Cleans up the temp directory. Call in `afterEach`/`finally`. */
  cleanup: () => Promise<void>;
}

async function git(repositoryPath: string, args: string[]): Promise<string> {
  const result = Bun.spawnSync({
    cmd: ['git', '-C', repositoryPath, ...args],
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'ab-99',
      GIT_AUTHOR_EMAIL: 'ab-99@example.invalid',
      GIT_COMMITTER_NAME: 'ab-99',
      GIT_COMMITTER_EMAIL: 'ab-99@example.invalid',
    },
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed (${result.exitCode}): ${result.stderr.toString('utf8')}`,
    );
  }
  return result.stdout.toString('utf8').trim();
}

/**
 * Creates a temp git repository with a base commit (one file) and a head
 * commit (that file modified) — enough surface for `get_changed_files`,
 * `read_base_file` (`git show baseSha:path`), and the coding toolbox's
 * jailed reads to all have something real to operate on.
 */
export async function createTribunalFixtureRepo(): Promise<TribunalFixtureRepo> {
  const repositoryPath = await mkdtemp(join(tmpdir(), 'ab99-tribunal-repo-'));
  const changedFilePath = 'src/widget.ts';

  await git(repositoryPath, ['init', '--initial-branch=main']);

  await mkdir(join(repositoryPath, 'src'), { recursive: true });
  await writeFile(
    join(repositoryPath, changedFilePath),
    ['export function widget(a: number, b: number): number {', '  return a + b;', '}', ''].join(
      '\n',
    ),
    { encoding: 'utf8' },
  );
  await git(repositoryPath, ['add', '.']);
  await git(repositoryPath, ['commit', '-m', 'base: add widget']);
  const baseSha = await git(repositoryPath, ['rev-parse', 'HEAD']);

  await writeFile(
    join(repositoryPath, changedFilePath),
    [
      'export function widget(a: number, b: number): number {',
      '  // BUG: silently coerces non-finite input instead of validating it.',
      '  return a + b || 0;',
      '}',
      '',
    ].join('\n'),
    { encoding: 'utf8' },
  );
  await git(repositoryPath, ['add', '.']);
  await git(repositoryPath, ['commit', '-m', 'head: introduce widget bug']);
  const headSha = await git(repositoryPath, ['rev-parse', 'HEAD']);

  return {
    repositoryPath,
    baseSha,
    headSha,
    changedFilePath,
    cleanup: () => rm(repositoryPath, { recursive: true, force: true }),
  };
}
