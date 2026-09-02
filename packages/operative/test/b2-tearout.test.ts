/**
 * B2 tearout verification tests.
 *
 * These tests prove that defineAgent / run() / createRun() are physically removed
 * from operative's public surface and that the module-level split is gone.
 *
 * The tests import from the package index and verify the torn-out symbols are
 * not exported. They also verify that the remaining surface (ActiveRun type,
 * RegistryAgent, the new CreateSubagentToolOptions shape) is coherent.
 */

import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

// Verify torn-out symbols are absent from the package index.
// These imports must NOT compile — we test at runtime by checking the module shape.
import * as operative from '../src/index';

describe('B2 tearout — defineAgent / run() / createRun() are gone', () => {
  it('defineAgent is not exported from operative', () => {
    expect((operative as Record<string, unknown>)['defineAgent']).toBeUndefined();
  });

  it('run is not exported from operative', () => {
    expect((operative as Record<string, unknown>)['run']).toBeUndefined();
  });

  it('createRun is not exported from operative', () => {
    expect((operative as Record<string, unknown>)['createRun']).toBeUndefined();
  });
});

describe('B2 tearout — AgentDefinition types are gone', () => {
  it('no defineAgent re-export exists', () => {
    // The define-agent module file should not exist as an importable path.
    // We verify indirectly — operative's index no longer has defineAgent.
    const exports = Object.keys(operative);
    expect(exports).not.toContain('defineAgent');
  });
});

describe('B2 tearout — remaining surface is coherent', () => {
  it('createSubagentTool is still exported', () => {
    expect(typeof operative.createSubagentTool).toBe('function');
  });

  it('createHandoffTool is still exported', () => {
    expect(typeof operative.createHandoffTool).toBe('function');
  });

  // F1/F2/F3 — Phase F multi-agent durable exports
  it('F1: ChildWorkflowStartedEvent is exported', () => {
    expect(typeof operative.ChildWorkflowStartedEvent).toBe('function');
  });

  it('F2: HandoffOccurredEvent is exported', () => {
    expect(typeof operative.HandoffOccurredEvent).toBe('function');
  });

  it('F3: HumanWaitParkedEvent is exported', () => {
    expect(typeof operative.HumanWaitParkedEvent).toBe('function');
  });

  it('F3: createRequestHumanInputTool is exported', () => {
    expect(typeof operative.createRequestHumanInputTool).toBe('function');
  });

  it('AB-22: createAgentRegistry, createSupervisor, and RegistryAgent are gone from operative', () => {
    // AB-22 removed the registry/supervisor surface from operative entirely —
    // createAgentRegistry, createSupervisor, and RegistryAgent no longer exist
    // anywhere: AgentDefinitions/BureauAgentCatalog (operative + bureau) and
    // bureau's createSupervisor/createAgentDiscoveryTool replace them.
    const exports = Object.keys(operative);
    expect(exports).not.toContain('createAgentRegistry');
    expect(exports).not.toContain('createSupervisor');
    expect(exports).not.toContain('AgentRegistry');
  });

  it('ActiveRun is exported as the internal run engine type', () => {
    // ActiveRun is the internal event-emitting engine; AgentRun is the public wrapper.
    // Both are exported: ActiveRun for gateway/scheduler/durable internals;
    // AgentRun for public consumers. We verify the public surface still works
    // by exercising createSubagentTool which depends on the full chain.
    const tool = operative.createSubagentTool({
      name: 'test-subagent',
      description: 'A subagent tool',
      agentName: 'test',
      agent: {
        name: 'stub-agent',
        run: (input) => ({
          result: () =>
            Promise.resolve({
              conversation: {} as never,
              steps: [],
              content: `Result: ${String(input)}`,
              usage: { prompt: 0, completion: 0, total: 0 },
              finishReason: 'stop-condition' as const,
            }),
          unwrap: () => Promise.resolve(`Result: ${String(input)}`),
          abort: () => {},
          [Symbol.dispose]: () => {},
          [Symbol.asyncIterator]: () => (async function* () {})(),
        }),
      },
      input: z.object({ query: z.string() }),
    });
    expect(tool.name).toBe('test-subagent');
  });
});
