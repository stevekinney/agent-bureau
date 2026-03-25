import type { Toolbox, ToolExecutionResult } from 'armorer';
import type { ToolCall } from 'interoperability';
import type { HookMap } from 'lifecycle';

import type {
  GenerateResponse,
  StepContext,
  StepResult,
  ToolExecutionHookContext,
  ToolExecutionResultContext,
} from './types';

export interface OperativeHookMap extends HookMap {
  prepareStep: (context: StepContext) => Promise<void | GenerateResponse>;
  beforeToolExecution: (context: ToolExecutionHookContext) => Promise<ToolCall[]>;
  afterToolExecution: (context: ToolExecutionResultContext) => Promise<void>;
  onStep: (result: StepResult) => Promise<void>;
  selectTools: (context: StepContext) => Promise<Toolbox>;
  validateResponse: (
    response: GenerateResponse,
    context: StepContext,
  ) => Promise<GenerateResponse | void>;
  validateToolResult: (
    result: ToolExecutionResult,
    context: ToolExecutionResultContext,
  ) => Promise<ToolExecutionResult | void>;
}
