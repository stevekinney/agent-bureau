import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { parseSkillMarkdown, SkillParseError } from '../parse-skill-markdown';
import type { SkillProvider } from '../types';

export interface ScanDirectoryOptions {
  /** Maximum directory depth to recurse. Default: 4. */
  maxDepth?: number;
  /** Maximum number of directories to scan. Default: 2000. */
  maxDirectories?: number;
}

export interface ScanResult {
  /** Number of SKILL.md files discovered. */
  discovered: number;
  /** Number of skills successfully loaded into the provider. */
  loaded: number;
  /** Parse/read errors encountered. */
  errors: Array<{ path: string; error: string }>;
}

/**
 * Throws if the current environment is neither Bun nor Node.js.
 * `scanDirectory` relies on the filesystem and cannot run in
 * browser, service worker, or Chrome extension contexts.
 */
function assertServerRuntime(): void {
  if (typeof globalThis.Bun === 'undefined' && typeof globalThis.process === 'undefined') {
    throw new Error(
      'scanDirectory() requires Bun or Node.js. It cannot run in browser environments.',
    );
  }
}

const IGNORED_DIRECTORIES = new Set(['node_modules', '.git']);

function shouldSkipDirectory(name: string): boolean {
  return IGNORED_DIRECTORIES.has(name) || name.startsWith('.');
}

/**
 * Collects all SKILL.md file paths within a directory tree, respecting
 * depth and directory count limits and skipping ignored directories.
 */
async function collectSkillPaths(
  directoryPath: string,
  maxDepth: number,
  maxDirectories: number,
): Promise<string[]> {
  const paths: string[] = [];
  let directoriesScanned = 0;

  async function walk(currentPath: string, depth: number): Promise<void> {
    if (depth > maxDepth || directoriesScanned >= maxDirectories) {
      return;
    }

    directoriesScanned++;

    let names: string[];
    try {
      names = await readdir(currentPath);
    } catch {
      return;
    }

    for (const name of names) {
      if (name === 'SKILL.md') {
        paths.push(join(currentPath, name));
      }
    }

    for (const name of names) {
      if (shouldSkipDirectory(name)) continue;

      const fullPath = join(currentPath, name);
      try {
        const info = await stat(fullPath);
        if (info.isDirectory()) {
          await walk(fullPath, depth + 1);
        }
      } catch {
        // Skip entries that cannot be stat'd (broken symlinks, permission errors).
      }
    }
  }

  await walk(directoryPath, 0);
  return paths;
}

/**
 * Lists non-SKILL.md files in a directory to treat as resources.
 */
async function collectResourceFiles(directoryPath: string): Promise<string[]> {
  try {
    const names = await readdir(directoryPath);
    const files: string[] = [];

    for (const name of names) {
      if (name === 'SKILL.md') continue;
      try {
        const info = await stat(join(directoryPath, name));
        if (info.isFile()) {
          files.push(name);
        }
      } catch {
        // Skip unreadable entries.
      }
    }

    return files;
  } catch {
    return [];
  }
}

/**
 * Recursively scans a directory for SKILL.md files and ingests them
 * into the skill provider. Each subdirectory containing a SKILL.md
 * becomes a skill, with all other files treated as resources.
 */
export async function scanDirectory(
  directoryPath: string,
  provider: SkillProvider,
  options?: ScanDirectoryOptions,
): Promise<ScanResult> {
  assertServerRuntime();

  const maxDepth = options?.maxDepth ?? 4;
  const maxDirectories = options?.maxDirectories ?? 2000;

  const skillPaths = await collectSkillPaths(directoryPath, maxDepth, maxDirectories);

  const result: ScanResult = {
    discovered: skillPaths.length,
    loaded: 0,
    errors: [],
  };

  for (const skillPath of skillPaths) {
    try {
      const content = await readFile(skillPath, 'utf-8');
      const parsed = parseSkillMarkdown(content);
      const skillName = parsed.metadata.name;
      const skillDirectory = dirname(skillPath);

      await provider.saveSkill(skillName, parsed);

      const resourceFiles = await collectResourceFiles(skillDirectory);
      for (const resourceFile of resourceFiles) {
        const resourcePath = join(skillDirectory, resourceFile);
        const resourceContent = await readFile(resourcePath, 'utf-8');
        await provider.saveResource(skillName, resourceFile, resourceContent);
      }

      result.loaded++;
    } catch (error) {
      const message =
        error instanceof SkillParseError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error);
      result.errors.push({ path: skillPath, error: message });
    }
  }

  return result;
}
