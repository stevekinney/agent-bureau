import type { Context, Span, SpanOptions, Tracer } from '@opentelemetry/api';
import { SpanStatusCode } from '@opentelemetry/api';
import { createTool } from 'armorer';
import { createTestToolbox } from 'armorer/test';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { z } from 'zod';

import { noToolCalls } from '../src/conditions/predicates.ts';
import { createActiveRun } from '../src/create-run.ts';
import { AbortAgentRunError } from '../src/errors.ts';
import { instrument } from '../src/instrumentation/index.ts';
import type { GenerateResponse, TokenUsage } from '../src/types.ts';

// ---------------------------------------------------------------------------
// Mock OpenTelemetry tracer
// ---------------------------------------------------------------------------

function createMockSpan(name: string): Span & {
  name: string;
  attributes: Record<string, unknown>;
  status: { code: number; message?: string };
  events: Array<{ name: string; attributes?: Record<string, unknown> }>;
  ended: boolean;
  exceptions: unknown[];
  parentContext: Context | undefined;
} {
  const span: any = {
    name,
    attributes: {} as Record<string, unknown>,
    status: { code: SpanStatusCode.UNSET },
    events: [] as Array<{ name: string; attributes?: Record<string, unknown> }>,
    ended: false,
    exceptions: [] as unknown[],
    parentContext: undefined as Context | undefined,
    setAttribute(key: string, value: unknown) {
      span.attributes[key] = value;
      return span;
    },
    setAttributes(attrs: Record<string, unknown>) {
      Object.assign(span.attributes, attrs);
      return span;
    },
    setStatus(s: { code: number; message?: string }) {
      span.status = s;
      return span;
    },
    addEvent(eventName: string, attrs?: Record<string, unknown>) {
      span.events.push({ name: eventName, attributes: attrs });
      return span;
    },
    recordException(error: unknown) {
      span.exceptions.push(error);
    },
    end() {
      span.ended = true;
    },
    isRecording() {
      return !span.ended;
    },
    spanContext() {
      return { traceId: 'test-trace', spanId: `span-${name}`, traceFlags: 1 };
    },
    updateName() {
      return span;
    },
  };
  return span;
}

function createMockTracer(): Tracer & {
  spans: Array<ReturnType<typeof createMockSpan>>;
} {
  const spans: Array<ReturnType<typeof createMockSpan>> = [];
  const tracer: any = {
    spans,
    startSpan(name: string, options?: SpanOptions, parentContext?: Context) {
      const span = createMockSpan(name);
      span.parentContext = parentContext;
      if (options?.attributes) {
        Object.assign(span.attributes, options.attributes);
      }
      spans.push(span);
      return span;
    },
    startActiveSpan: (() => {}) as any,
  };
  return tracer;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const weatherTool = createTool({
  name: 'get_weather',
  description: 'Get weather for a location',
  input: z.object({ location: z.string() }),
  execute: async ({ location }) => ({ temperature: 72, location }),
});

function textResponse(content: string, usage?: TokenUsage): GenerateResponse {
  return { content, toolCalls: [], usage };
}

function toolCallResponse(
  toolCalls: GenerateResponse['toolCalls'],
  content = '',
  usage?: TokenUsage,
): GenerateResponse {
  return { content, toolCalls, usage };
}

function weatherToolCall(location = 'Denver') {
  return { name: 'get_weather', arguments: { location } };
}

function findSpan(tracer: ReturnType<typeof createMockTracer>, name: string) {
  return tracer.spans.find((s) => s.name === name);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('instrument', () => {
  it('creates a run span on run.started', async () => {
    const tracer = createMockTracer();
    const toolbox = createTestToolbox([]);

    const activeRun = createActiveRun({
      generate: async () => textResponse('Hello'),
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    const unsubscribe = instrument(activeRun, { tracer });
    await activeRun.result;
    activeRun.complete();
    unsubscribe();

    const runSpan = findSpan(tracer, 'invoke_agent');
    expect(runSpan).toBeDefined();
    expect(runSpan?.attributes['gen_ai.operation.name']).toBe('invoke_agent');
  });

  it('names the run span with the agent name and sets gen_ai.agent.name when provided', async () => {
    const tracer = createMockTracer();
    const toolbox = createTestToolbox([]);

    const activeRun = createActiveRun({
      generate: async () => textResponse('Hello'),
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    const unsubscribe = instrument(activeRun, { tracer, agentName: 'Math Tutor' });
    await activeRun.result;
    activeRun.complete();
    unsubscribe();

    const runSpan = findSpan(tracer, 'invoke_agent Math Tutor');
    expect(runSpan).toBeDefined();
    expect(runSpan?.attributes['gen_ai.agent.name']).toBe('Math Tutor');
    expect(findSpan(tracer, 'invoke_agent')).toBeUndefined();
  });

  it('treats an empty or whitespace-only agentName as unset for both the span name and attribute', async () => {
    const tracer = createMockTracer();
    const toolbox = createTestToolbox([]);

    const activeRun = createActiveRun({
      generate: async () => textResponse('Hello'),
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    const unsubscribe = instrument(activeRun, { tracer, agentName: '   ' });
    await activeRun.result;
    activeRun.complete();
    unsubscribe();

    const runSpan = findSpan(tracer, 'invoke_agent')!;
    expect(runSpan).toBeDefined();
    expect('gen_ai.agent.name' in runSpan.attributes).toBe(false);
  });

  it('ends the run span on run.completed with finish reason and usage', async () => {
    const tracer = createMockTracer();
    const toolbox = createTestToolbox([]);

    const activeRun = createActiveRun({
      generate: async () => textResponse('Done', { prompt: 10, completion: 20, total: 30 }),
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    const unsubscribe = instrument(activeRun, { tracer });
    await activeRun.result;
    activeRun.complete();
    unsubscribe();

    const runSpan = findSpan(tracer, 'invoke_agent')!;
    expect(runSpan.ended).toBe(true);
    expect(runSpan.attributes['operative.finish_reason']).toBe('stop-condition');
    expect('gen_ai.response.finish_reasons' in runSpan.attributes).toBe(false);
    expect(runSpan.attributes['operative.total_steps']).toBe(1);
    expect(runSpan.attributes['gen_ai.usage.input_tokens']).toBe(10);
    expect(runSpan.attributes['gen_ai.usage.output_tokens']).toBe(20);
  });

  it('reports cache token usage on the run span when present', async () => {
    const tracer = createMockTracer();
    const toolbox = createTestToolbox([]);

    const activeRun = createActiveRun({
      generate: async () =>
        textResponse('Done', {
          prompt: 10,
          completion: 20,
          total: 30,
          cacheCreationTokens: 4,
          cacheReadTokens: 6,
        }),
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    const unsubscribe = instrument(activeRun, { tracer });
    await activeRun.result;
    activeRun.complete();
    unsubscribe();

    const runSpan = findSpan(tracer, 'invoke_agent')!;
    expect(runSpan.attributes['gen_ai.usage.cache_creation.input_tokens']).toBe(4);
    expect(runSpan.attributes['gen_ai.usage.cache_read.input_tokens']).toBe(6);
  });

  it('creates a step span as a child of the run span', async () => {
    const tracer = createMockTracer();
    const toolbox = createTestToolbox([]);

    const activeRun = createActiveRun({
      generate: async () => textResponse('Hello'),
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    const unsubscribe = instrument(activeRun, { tracer });
    await activeRun.result;
    activeRun.complete();
    unsubscribe();

    const runSpan = findSpan(tracer, 'invoke_agent')!;
    const stepSpan = findSpan(tracer, 'step')!;
    expect(stepSpan).toBeDefined();
    // The step span's parentContext should contain the run span
    expect(stepSpan.parentContext).toBeDefined();
  });

  it('creates a generate span as a child of the step span', async () => {
    const tracer = createMockTracer();
    const toolbox = createTestToolbox([]);

    const activeRun = createActiveRun({
      generate: async () => textResponse('Hello'),
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    const unsubscribe = instrument(activeRun, { tracer });
    await activeRun.result;
    activeRun.complete();
    unsubscribe();

    const generateSpan = findSpan(tracer, 'generate')!;
    expect(generateSpan).toBeDefined();
    expect(generateSpan.parentContext).toBeDefined();
  });

  it('ends the generate span on step.generated for text-only steps with usage', async () => {
    const tracer = createMockTracer();
    const toolbox = createTestToolbox([]);

    const activeRun = createActiveRun({
      generate: async () => textResponse('Hello', { prompt: 5, completion: 10, total: 15 }),
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    const unsubscribe = instrument(activeRun, { tracer });
    await activeRun.result;
    activeRun.complete();
    unsubscribe();

    const generateSpan = findSpan(tracer, 'generate')!;
    expect(generateSpan.ended).toBe(true);
    expect(generateSpan.attributes['operative.usage.prompt_tokens']).toBe(5);
    expect(generateSpan.attributes['operative.usage.completion_tokens']).toBe(10);
    expect(generateSpan.attributes['operative.usage.total_tokens']).toBe(15);
  });

  it('ends the generate span on tools.executing for tool steps', async () => {
    const tracer = createMockTracer();
    const toolbox = createTestToolbox([weatherTool]);

    const activeRun = createActiveRun({
      generate: async (context) => {
        if (context.step === 0) {
          return toolCallResponse([weatherToolCall()]);
        }
        return textResponse('Done');
      },
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    const unsubscribe = instrument(activeRun, { tracer });
    await activeRun.result;
    activeRun.complete();
    unsubscribe();

    // The first generate span (step 0) should be ended before tools.executed
    // We can verify by checking that the generate span is ended and a tools span exists
    const generateSpans = tracer.spans.filter((s) => s.name === 'generate');
    expect(generateSpans.length).toBeGreaterThanOrEqual(1);

    // First generate span (from step 0 with tools) should be ended
    expect(generateSpans[0].ended).toBe(true);

    // A tools span should exist
    const toolsSpan = findSpan(tracer, 'tool_calls');
    expect(toolsSpan).toBeDefined();
  });

  it('creates a tools span on tools.executing', async () => {
    const tracer = createMockTracer();
    const toolbox = createTestToolbox([weatherTool]);

    const activeRun = createActiveRun({
      generate: async (context) => {
        if (context.step === 0) {
          return toolCallResponse([weatherToolCall()]);
        }
        return textResponse('Done');
      },
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    const unsubscribe = instrument(activeRun, { tracer });
    await activeRun.result;
    activeRun.complete();
    unsubscribe();

    const toolsSpan = findSpan(tracer, 'tool_calls')!;
    expect(toolsSpan).toBeDefined();
    expect(toolsSpan.attributes['operative.tools.count']).toBe(1);
    expect(toolsSpan.attributes['operative.tools.names']).toBe('get_weather');
  });

  it('ends the tools span on tools.executed', async () => {
    const tracer = createMockTracer();
    const toolbox = createTestToolbox([weatherTool]);

    const activeRun = createActiveRun({
      generate: async (context) => {
        if (context.step === 0) {
          return toolCallResponse([weatherToolCall()]);
        }
        return textResponse('Done');
      },
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    const unsubscribe = instrument(activeRun, { tracer });
    await activeRun.result;
    activeRun.complete();
    unsubscribe();

    const toolsSpan = findSpan(tracer, 'tool_calls')!;
    expect(toolsSpan.ended).toBe(true);
    expect(toolsSpan.attributes['operative.tools.results_count']).toBe(1);
  });

  it('ends the step span on step.completed', async () => {
    const tracer = createMockTracer();
    const toolbox = createTestToolbox([]);

    const activeRun = createActiveRun({
      generate: async () => textResponse('Hello'),
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    const unsubscribe = instrument(activeRun, { tracer });
    await activeRun.result;
    activeRun.complete();
    unsubscribe();

    const stepSpan = findSpan(tracer, 'step')!;
    expect(stepSpan.ended).toBe(true);
  });

  it('produces correct span tree for a multi-step run', async () => {
    const tracer = createMockTracer();
    const toolbox = createTestToolbox([weatherTool]);

    const activeRun = createActiveRun({
      generate: async (context) => {
        if (context.step === 0) {
          return toolCallResponse([weatherToolCall()]);
        }
        return textResponse('The weather is nice.');
      },
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    const unsubscribe = instrument(activeRun, { tracer });
    await activeRun.result;
    activeRun.complete();
    unsubscribe();

    // Expected spans: run, step.0, generate (step 0), tools, step.1, generate (step 1) = 6
    expect(tracer.spans).toHaveLength(6);

    const spanNames = tracer.spans.map((s) => s.name);
    expect(spanNames).toContain('invoke_agent');
    expect(spanNames).toContain('tool_calls');

    // The step span name is intentionally stable (not `step {n}`) to avoid
    // unbounded cardinality; the step index is carried on the attribute
    // instead, so both steps should be distinguishable there.
    const stepSpans = tracer.spans.filter((s) => s.name === 'step');
    expect(stepSpans).toHaveLength(2);
    expect(stepSpans.map((s) => s.attributes['operative.step.index'])).toEqual([0, 1]);

    const generateSpans = tracer.spans.filter((s) => s.name === 'generate');
    expect(generateSpans).toHaveLength(2);

    // All spans should be ended
    for (const span of tracer.spans) {
      expect(span.ended).toBe(true);
    }
  });

  it('sets ERROR status on run span and sweeps open spans when generate throws', async () => {
    const tracer = createMockTracer();
    const toolbox = createTestToolbox([]);

    const activeRun = createActiveRun({
      generate: async () => {
        throw new Error('LLM service unavailable');
      },
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    const unsubscribe = instrument(activeRun, { tracer });
    await activeRun.result;
    activeRun.complete();
    unsubscribe();

    const runSpan = findSpan(tracer, 'invoke_agent')!;
    expect(runSpan).toBeDefined();
    expect(runSpan.status.code).toBe(SpanStatusCode.ERROR);
    expect(runSpan.status.message).toBe('LLM service unavailable');
    expect(runSpan.attributes['error.type']).toBe('Error');
    expect(runSpan.attributes['operative.error.kind']).toBe('generate');
    expect(runSpan.attributes['operative.error.code']).toBe('UNKNOWN');
    expect(runSpan.exceptions).toHaveLength(1);
    expect(runSpan.ended).toBe(true);

    // All open spans should be swept (ended)
    for (const span of tracer.spans) {
      expect(span.ended).toBe(true);
    }
  });

  it('sets abort reason on run span and sweeps open spans when aborted', async () => {
    const tracer = createMockTracer();
    const toolbox = createTestToolbox([]);
    const generateStarted = Promise.withResolvers<void>();
    const generateCanFinish = Promise.withResolvers<void>();

    const activeRun = createActiveRun({
      generate: async () => {
        generateStarted.resolve();
        await generateCanFinish.promise;
        return textResponse('Should not finish');
      },
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      maximumSteps: 10,
    });

    const unsubscribe = instrument(activeRun, { tracer });
    await generateStarted.promise;
    activeRun.abort('user cancelled');
    generateCanFinish.resolve();
    await activeRun.result;
    activeRun.complete();
    unsubscribe();

    const runSpan = findSpan(tracer, 'invoke_agent')!;
    expect(runSpan).toBeDefined();
    expect(runSpan.attributes['operative.abort_reason']).toBe('user cancelled');
    expect(runSpan.attributes['operative.error.kind']).toBe('abort');
    expect(runSpan.attributes['operative.error.code']).toBe('ABORTED');
    expect(runSpan.attributes['error.type']).toBe('AbortAgentRunError');
    expect(runSpan.status.code).toBe(SpanStatusCode.ERROR);
    expect(runSpan.status.message).toBe('user cancelled');
    expect(runSpan.exceptions).toHaveLength(1);
    expect(runSpan.exceptions[0]).toBeInstanceOf(AbortAgentRunError);
    expect(runSpan.ended).toBe(true);

    // All spans should be ended
    for (const span of tracer.spans) {
      expect(span.ended).toBe(true);
    }
  });

  it('sweeps open tool spans when toolbox.execute throws', async () => {
    const tracer = createMockTracer();

    // Create a tool whose execution throws a raw error that the toolbox propagates
    const crashTool = createTool({
      name: 'crash_tool',
      description: 'A tool that crashes',
      input: z.object({}),
      execute: async () => {
        throw new Error('toolbox crash');
      },
    });

    const toolbox = createTestToolbox([crashTool]);

    // Override execute to throw instead of returning an error result
    const originalExecute = toolbox.execute.bind(toolbox);
    (toolbox as any).execute = async (...args: any[]) => {
      // Call the original, but if the tool errors, rethrow as an unhandled error
      throw new Error('toolbox-level crash');
    };

    const activeRun = createActiveRun({
      generate: async (context) => {
        if (context.step === 0) {
          return toolCallResponse([{ name: 'crash_tool', arguments: {} }]);
        }
        return textResponse('Done');
      },
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      maximumSteps: 10,
    });

    const unsubscribe = instrument(activeRun, { tracer });
    await activeRun.result;
    activeRun.complete();
    unsubscribe();

    // The tools span should have been created by tools.executing
    // and ended by endAllOpenSpans (called from run.error handler)
    const toolsSpan = findSpan(tracer, 'tool_calls');
    expect(toolsSpan).toBeDefined();
    expect(toolsSpan!.ended).toBe(true);

    // All spans should be ended
    for (const span of tracer.spans) {
      expect(span.ended).toBe(true);
    }
  });

  it('adds a retry event to the generate span', async () => {
    const tracer = createMockTracer();
    const toolbox = createTestToolbox([]);
    let callCount = 0;

    const activeRun = createActiveRun({
      generate: async () => {
        callCount++;
        if (callCount === 1) throw new Error('transient');
        return textResponse('Recovered');
      },
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      retry: { attempts: 3 },
    });

    const unsubscribe = instrument(activeRun, { tracer });
    await activeRun.result;
    activeRun.complete();
    unsubscribe();

    const generateSpan = findSpan(tracer, 'generate')!;
    expect(generateSpan).toBeDefined();
    const retryEvents = generateSpan.events.filter((e) => e.name === 'generate.retry');
    expect(retryEvents).toHaveLength(1);
    expect(retryEvents[0].attributes?.['retry.attempt']).toBe(1);
  });

  it('stops span creation after unsubscribe is called', async () => {
    const tracer = createMockTracer();
    const toolbox = createTestToolbox([]);

    const activeRun = createActiveRun({
      generate: async () => textResponse('Hello'),
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    const unsubscribe = instrument(activeRun, { tracer });
    // Immediately unsubscribe before the loop executes (loop is deferred via microtask)
    unsubscribe();

    await activeRun.result;
    activeRun.complete();

    // No spans should have been created (unsubscribe was called before any events fired)
    expect(tracer.spans).toHaveLength(0);
  });

  it('endAllOpenSpans sweeps a generate span still in progress on unsubscribe', async () => {
    const tracer = createMockTracer();
    const toolbox = createTestToolbox([]);
    let resolveGenerate!: (value: GenerateResponse) => void;
    const generateStarted = Promise.withResolvers<void>();

    const activeRun = createActiveRun({
      generate: async () => {
        generateStarted.resolve();
        return new Promise<GenerateResponse>((resolve) => {
          resolveGenerate = resolve;
        });
      },
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    const unsubscribe = instrument(activeRun, { tracer });

    // Wait until generate.started has fired and the span is in the map
    await generateStarted.promise;
    await Promise.resolve();

    // Unsubscribe while the generate span is still open
    unsubscribe();

    const generateSpan = findSpan(tracer, 'generate')!;
    expect(generateSpan).toBeDefined();
    expect(generateSpan.ended).toBe(true);

    // Let generate complete so the run finishes cleanly
    resolveGenerate(textResponse('Hello'));
    await activeRun.result;
    activeRun.complete();
  });

  it('does not throw when called without a tracer option', async () => {
    const toolbox = createTestToolbox([]);

    const activeRun = createActiveRun({
      generate: async () => textResponse('Hello'),
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    // Should not throw even without a tracer
    const unsubscribe = instrument(activeRun);
    await activeRun.result;
    activeRun.complete();
    unsubscribe();
  });
});

// AB-230 attribute-classification table.
//
// Every `span.setAttribute`/`span.setAttributes`/`span.addEvent(name, attrs)`
// call site in `packages/operative/src/instrumentation/index.ts`, plus the
// one span-attribute call elsewhere in the package's `src/` that is not
// under an `instrumentation/` directory
// (`durable/run-workflow.ts:970`, a Weft durable-workflow context — not an
// OTel span). None of operative's own instrumentation attributes carry tool
// arguments, tool results, provider request/response content, or
// conversation content: the module observes loop-level structure (step
// index, tool-call counts and names, usage, finish reason, error category)
// and never touches a `GenerateResponse.content`, a tool call's
// `arguments`, or a tool result. `packages/operative/src/providers/instrumentation/index.ts`
// is a separate emission site and has its own table in
// `provider-instrumentation.test.ts`.
type AttributeClassificationRow = {
  callSite: string;
  attributeKey: string;
  sourceValue: string;
  privileged: boolean;
  treatment: 'emitted' | 'omitted';
};

const OPERATIVE_ATTRIBUTE_CLASSIFICATION_TABLE: AttributeClassificationRow[] = [
  {
    callSite: "'run.started' listener → tracer.startSpan(..., { attributes })",
    attributeKey: 'gen_ai.operation.name',
    sourceValue: "literal 'invoke_agent'",
    privileged: false,
    treatment: 'emitted',
  },
  {
    callSite: "'run.started' listener → tracer.startSpan(..., { attributes })",
    attributeKey: 'gen_ai.agent.name',
    sourceValue: 'options.agentName (configured identity, not conversation content)',
    privileged: false,
    treatment: 'emitted',
  },
  {
    callSite: "'step.started' listener → tracer.startSpan(..., { attributes })",
    attributeKey: 'operative.step.index',
    sourceValue: 'step (a counter)',
    privileged: false,
    treatment: 'emitted',
  },
  {
    callSite: 'setUsageAttributes() → span.setAttributes(...)',
    attributeKey:
      'gen_ai.usage.input_tokens / output_tokens / cache_creation.input_tokens / cache_read.input_tokens',
    sourceValue: 'usage.* (token counts)',
    privileged: false,
    treatment: 'emitted',
  },
  {
    callSite: "'generate.completed' listener → generateSpan.setAttributes(...)",
    attributeKey: 'operative.usage.prompt_tokens / completion_tokens / total_tokens',
    sourceValue: 'response.usage.* (token counts)',
    privileged: false,
    treatment: 'emitted',
  },
  {
    callSite: "'generate.completed' listener → generateSpan.setAttribute(...)",
    attributeKey: 'operative.generate.duration_ms',
    sourceValue: 'durationMilliseconds (timing)',
    privileged: false,
    treatment: 'emitted',
  },
  {
    callSite: "'generate.error' listener → generateSpan.setAttribute(...)",
    attributeKey: 'error.type',
    sourceValue: "error.name ?? '_OTHER' (a category name, not error content)",
    privileged: false,
    treatment: 'emitted',
  },
  {
    callSite: "'generate.error' listener → generateSpan.setAttribute(...)",
    attributeKey: 'operative.generate.duration_ms',
    sourceValue: 'durationMilliseconds (timing)',
    privileged: false,
    treatment: 'emitted',
  },
  {
    callSite: "'tools.executing' listener → tracer.startSpan(..., { attributes })",
    attributeKey: 'operative.tools.count',
    sourceValue: 'toolCalls.length (a count)',
    privileged: false,
    treatment: 'emitted',
  },
  {
    callSite: "'tools.executing' listener → tracer.startSpan(..., { attributes })",
    attributeKey: 'operative.tools.names',
    sourceValue: 'toolCalls.map(tc => tc.name) — tool identity, not tool arguments',
    privileged: false,
    treatment: 'emitted',
  },
  {
    callSite: "'tools.executed' listener → toolsSpan.setAttribute(...)",
    attributeKey: 'operative.tools.results_count',
    sourceValue: 'results.length (a count, not the results themselves)',
    privileged: false,
    treatment: 'emitted',
  },
  {
    callSite: "'run.completed' listener → runSpan.setAttributes(...)",
    attributeKey: 'operative.finish_reason',
    sourceValue: 'event.finishReason (an event type name)',
    privileged: false,
    treatment: 'emitted',
  },
  {
    callSite: "'run.completed' listener → runSpan.setAttributes(...)",
    attributeKey: 'operative.total_steps',
    sourceValue: 'event.steps.length (a count)',
    privileged: false,
    treatment: 'emitted',
  },
  {
    callSite: "'run.error' listener → runSpan.setAttributes(...)",
    attributeKey: 'error.type / operative.error.kind / operative.error.code',
    sourceValue: 'telemetryError.name, error.kind, error.code (category names/codes)',
    privileged: false,
    treatment: 'emitted',
  },
  {
    callSite: "'run.aborted' listener → runSpan.setAttribute(s)(...)",
    attributeKey:
      'operative.abort_reason / error.type / operative.error.kind / operative.error.code',
    sourceValue: "reason ?? 'unknown', error.name, error.kind, error.code (category names/codes)",
    privileged: false,
    treatment: 'emitted',
  },
  {
    callSite: "'generate.retry' listener → generateSpan.addEvent('generate.retry', attrs)",
    attributeKey: 'retry.attempt',
    sourceValue: 'attempt (a count)',
    privileged: false,
    treatment: 'emitted',
  },
  {
    callSite:
      'durable/run-workflow.ts:970 → ctx.setAttribute(...) (Weft workflow context, not an OTel span)',
    attributeKey: 'runId',
    sourceValue: 'runId (a correlation identifier)',
    privileged: false,
    treatment: 'emitted',
  },
];

describe('AB-230 operative attribute-classification table', () => {
  it('has no privileged rows — operative instrumentation never observes tool/provider/conversation content', () => {
    expect(OPERATIVE_ATTRIBUTE_CLASSIFICATION_TABLE.every((row) => !row.privileged)).toBe(true);
    expect(
      OPERATIVE_ATTRIBUTE_CLASSIFICATION_TABLE.every((row) => row.treatment === 'emitted'),
    ).toBe(true);
  });
});
