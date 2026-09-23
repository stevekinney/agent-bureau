import type { RuntimeServices } from '@lostgradient/lifecycle';
import type {
  Context as OpenTelemetryContext,
  Link as OpenTelemetryLink,
} from '@opentelemetry/api';
import type { ToolError, ToolErrorCategory } from './core/errors';
import type { LoopDetector } from './core/loop-detection';
import type { Tool, ToolConfiguration } from './is-tool';
import { resolveFuzzyToolName } from './resolution/index';
import { checkBudget } from './toolbox-budget';
import type { ToolboxEventType, ToolboxEvents, ToolboxOptions } from './toolbox-contracts';
import type { ToolCall, ToolExecutionResult } from './types';

type Emit = <K extends ToolboxEventType>(type: K, detail: ToolboxEvents[K]) => boolean;

export type ExecutionAdmissionContext = {
  readonly toolCall: ToolCall;
  readonly toolsByName: Map<string, Tool[]>;
  readonly getTool: (name: string) => Tool | undefined;
  readonly resolutionEnabled: boolean;
  readonly emit: Emit;
  readonly isToolAvailable: (
    tool: Tool,
    signal: AbortSignal,
  ) => Promise<boolean | 'timeout' | 'cancelled'>;
  readonly signal: AbortSignal;
  readonly deadlineAborted: () => boolean;
  readonly parentContext: OpenTelemetryContext | undefined;
  readonly spanLinks: OpenTelemetryLink[] | undefined;
  readonly storedConfigurations: Map<string, ToolConfiguration>;
  readonly onDeprecatedToolCalled: ToolboxOptions['onDeprecatedToolCalled'];
  readonly loopDetectors: Map<string, LoopDetector>;
  readonly autoLoopDetector: LoopDetector | undefined;
  readonly budget: ToolboxOptions['budget'];
  readonly budgetStart: number;
  readonly budgetCalls: { value: number };
  readonly runtime: RuntimeServices;
  readonly errorMode: 'failFast' | 'collect';
  readonly policyAuthorizationOnly: boolean;
  readonly createToolError: (
    category: ToolErrorCategory,
    message: string,
    code: string,
    retryable: boolean,
  ) => ToolError;
  readonly createBudgetError: (message: string) => ToolError;
};

export type AdmittedToolCall = { tool: Tool; toolCall: ToolCall };
export type AdmissionResult = AdmittedToolCall | ToolExecutionResult;

export function createDeadlineResult(
  toolCall: ToolCall,
  createToolError: ExecutionAdmissionContext['createToolError'],
): ToolExecutionResult {
  const error = createToolError('timeout', 'Execution deadline exceeded', 'TIMEOUT', false);
  return failedResult(toolCall, error);
}

export async function admitToolCall(context: ExecutionAdmissionContext): Promise<AdmissionResult> {
  const resolved = resolveTool(context);
  if (!resolved) return notFoundResult(context);
  const availability = await checkAvailability(context, resolved);
  if (availability) return availability;
  emitCall(context, resolved);
  return applyAdmissionPolicies(context, resolved);
}

function resolveTool(context: ExecutionAdmissionContext): AdmittedToolCall | undefined {
  const { toolCall, getTool, resolutionEnabled, toolsByName, emit } = context;
  const tool = getTool(toolCall.name);
  if (tool || !resolutionEnabled) return tool ? { tool, toolCall } : undefined;
  const result = resolveFuzzyToolName(toolCall.name, [...toolsByName.keys()]);
  if (!result.resolved) return undefined;
  const resolved = getTool(result.resolved);
  if (!resolved) return undefined;
  emit('name-resolved', {
    originalName: toolCall.name,
    resolvedName: result.resolved,
    tier: result.tier,
  });
  return { tool: resolved, toolCall: { ...toolCall, name: result.resolved } };
}

function notFoundResult(context: ExecutionAdmissionContext): ToolExecutionResult {
  const { toolCall } = context;
  const error = context.createToolError(
    'not_found',
    `Tool not found: ${toolCall.name}`,
    'NOT_FOUND',
    false,
  );
  const result = failedResult(toolCall, error);
  context.emit('not-found', toolCall);
  if (context.errorMode === 'failFast') throw error;
  return result;
}

async function checkAvailability(
  context: ExecutionAdmissionContext,
  admitted: AdmittedToolCall,
): Promise<ToolExecutionResult | undefined> {
  const availability = await context.isToolAvailable(admitted.tool, context.signal);
  if (availability === true) return undefined;
  const timedOut = availability === 'timeout' || context.deadlineAborted();
  const error = context.createToolError(
    timedOut ? 'timeout' : 'cancelled',
    timedOut ? 'Execution deadline exceeded' : 'Cancelled',
    timedOut ? 'TIMEOUT' : 'CANCELLED',
    false,
  );
  if (availability === false) {
    const unavailable = failedResult(
      admitted.toolCall,
      context.createToolError(
        'unavailable',
        `Tool unavailable: ${admitted.toolCall.name}`,
        'TOOL_UNAVAILABLE',
        false,
      ),
    );
    context.emit('error', { tool: admitted.tool, result: unavailable });
    if (context.errorMode === 'failFast') throw unavailable.error;
    return unavailable;
  }
  return failedResult(admitted.toolCall, error);
}

function emitCall(context: ExecutionAdmissionContext, admitted: AdmittedToolCall): void {
  context.emit('call', {
    tool: admitted.tool,
    call: admitted.toolCall,
    ...(context.parentContext ? { parentContext: context.parentContext } : {}),
    ...(context.spanLinks ? { spanLinks: context.spanLinks } : {}),
  });
  const configuration = context.storedConfigurations.get(admitted.tool.id);
  if (configuration?.lifecycle?.deprecated && context.onDeprecatedToolCalled) {
    context.onDeprecatedToolCalled(configuration, {
      name: admitted.toolCall.name,
      id: admitted.toolCall.id,
    });
  }
}

function applyAdmissionPolicies(
  context: ExecutionAdmissionContext,
  admitted: AdmittedToolCall,
): AdmissionResult {
  if (context.policyAuthorizationOnly) return admitted;
  for (const detector of context.loopDetectors.values()) {
    detector.recordCall(admitted.toolCall.name, admitted.toolCall.arguments ?? {});
  }
  const budgetReason = checkBudget(
    context.budget,
    context.budgetStart,
    context.budgetCalls.value,
    context.runtime.clock.now(),
  );
  if (budgetReason) return budgetResult(context, admitted, budgetReason);
  context.budgetCalls.value += 1;
  return loopResult(context, admitted);
}

function budgetResult(
  context: ExecutionAdmissionContext,
  admitted: AdmittedToolCall,
  reason: string,
): ToolExecutionResult {
  const error = context.createBudgetError(reason);
  const result = failedResult(admitted.toolCall, error);
  context.emit('budget-exceeded', { tool: admitted.tool, call: admitted.toolCall, reason });
  context.emit('error', { tool: admitted.tool, result });
  if (context.errorMode === 'failFast') throw error;
  return result;
}

function loopResult(
  context: ExecutionAdmissionContext,
  admitted: AdmittedToolCall,
): AdmissionResult {
  const detector = context.autoLoopDetector;
  if (!detector) return admitted;
  detector.recordCall(admitted.toolCall.name, admitted.toolCall.arguments ?? {});
  const result = detector.detectLoop();
  if (!result.detected) return admitted;
  const detail = {
    tool: admitted.tool,
    call: admitted.toolCall,
    detector: result.detector ?? 'simple-repeat',
    count: result.count,
    message: result.message,
  };
  context.emit(result.level === 'blocked' ? 'loop-blocked' : 'loop-warning', detail);
  if (result.level !== 'blocked') return admitted;
  const error = context.createToolError('conflict', result.message, 'LOOP_BLOCKED', false);
  const blocked = failedResult(admitted.toolCall, error);
  context.emit('error', { tool: admitted.tool, result: blocked });
  return blocked;
}

function failedResult(toolCall: ToolCall, error: ToolError): ToolExecutionResult {
  return {
    callId: toolCall.id,
    outcome: 'error',
    content: error.message,
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    result: undefined,
    error,
    errorMessage: error.message,
    errorCategory: error.category,
  };
}
