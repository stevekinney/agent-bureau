import { z } from 'zod';

import { createTool } from '../create-tool';
import type { Tool } from '../is-tool';
import type { RootJail } from './jail';

/** Default number of lines returned when `limit` is omitted. */
export const DEFAULT_READ_FILE_MAX_LINES = 2000;
/** Default cap, in bytes, on how much of a file is read off disk. */
export const DEFAULT_READ_FILE_MAX_BYTES = 262_144; // 256 KiB

export interface CreateReadFileToolOptions {
  /** Root jail all read paths are resolved against. */
  jail: RootJail;
  name?: string;
  description?: string;
  /** Default number of lines returned when the caller omits `limit`. */
  defaultLimit?: number;
  /** Maximum number of bytes read off disk, regardless of `limit`. */
  maxBytes?: number;
}

export type ReadFileTruncatedReason = 'byte-cap' | 'line-limit';

export interface ReadFileResult {
  path: string;
  content: string;
  /** 0-indexed line the returned window starts at. */
  startLine: number;
  /** 0-indexed line (exclusive) the returned window ends at. */
  endLine: number;
  /** Number of lines available within the (possibly byte-capped) read window. */
  totalLines: number;
  truncated: boolean;
  truncatedReason?: ReadFileTruncatedReason;
}

/**
 * Creates a read-only `read-file` tool jailed to `options.jail`'s root.
 *
 * Reads are bounded two ways: at most `maxBytes` is ever read off disk (so a
 * huge file cannot be pulled fully into memory), and the returned window is
 * further limited to `limit` lines starting at `offset`. Both caps are
 * reported via `truncated`/`truncatedReason` rather than silently dropping
 * data.
 */
export function createReadFileTool(options: CreateReadFileToolOptions): Tool {
  const {
    jail,
    name = 'read-file',
    description = 'Read a text file within the sandboxed root. Supports line offset/limit windows and enforces a byte-size cap on the underlying read.',
    defaultLimit = DEFAULT_READ_FILE_MAX_LINES,
    maxBytes = DEFAULT_READ_FILE_MAX_BYTES,
  } = options;

  return createTool({
    name,
    description,
    input: z.object({
      path: z.string().min(1).describe('Repository-relative file path to read'),
      offset: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('0-indexed line number to start reading from (default 0)'),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(`Maximum number of lines to return (default ${defaultLimit})`),
    }),
    tags: ['coding', 'filesystem', 'readonly'],
    metadata: { readOnly: true, mutates: false, dangerous: false },
    async execute({ path, offset = 0, limit }): Promise<ReadFileResult> {
      const resolvedPath = await jail.resolve(path);
      const file = Bun.file(resolvedPath);
      if (!(await file.exists())) {
        throw new Error(`File not found: ${path}`);
      }

      const truncatedByBytes = file.size > maxBytes;
      const sliceSize = Math.min(file.size, maxBytes);
      const buffer = await file.slice(0, sliceSize).arrayBuffer();
      const text = new TextDecoder('utf-8', { fatal: false }).decode(buffer);

      const lines = text.split('\n');
      const totalLines = lines.length;
      const effectiveLimit = limit ?? defaultLimit;
      const startLine = Math.min(offset, totalLines);
      const endLine = Math.min(startLine + effectiveLimit, totalLines);
      const truncatedByLimit = endLine < totalLines || (truncatedByBytes && offset > 0);
      const content = lines.slice(startLine, endLine).join('\n');

      const truncated = truncatedByBytes || truncatedByLimit;
      const result: ReadFileResult = {
        path,
        content,
        startLine,
        endLine,
        totalLines,
        truncated,
      };
      if (truncatedByBytes) {
        result.truncatedReason = 'byte-cap';
      } else if (truncatedByLimit) {
        result.truncatedReason = 'line-limit';
      }
      return result;
    },
  });
}
