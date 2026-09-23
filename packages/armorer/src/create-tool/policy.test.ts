import { describe, expect, it } from 'bun:test';

import type { ToolPolicyDecision } from '../is-tool';
import type { SatisfiedPolicyPause } from '../types';
import {
  createToolAction,
  policyPauseMatchesSatisfiedPause,
  type ToolActionContext,
} from './policy';

const context: ToolActionContext = {
  arguments: { limit: 1 },
  callId: 'policy-call',
  toolDefinitionRevision: 'revision:1',
  toolName: 'policy-tool',
};

const reason = 'Approve this call';

/** A policy that violates `ToolAction.message`'s declared `string` type. */
function decisionWithMessage(message: unknown, status: 'needs_approval' | 'needs_input') {
  return { status, reason, action: { message } } as unknown as ToolPolicyDecision;
}

const circular: Record<string, unknown> = { name: 'cycle' };
circular['self'] = circular;

/**
 * Reaches the last fallback, which nothing else here does. `JSON.stringify`
 * calls `toJSON` and throws; `String` then consults `Symbol.toPrimitive` and
 * throws too. A merely throwing `toString` is not enough — `JSON.stringify`
 * never calls it, and an ordinary object serializes to `"{}"` instead.
 */
const uncoercible = {
  toJSON() {
    throw new Error('toJSON refuses');
  },
  toString() {
    throw new Error('toString refuses');
  },
  [Symbol.toPrimitive]() {
    throw new Error('toPrimitive refuses');
  },
};

/**
 * Each of these takes a different path through coercion, and the set is chosen
 * so that a normalize-shaped fix could not pass it. A BigInt alone cannot
 * discriminate the two designs — `normalizeToolContent(10n)` already yields
 * `"10"` — which is why the plain object and the bare number are here: both
 * survive normalization unchanged and would still be non-strings.
 */
const nonStringMessages: ReadonlyArray<readonly [string, unknown]> = [
  ['a BigInt', 1n],
  ['a plain object', { detail: 'structured' }],
  ['a bare number', 42],
  ['a function', function namedPolicyMessage() {}],
  ['a symbol', Symbol('policy message')],
  ['a circular object', circular],
  ['a null-prototype object', Object.assign(Object.create(null), { detail: 'no prototype' })],
  ['a value that resists every coercion', uncoercible],
];

describe('createToolAction coerces a non-string message', () => {
  for (const [label, message] of nonStringMessages) {
    it(`produces a string for ${label} on the approval branch`, () => {
      const action = createToolAction(
        'approval',
        decisionWithMessage(message, 'needs_approval'),
        reason,
        context,
      );
      expect(typeof action.message).toBe('string');
    });

    it(`produces a string for ${label} on the input branch`, () => {
      const action = createToolAction(
        'input',
        decisionWithMessage(message, 'needs_input'),
        reason,
        context,
      );
      expect(typeof action.message).toBe('string');
    });
  }

  it('serializes the whole approval action for every one of those inputs', () => {
    // The defect this closes is a throw inside `signPendingApproval`'s
    // `JSON.stringify`. Asserting the action survives that call is the property
    // that actually matters, not the type check alone.
    for (const [, message] of nonStringMessages) {
      const action = createToolAction(
        'approval',
        decisionWithMessage(message, 'needs_approval'),
        reason,
        context,
      );
      expect(() => JSON.stringify(action)).not.toThrow();
    }
  });

  it('keeps the structure of an object message rather than flattening it', () => {
    const action = createToolAction(
      'approval',
      decisionWithMessage({ detail: 'structured' }, 'needs_approval'),
      reason,
      context,
    );
    expect(action.message).toBe('{"detail":"structured"}');
  });

  it('falls back to the reason only when coercion cannot produce a string at all', () => {
    expect(
      createToolAction(
        'approval',
        decisionWithMessage(uncoercible, 'needs_approval'),
        reason,
        context,
      ).message,
    ).toBe(reason);
  });

  it('serializes a null-prototype object rather than falling back', () => {
    // `JSON.stringify` handles it, so the fallback is never reached. Worth
    // pinning: the naive expectation is that a null prototype defeats coercion,
    // and it only defeats `String`, which runs second.
    expect(
      createToolAction(
        'approval',
        decisionWithMessage(
          Object.assign(Object.create(null), { detail: 'no prototype' }),
          'needs_approval',
        ),
        reason,
        context,
      ).message,
    ).toBe('{"detail":"no prototype"}');
  });
});

describe('createToolAction leaves a well-typed message alone', () => {
  it('passes a string through byte-identical on both branches', () => {
    const message = 'Delete 3 files in /tmp — approve?';
    expect(
      createToolAction('approval', decisionWithMessage(message, 'needs_approval'), reason, context)
        .message,
    ).toBe(message);
    expect(
      createToolAction('input', decisionWithMessage(message, 'needs_input'), reason, context)
        .message,
    ).toBe(message);
  });

  it('falls back to the reason when no message is supplied', () => {
    for (const message of [undefined, null]) {
      expect(
        createToolAction(
          'approval',
          decisionWithMessage(message, 'needs_approval'),
          reason,
          context,
        ).message,
      ).toBe(reason);
    }
  });

  it('preserves the empty string on the input branch', () => {
    expect(
      createToolAction('input', decisionWithMessage('', 'needs_input'), reason, context).message,
    ).toBe('');
  });

  it('records that the approval branch drops an empty message', () => {
    // Not coercion's doing — `coerceActionMessage` returns `''` for both
    // branches, and `materializeToolResult` is what omits it here. Pinned
    // because the asymmetry with the input branch above is surprising, and
    // because a future change to coercion should not be blamed for it.
    expect(
      createToolAction('approval', decisionWithMessage('', 'needs_approval'), reason, context)
        .message,
    ).toBeUndefined();
  });
});

/**
 * `createToolAction`'s other caller is resume matching, which compares a stored
 * pause against a fresh decision. Coercion must not change those answers, and it
 * must not throw there: that path has no error channel, so a guard that rejected
 * instead of coercing would have introduced a new failure during resume.
 */
describe('resume matching is unaffected by coercion', () => {
  function satisfiedPause(message: unknown): SatisfiedPolicyPause {
    return {
      action: createToolAction(
        'approval',
        decisionWithMessage(message, 'needs_approval'),
        reason,
        context,
      ),
      reason,
      tier: 'tool',
    };
  }

  it('matches a pause against the decision that produced it', () => {
    for (const [, message] of nonStringMessages) {
      const decision = decisionWithMessage(message, 'needs_approval');
      expect(policyPauseMatchesSatisfiedPause(decision, satisfiedPause(message), context)).toBe(
        true,
      );
    }
  });

  it('does not match a pause whose message differs', () => {
    const decision = decisionWithMessage({ detail: 'structured' }, 'needs_approval');
    expect(
      policyPauseMatchesSatisfiedPause(decision, satisfiedPause({ detail: 'different' }), context),
    ).toBe(false);
  });

  it('never throws, for any of these inputs', () => {
    for (const [, message] of nonStringMessages) {
      const decision = decisionWithMessage(message, 'needs_approval');
      expect(() =>
        policyPauseMatchesSatisfiedPause(decision, satisfiedPause(message), context),
      ).not.toThrow();
    }
  });
});
