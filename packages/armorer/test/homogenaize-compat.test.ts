import type {
  DefineToolOptions as HomogenaizeToolConfiguration,
  Tool as HomogenaizeTool,
  ToolCall as HomogenaizeToolCall,
  ToolResult as HomogenaizeToolResult,
} from '@lasercat/homogenaize';
import { describe, expect, it } from 'bun:test';
import type { ZodSchema } from 'zod';

import type { Tool, ToolConfiguration } from '../src/is-tool';
import type { ToolCall, ToolResult } from '../src/types';

type Assert<T extends true> = T;
type IsAssignable<From, To> = [From] extends [To] ? true : false;

type _ToolCallCompat = Assert<IsAssignable<ToolCall, HomogenaizeToolCall>>;
type _ToolCallCompatReverse = Assert<IsAssignable<HomogenaizeToolCall, ToolCall>>;
type _ToolResultCompat = Assert<IsAssignable<ToolResult, HomogenaizeToolResult>>;
type _ToolCompat = Assert<IsAssignable<Tool, HomogenaizeTool>>;
type _ToolConfigurationCompat = Assert<
  IsAssignable<ToolConfiguration, HomogenaizeToolConfiguration<ZodSchema>>
>;

describe('homogenaize compatibility', () => {
  it('keeps shared tool shapes assignable', () => {
    expect(true).toBe(true);
  });
});
