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
        seen.push(request);
        return {
          requestId: request.requestId,
          toolCallId: request.toolCallId,
          data: { approved: true },
        } as any;
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
        return {
          requestId: request.requestId,
          toolCallId: request.toolCallId,
          data: { acknowledged: true },
        } as any;
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
      onElicitation: async (request) =>
        ({
          requestId: request.requestId,
          toolCallId: request.toolCallId,
          data: { approved: true },
        }) as any,
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

  it.each(['not-an-object', null])(
    'drops non-object accept data %p without treating acceptance as decline',
    async (data) => {
      const responder = createMcpElicitationResponder({
        onElicitation: async (request) =>
          ({
            requestId: request.requestId,
            toolCallId: request.toolCallId,
            data,
          }) as any,
        getContext: makeContext,
      });

      const result = await responder({
        message: 'Approve?',
        mode: 'form',
        schema: { type: 'object' },
      });

      expect(result).toEqual({ action: 'accept', content: undefined });
    },
  );

  it.each(['request', 'tool'] as const)(
    'rejects a mismatched %s identity without an accepted event',
    async (identity) => {
      const emitter = new CompletableEventTarget<CombinedOperativeEventMap>();
      const resolved: ElicitationResolvedEvent[] = [];
      emitter.addEventListener(ElicitationResolvedEvent.type, (event) => resolved.push(event));
      const responder = createMcpElicitationResponder({
        getContext: makeContext,
        emitter,
        onElicitation: async (request) => ({
          requestId: identity === 'request' ? 'retired-request' : request.requestId,
          ...(identity === 'tool' ? { toolCallId: 'unrelated-tool' } : {}),
          data: request.schema.parse({ approved: true }),
        }),
      });
      await expect(
        responder({ message: 'Approve?', mode: 'form', schema: { type: 'object' } }),
      ).rejects.toThrow('Elicitation response did not match its request.');
      expect(resolved).toHaveLength(0);
    },
  );

  it('freezes each logical request and preserves the host context', async () => {
    const context = makeContext();
    const identities: string[] = [];
    const responder = createMcpElicitationResponder({
      getContext: () => context,
      onElicitation: async (request) => {
        expect(Object.isFrozen(request)).toBe(true);
        expect(Reflect.set(request, 'requestId', 'replacement')).toBe(false);
        expect(request.context).toBe(context);
        identities.push(request.requestId);
        return { requestId: request.requestId, data: request.schema.parse({}) };
      },
    });
    await Promise.all([
      responder({ message: 'Repeat', mode: 'form' }),
      responder({ message: 'Repeat', mode: 'form' }),
    ]);
    expect(new Set(identities).size).toBe(2);
  });

  it('retires a cancelled request before a late answer arrives', async () => {
    const controller = new AbortController();
    const context = { ...makeContext(), signal: controller.signal };
    const entered = Promise.withResolvers<void>();
    const answer = Promise.withResolvers<void>();
    const emitter = new CompletableEventTarget<CombinedOperativeEventMap>();
    const resolved: ElicitationResolvedEvent[] = [];
    emitter.addEventListener(ElicitationResolvedEvent.type, (event) => resolved.push(event));
    const responder = createMcpElicitationResponder({
      getContext: () => context,
      emitter,
      onElicitation: async (request) => {
        entered.resolve();
        await answer.promise;
        return { requestId: request.requestId, data: request.schema.parse({}) };
      },
    });
    const result = responder({ message: 'Approve?', mode: 'form' });
    await entered.promise;
    controller.abort();
    expect(await result).toEqual({ action: 'decline' });
    expect(resolved.map((event) => event.accepted)).toEqual([false]);
    answer.resolve();
    await answer.promise;
    await Promise.resolve();
    expect(resolved.map((event) => event.accepted)).toEqual([false]);
  });
});
