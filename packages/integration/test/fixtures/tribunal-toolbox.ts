/**
 * AB-99 — a Tribunal-shaped armorer toolbox: `get_changed_files`,
 * `read_base_file` (`git show baseSha:path`, mirroring `run-agent.mjs`'s
 * `createGitBaseFileReader`), and `record_finding` with Tribunal's
 * collect-don't-post semantics (the tool appends to an in-memory array and
 * returns `{ recorded: true }` — it never posts anywhere; the caller reads
 * `collectedFindings` after the run, same as `run-agent.mjs`'s
 * `reviewTools.record_finding.collectedFindings`). Combined with armorer's
 * first-party read-only coding toolbox (AB-90), jailed to the fixture
 * repository root — the cwd jail Tribunal's runner relies on for `Read`.
 */
import type { HeadlessPermissionPolicyConfiguration, Tool } from 'armorer';
import { createTool } from 'armorer';
import { createCodingTools } from 'armorer/coding';
import { z } from 'zod';

import type { FindingLike } from './tribunal-schemas';

export interface ChangedFile {
  path: string;
  status: 'added' | 'modified' | 'removed' | 'renamed';
}

export interface TribunalDiffContext {
  repositoryPath: string;
  baseSha: string;
  headSha: string;
  changedFiles: ChangedFile[];
}

const findingInputSchema = z.object({
  path: z.string().min(1),
  startLine: z.number().int().positive().nullable(),
  endLine: z.number().int().positive().nullable(),
  side: z.enum(['LEFT', 'RIGHT']),
  severity: z.enum(['info', 'warning', 'error']),
  title: z.string().min(1),
  body: z.string().min(1),
  suggestion: z.string().optional(),
});

function readGitObjectAtRevision(
  repositoryPath: string,
  revision: string,
  filePath: string,
): string | null {
  const result = Bun.spawnSync({
    cmd: ['git', '-C', repositoryPath, 'show', `${revision}:${filePath}`],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return result.exitCode === 0 ? result.stdout.toString('utf8') : null;
}

export interface TribunalToolboxFixture {
  /** Tribunal-shaped review tools, keyed by their MCP-parity names. */
  tools: Tool[];
  /** Findings `record_finding` has collected so far — mutated in place. */
  collectedFindings: FindingLike[];
  /** Names allowed through the AB-94 headless gate for a review-shaped run. */
  allowedToolNames: string[];
}

/**
 * Builds the Tribunal-shaped toolbox for a given diff context. `readFile`/
 * `grep`/`glob` come from armorer's first-party read-only coding toolbox
 * (AB-90), jailed to `diffContext.repositoryPath` — the same cwd jail
 * Tribunal's sandboxed runner enforces via `enforceReadOnlyToolUse`.
 */
export function createTribunalToolboxFixture(
  diffContext: TribunalDiffContext,
): TribunalToolboxFixture {
  const collectedFindings: FindingLike[] = [];
  const coding = createCodingTools({ root: diffContext.repositoryPath });

  const getChangedFiles = createTool({
    name: 'get_changed_files',
    description: 'List the files changed in this pull request.',
    input: z.object({}),
    execute: async () => ({ changedFiles: diffContext.changedFiles }),
  });

  const readBaseFile = createTool({
    name: 'read_base_file',
    description: "Read a changed file's content at the base (pre-change) revision.",
    input: z.object({ path: z.string().min(1) }),
    execute: async ({ path }: { path: string }) => {
      const isChanged = diffContext.changedFiles.some((file) => file.path === path);
      if (!isChanged) return null;
      return readGitObjectAtRevision(diffContext.repositoryPath, diffContext.baseSha, path);
    },
  });

  const recordFinding = createTool({
    name: 'record_finding',
    description:
      'Record a confirmed review finding. Collect-don’t-post: this never publishes ' +
      'anywhere — findings are returned to the caller once the run completes.',
    input: z.object({ finding: findingInputSchema }),
    execute: async ({ finding }: { finding: z.infer<typeof findingInputSchema> }) => {
      collectedFindings.push(finding);
      return { recorded: true };
    },
  });

  return {
    tools: [
      getChangedFiles,
      readBaseFile,
      recordFinding,
      coding.readFile,
      coding.grep,
      coding.glob,
    ],
    collectedFindings,
    allowedToolNames: [
      'get_changed_files',
      'read_base_file',
      'record_finding',
      'read-file',
      'grep',
      'glob',
    ],
  };
}

/**
 * AB-94 headless deny-by-default permission configuration for a Tribunal-
 * shaped review run: only the review toolbox's own tool names are allowed,
 * everything else — including a hypothetical `bash`/`write`/`edit` call an
 * over-eager model might attempt — is denied outright.
 */
export function createTribunalPermissions(
  allowedToolNames: readonly string[],
): HeadlessPermissionPolicyConfiguration {
  return { allowList: allowedToolNames };
}
