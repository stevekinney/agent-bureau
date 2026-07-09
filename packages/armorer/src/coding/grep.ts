import { z } from 'zod';

import { createTool } from '../create-tool';
import type { Tool } from '../is-tool';
import type { RootJail } from './jail';

/** Default cap on the number of matches returned. */
export const DEFAULT_GREP_MAX_MATCHES = 200;
/** Files larger than this (bytes) are skipped rather than scanned. */
export const DEFAULT_GREP_MAX_FILE_BYTES = 1_048_576; // 1 MiB

const SAFE_REGEX_FLAGS = new Set(['i', 'm', 's']);

export interface CreateGrepToolOptions {
  /** Root jail all scanned paths are resolved against. */
  jail: RootJail;
  name?: string;
  description?: string;
  /** Default number of matches returned when the caller omits `maxMatches`. */
  defaultMaxMatches?: number;
  /** Files larger than this (bytes) are skipped rather than scanned. */
  maxFileBytes?: number;
}

export interface GrepMatch {
  /** Repository-relative path of the matching file. */
  path: string;
  /** 1-indexed line number of the match. */
  line: number;
  text: string;
}

export interface GrepResult {
  matches: GrepMatch[];
  filesScanned: number;
  truncated: boolean;
}

/**
 * Creates a read-only `grep` tool jailed to `options.jail`'s root.
 *
 * Regex matching runs in-process against files enumerated by `Bun.Glob`
 * (never via `child_process` or a system `grep`). Every candidate path is
 * re-validated through the root jail before it is opened, so a symlink
 * discovered during the scan cannot be used to read outside the root.
 */
export function createGrepTool(options: CreateGrepToolOptions): Tool {
  const {
    jail,
    name = 'grep',
    description = 'Search files within the sandboxed root for lines matching a regular expression. Scope can be narrowed with a glob filter.',
    defaultMaxMatches = DEFAULT_GREP_MAX_MATCHES,
    maxFileBytes = DEFAULT_GREP_MAX_FILE_BYTES,
  } = options;

  return createTool({
    name,
    description,
    input: z.object({
      pattern: z.string().min(1).describe('Regular expression pattern to search for'),
      flags: z
        .string()
        .optional()
        .describe(`Optional regex flags, restricted to: ${[...SAFE_REGEX_FLAGS].join(', ')}`),
      glob: z
        .string()
        .optional()
        .describe(
          'Repository-relative glob pattern narrowing which files are scanned, e.g. "src/**/*.ts" (default "**/*")',
        ),
      maxMatches: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(`Maximum number of matches to return (default ${defaultMaxMatches})`),
    }),
    tags: ['coding', 'filesystem', 'readonly', 'search'],
    metadata: { readOnly: true, mutates: false, dangerous: false },
    async execute({ pattern, flags, glob: globPattern = '**/*', maxMatches }): Promise<GrepResult> {
      const effectiveMaxMatches = maxMatches ?? defaultMaxMatches;
      const regex = compileSafeRegex(pattern, flags);

      const matches: GrepMatch[] = [];
      let filesScanned = 0;
      let truncated = false;

      const glob = new Bun.Glob(globPattern);
      const scan = glob.scan({
        cwd: jail.root,
        onlyFiles: true,
        dot: false,
        followSymlinks: false,
      });

      for await (const relativeCandidate of scan) {
        if (truncated) break;

        let text: string;
        try {
          const resolvedPath = await jail.resolve(relativeCandidate);
          const file = Bun.file(resolvedPath);
          if (file.size > maxFileBytes) continue;
          filesScanned += 1;
          text = await file.text();
        } catch {
          // Symlink escapes the root, a transient read error, or another
          // traversal/I-O issue: skip this candidate.
          continue;
        }

        if (isLikelyBinary(text)) continue;

        const lines = text.split('\n');
        for (let index = 0; index < lines.length; index += 1) {
          const lineText = lines[index];
          if (lineText === undefined) continue;
          regex.lastIndex = 0;
          if (regex.test(lineText)) {
            matches.push({ path: relativeCandidate, line: index + 1, text: lineText });
            if (matches.length >= effectiveMaxMatches) {
              truncated = true;
              break;
            }
          }
        }
      }

      return { matches, filesScanned, truncated };
    },
  });
}

function compileSafeRegex(pattern: string, flags?: string): RegExp {
  const requestedFlags = flags ?? '';
  for (const flag of requestedFlags) {
    if (!SAFE_REGEX_FLAGS.has(flag)) {
      throw new Error(
        `Unsupported regex flag "${flag}". Allowed flags: ${[...SAFE_REGEX_FLAGS].join(', ')}`,
      );
    }
  }
  try {
    return new RegExp(pattern, requestedFlags);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid regular expression: ${message}`, { cause: error });
  }
}

function isLikelyBinary(text: string): boolean {
  return text.includes('\0');
}
