import type { Tool } from '../is-tool';
import {
  createGlobTool,
  type CreateGlobToolOptions,
  DEFAULT_GLOB_MAX_RESULTS,
  type GlobResult,
} from './glob';
import {
  createGrepTool,
  type CreateGrepToolOptions,
  DEFAULT_GREP_MAX_FILE_BYTES,
  DEFAULT_GREP_MAX_MATCHES,
  type GrepMatch,
  type GrepResult,
} from './grep';
import { createRootJail, isPathTraversalError, PathTraversalError, type RootJail } from './jail';
import {
  createReadFileTool,
  type CreateReadFileToolOptions,
  DEFAULT_READ_FILE_MAX_BYTES,
  DEFAULT_READ_FILE_MAX_LINES,
  type ReadFileResult,
  type ReadFileTruncatedReason,
} from './read-file';

export {
  createGlobTool,
  createGrepTool,
  createReadFileTool,
  createRootJail,
  DEFAULT_GLOB_MAX_RESULTS,
  DEFAULT_GREP_MAX_FILE_BYTES,
  DEFAULT_GREP_MAX_MATCHES,
  DEFAULT_READ_FILE_MAX_BYTES,
  DEFAULT_READ_FILE_MAX_LINES,
  isPathTraversalError,
  PathTraversalError,
};
export type {
  CreateGlobToolOptions,
  CreateGrepToolOptions,
  CreateReadFileToolOptions,
  GlobResult,
  GrepMatch,
  GrepResult,
  ReadFileResult,
  ReadFileTruncatedReason,
  RootJail,
};

export interface CreateCodingToolsOptions {
  /** Directory all coding tools are jailed to. Must exist. */
  root: string;
  readFile?: Omit<CreateReadFileToolOptions, 'jail'>;
  grep?: Omit<CreateGrepToolOptions, 'jail'>;
  glob?: Omit<CreateGlobToolOptions, 'jail'>;
}

export interface CodingTools {
  jail: RootJail;
  readFile: Tool;
  grep: Tool;
  glob: Tool;
}

/**
 * Creates the first-party read-only coding toolbox: `read-file`, `grep`,
 * and `glob`, all jailed to `options.root`.
 *
 * This is a read-only surface by design — no write, edit, or shell tools
 * are provided here. Those are gated on the AB-42 sandbox decision.
 *
 * @example
 * ```typescript
 * import { createCodingTools } from 'armorer/coding';
 * import { createToolbox } from 'armorer';
 *
 * const { readFile, grep, glob } = createCodingTools({ root: process.cwd() });
 * const toolbox = createToolbox([readFile, grep, glob]);
 * ```
 */
export function createCodingTools(options: CreateCodingToolsOptions): CodingTools {
  const jail = createRootJail(options.root);
  return {
    jail,
    readFile: createReadFileTool({ jail, ...options.readFile }),
    grep: createGrepTool({ jail, ...options.grep }),
    glob: createGlobTool({ jail, ...options.glob }),
  };
}

/**
 * Convenience helper returning the coding tools as an array ready to pass
 * directly to `createToolbox`.
 */
export function createCodingToolbox(options: CreateCodingToolsOptions): Tool[] {
  const tools = createCodingTools(options);
  return [tools.readFile, tools.grep, tools.glob];
}
