import { z } from 'zod';
import type { Tool, ToolConfiguration, ToolParametersSchema } from './is-tool';
import type { ToolboxEntries } from './toolbox-contracts';
export type ImportedToolConfiguration = {
  name: string;
  description: string;
  input: ToolParametersSchema;
  namespace?: string;
  version?: string;
  title?: string;
  examples?: readonly string[];
  tags?: ToolConfiguration['tags'];
  metadata?: ToolConfiguration['metadata'];
  risk?: ToolConfiguration['risk'];
  lifecycle?: ToolConfiguration['lifecycle'];
  availability?: ToolConfiguration['availability'];
  execute?: ToolConfiguration['execute'];
  policy?: ToolConfiguration['policy'];
  policyContext?: ToolConfiguration['policyContext'];
  digests?: ToolConfiguration['digests'];
  concurrency?: ToolConfiguration['concurrency'];
  diagnostics?: ToolConfiguration['diagnostics'];
};
export type EntryToTool<TEntry> = TEntry extends Tool ? TEntry : Tool;
export type ToolsFromEntries<TEntries extends ToolboxEntries> = ReadonlyArray<
  EntryToTool<TEntries[number]>
>;
export type MergeTools<
  TLeft extends readonly Tool[],
  TRight extends readonly Tool[],
> = ReadonlyArray<TLeft[number] | TRight[number]>;
type ToolboxToolName<TTools extends readonly Tool[]> = TTools[number]['name'] & string;
type ToolboxToolInput<TTool extends Tool> =
  TTool extends Tool<infer TSchema, any, any, any> ? z.infer<TSchema> : unknown;
type ToolboxToolOutput<TTool extends Tool> =
  TTool extends Tool<any, any, infer TOutput, any> ? TOutput : unknown;
type ToolboxToolByNameOrFallback<TTools extends readonly Tool[], Name extends string> =
  Extract<TTools[number], { name: Name }> extends never
    ? TTools[number]
    : Extract<TTools[number], { name: Name }>;
export type ToolboxCallInputForTools<TTools extends readonly Tool[]> = {
  [Name in ToolboxToolName<TTools>]: {
    id?: string;
    name: Name;
    arguments?: ToolboxToolInput<ToolboxToolByNameOrFallback<TTools, Name>>;
  };
}[ToolboxToolName<TTools>];
export type ToolboxResultForTool<TTool extends Tool> = Omit<
  import('./types').ToolExecutionResult,
  'toolName' | 'result'
> & { toolName: TTool['name']; result: ToolboxToolOutput<TTool> | undefined };
export type ToolboxResultForCall<TTools extends readonly Tool[], TCall extends { name: string }> =
  TCall['name'] extends ToolboxToolName<TTools>
    ? ToolboxResultForTool<ToolboxToolByNameOrFallback<TTools, TCall['name']>>
    : import('./types').ToolExecutionResult;
export type AvailableTools<TTools extends readonly Tool[]> = ReadonlyArray<TTools[number]>;
