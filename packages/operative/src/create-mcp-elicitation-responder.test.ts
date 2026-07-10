import type { ToolElicitationRequest } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { CompletableEventTarget } from 'lifecycle';

import { createMcpElicitationResponder } from './create-mcp-elicitation-responder';
import type { CombinedOperativeEventMap } from './events';
import { ElicitationRequestedEvent, ElicitationResolvedEvent } from './events';
import type { ElicitationRequest, StepContext } from './types';

function makeContext(): StepContext {
  return { conversation: { messages: [] } as never, step: 3 };
}

describe('createMcpElicitationResponder', () => {
  it('drives the request through onElicitation with a schema derived from the MCP form schema', async () => {
    const seen: ElicitationRequest[] = [];

    const responder = createMcpElicitationResponder({
      onElicitation: async (request) => {
        seen.push(request as ElicitationRequest);
        return { data: { approved: true } } as any;
      },
      getContext: makeContext,
    });

    const request: ToolElicitationRequest = {
      message: 'Approve purchase?',
      mode: 'form',
      schema: {
        type: 'object',
        properties: { approved: { type: 'boolean' } },
        required: ['approved'],
      },
    };
    const result = await responder(request);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.message).toBe('Approve purchase?');
    expect(seen[0]?.context.step).toBe(3);
    const parsed = seen[0]?.schema.parse({ approved: true });
    expect(parsed).toEqual({ approved: true });

    expect(result).toEqual({ action: 'accept', content: { approved: true } });
  });

  it('translates a null onElicitation response into a decline', async () => {
    const responder = createMcpElicitationResponder({
      onElicitation: async () => null,
      getContext: makeContext,
    });

    const result = await responder({
      message: 'Approve?',
      mode: 'form',
      schema: { type: 'object' },
    });

    expect(result).toEqual({ action: 'decline' });
  });

  it('models URL-mode elicitation as a boolean acknowledgement schema and folds the URL into the message', async () => {
    let capturedSchema: unknown;
    let capturedMessage: string | undefined;
    const responder = createMcpElicitationResponder({
      onElicitation: async (request) => {
        capturedSchema = request.schema;
        capturedMessage = request.message;
        return { data: { acknowledged: true } } as any;
      },
      getContext: makeContext,
    });

    await responder({ message: 'Open this link', mode: 'url', url: 'https://example.com' });

    expect(
      (capturedSchema as { parse: (v: unknown) => unknown }).parse({ acknowledged: true }),
    ).toEqual({
      acknowledged: true,
    });
    expect(capturedMessage).toBe('Open this link (https://example.com)');
  });

  it('dispatches ElicitationRequestedEvent and ElicitationResolvedEvent around the call', async () => {
    const emitter = new CompletableEventTarget<CombinedOperativeEventMap>();
    const requested: ElicitationRequestedEvent[] = [];
    const resolved: ElicitationResolvedEvent[] = [];
    emitter.addEventListener(ElicitationRequestedEvent.type, (event) => {
      requested.push(event);
    });
    emitter.addEventListener(ElicitationResolvedEvent.type, (event) => {
      resolved.push(event);
    });

    const responder = createMcpElicitationResponder({
      onElicitation: async () => ({ data: { approved: true } }) as any,
      getContext: makeContext,
      emitter,
    });

    await responder({ message: 'Approve?', mode: 'form', schema: { type: 'object' } });

    expect(requested).toHaveLength(1);
    expect(requested[0]?.message).toBe('Approve?');
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.accepted).toBe(true);
  });

  it('dispatches ElicitationResolvedEvent with accepted false on decline', async () => {
    const emitter = new CompletableEventTarget<CombinedOperativeEventMap>();
    const resolved: ElicitationResolvedEvent[] = [];
    emitter.addEventListener(ElicitationResolvedEvent.type, (event) => {
      resolved.push(event);
    });

    const responder = createMcpElicitationResponder({
      onElicitation: async () => null,
      getContext: makeContext,
      emitter,
    });

    await responder({ message: 'Approve?', mode: 'form', schema: { type: 'object' } });

    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.accepted).toBe(false);
  });

  it('drops non-object accept data instead of forwarding it as content', async () => {
    const responder = createMcpElicitationResponder({
      onElicitation: async () => ({ data: 'not-an-object' }) as any,
      getContext: makeContext,
    });

    const result = await responder({
      message: 'Approve?',
      mode: 'form',
      schema: { type: 'object' },
    });

    expect(result).toEqual({ action: 'accept', content: undefined });
  });
});
