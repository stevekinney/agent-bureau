import { z } from 'zod';

import { createTool } from '../create-tool';
import type { Tool } from '../is-tool';
import type { RootJail } from './jail';

/** Default cap on the number of paths returned. */
export const DEFAULT_GLOB_MAX_RESULTS = 500;

export interface CreateGlobToolOptions {
  /** Root jail all matched paths are resolved against. */
  jail: RootJail;
  name?: string;
  description?: string;
  /** Default number of paths returned when the caller omits `maxResults`. */
  defaultMaxResults?: number;
}

export interface GlobResult {
  paths: string[];
  truncated: boolean;
}

/**
 * Creates a read-only `glob` tool jailed to `options.jail`'s root.
 *
 * Patterns are repository-relative only — absolute paths and `..`
 * traversal are rejected up front, and `Bun.Glob` is scanned with
 * `followSymlinks: false`. Every match is additionally re-validated
 * through the root jail before being returned, so a symlink planted
 * inside the root cannot be used to enumerate paths outside it.
 */
export function createGlobTool(options: CreateGlobToolOptions): Tool {
  const {
    jail,
    name = 'glob',
    description = 'List repository-relative file paths within the sandboxed root matching a glob pattern.',
    defaultMaxResults = DEFAULT_GLOB_MAX_RESULTS,
  } = options;

  return createTool({
    name,
    description,
    input: z.object({
      pattern: z.string().min(1).describe('Repository-relative glob pattern, e.g. "src/**/*.ts"'),
      maxResults: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(`Maximum number of paths to return (default ${defaultMaxResults})`),
    }),
    tags: ['coding', 'filesystem', 'readonly', 'search'],
    metadata: { readOnly: true, mutates: false, dangerous: false },
    async execute({ pattern, maxResults }): Promise<GlobResult> {
      assertRepositoryRelativePattern(pattern);
      const effectiveMax = maxResults ?? defaultMaxResults;

      const paths: string[] = [];
      let truncated = false;

      const glob = new Bun.Glob(pattern);
      const scan = glob.scan({
        cwd: jail.root,
        onlyFiles: false,
        dot: false,
        followSymlinks: false,
      });

      for await (const relativeCandidate of scan) {
        try {
          await jail.resolve(relativeCandidate);
        } catch {
          // Symlink escapes the root (or another traversal issue): skip.
          continue;
        }

        if (paths.length >= effectiveMax) {
          truncated = true;
          break;
        }
        paths.push(relativeCandidate);
      }

      return { paths, truncated };
    },
  });
}

function assertRepositoryRelativePattern(pattern: string): void {
  if (pattern.startsWith('/') || pattern.startsWith('~')) {
    throw new Error(`Glob pattern must be repository-relative, got "${pattern}"`);
  }
  if (pattern.includes('\0')) {
    throw new Error('Glob pattern contains a null byte');
  }
  if (/(^|\/)\.\.(\/|$)/.test(pattern)) {
    throw new Error(`Glob pattern must not traverse outside the root: "${pattern}"`);
  }
}
