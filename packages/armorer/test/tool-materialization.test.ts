import { describe, expect, it } from 'bun:test';

import {
  materializeToolCall,
  materializeToolCalls,
  materializeToolResult,
  materializeToolResultAsync,
  materializeToolResults,
  materializeToolResultsAsync,
} from '../src/tool-materialization';

describe('tool materialization helpers', () => {
  it('materializes tool calls with generated identifiers and normalized arguments', () => {
    const circularArguments: Record<string, unknown> = {};
    circularArguments.self = circularArguments;

    expect(
      materializeToolCall(
        {
          name: 'lookup',
          arguments: undefined,
        },
        {
          generateId: () => 'generated-call',
        },
      ),
    ).toEqual({
      id: 'generated-call',
      name: 'lookup',
      arguments: {},
    });

    expect(
      materializeToolCalls([
        {
          id: 'call-symbol',
          name: 'lookup',
          arguments: Symbol('arguments'),
        },
        {
          id: 'call-circular',
          name: 'lookup',
          arguments: circularArguments,
        },
      ]),
    ).toEqual([
      {
        id: 'call-symbol',
        name: 'lookup',
        arguments: 'Symbol(arguments)',
      },
      {
        id: 'call-circular',
        name: 'lookup',
        arguments: '[object Object]',
      },
    ]);
  });

  it('materializes synchronous tool results and strips runtime-only fields', () => {
    expect(
      materializeToolResult({
        callId: 'call-1',
        outcome: 'action_required',
        content: undefined,
        toolCallId: 'call-1',
        toolName: 'lookup',
        result: 'ignored',
        action: {
          type: 'approval',
          message: 'Need approval',
          schema: Symbol('approval'),
        },
      }),
    ).toEqual({
      callId: 'call-1',
      outcome: 'action_required',
      content: null,
      action: {
        type: 'approval',
        message: 'Need approval',
        schema: 'Symbol(approval)',
      },
    });

    expect(
      materializeToolResult({
        callId: 'call-error',
        outcome: 'error',
        content: Symbol('content'),
        error: {
          code: 'tool.symbol',
          category: 'internal',
          retryable: false,
          message: 'symbolic',
          details: Symbol('details') as never,
        },
      }),
    ).toEqual({
      callId: 'call-error',
      outcome: 'error',
      content: 'Symbol(content)',
      error: {
        code: 'tool.symbol',
        category: 'internal',
        retryable: false,
        message: 'symbolic',
        details: 'Symbol(details)',
      },
    });

    expect(
      materializeToolResults([
        {
          callId: 'call-2',
          outcome: 'success',
          content: { ok: true },
        },
      ]),
    ).toEqual([
      {
        callId: 'call-2',
        outcome: 'success',
        content: { ok: true },
      },
    ]);
  });

  it('rejects live streaming results in the synchronous materializer', () => {
    expect(() =>
      materializeToolResult({
        callId: 'call-stream',
        outcome: 'success',
        content: [],
        stream: {
          async *[Symbol.asyncIterator]() {
            yield 'chunk';
          },
        },
      }),
    ).toThrow(
      'materializeToolResult does not support streaming tool results. Use materializeToolResultAsync or materializeToolResultsAsync.',
    );
  });

  it('materializes asynchronous tool results from stream handles and runtime result streams', async () => {
    const circularDetails: Record<string, unknown> = {};
    circularDetails.self = circularDetails;

    await expect(
      materializeToolResultAsync({
        callId: 'call-stream',
        outcome: 'success',
        content: [],
        stream: {
          async *[Symbol.asyncIterator]() {
            yield 'alpha';
            yield 'beta';
          },
        },
      }),
    ).resolves.toEqual({
      callId: 'call-stream',
      outcome: 'success',
      content: ['alpha', 'beta'],
    });

    await expect(
      materializeToolResultsAsync([
        {
          callId: 'call-result-stream',
          outcome: 'success',
          content: [],
          result: {
            async *[Symbol.asyncIterator]() {
              yield 1;
              yield 2;
            },
          },
        },
        {
          callId: 'call-error',
          outcome: 'error',
          content: circularDetails,
          error: {
            code: 'tool.circular',
            category: 'internal',
            retryable: false,
            message: 'circular',
            details: circularDetails as never,
          },
        },
      ]),
    ).resolves.toEqual([
      {
        callId: 'call-result-stream',
        outcome: 'success',
        content: [1, 2],
      },
      {
        callId: 'call-error',
        outcome: 'error',
        content: '[object Object]',
        error: {
          code: 'tool.circular',
          category: 'internal',
          retryable: false,
          message: 'circular',
          details: '[object Object]',
        },
      },
    ]);
  });
});
