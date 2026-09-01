import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, test } from 'bun:test';
import ts from 'typescript';

/**
 * AB-34's fourth verification command.
 *
 * `documentation/operative-type-safe-api.md` is a contract document: its fenced
 * examples are the normative illustration of the typed Agent and Bureau API, and
 * AB-15 shipped it with no mechanism to check that they stay true. A renamed
 * method or a typo in an example is invisible until a reader copies it.
 *
 * This harness checks that every member an example invokes on a run handle is
 * either declared by the contract document itself, or listed below as a required
 * capability with the issue that owns its signature. Both directions are
 * asserted, so an entry cannot outlive its implementation and a new example
 * cannot reference a capability nobody owns.
 *
 * AB-34 was re-scoped after three review rounds: it states the capabilities every
 * independently owned handle must provide and leaves the signatures to AB-88,
 * AB-50, and AB-37. So the map below reads "required here, declared by that
 * issue". The examples use placeholder names; the owning issue picks the real
 * one, and the accounting test forces the map and the examples to move together.
 *
 * It does not type-check the fences. They are fragments that never declare
 * `bureau` or `run`, so none is a standalone module, and the capabilities are
 * unimplemented by design — a type-check would fail against today's source and
 * prove nothing. Drift between an example and the contract is the real risk.
 *
 * WHY AN AST RATHER THAN REGULAR EXPRESSIONS. Earlier revisions scanned the
 * fences with regular expressions, and review found five holes in sequence:
 * hard-coded receiver names, member-name filtering applied after the receiver was
 * already known, unbalanced parentheses in nested calls, parentheses inside
 * string literals, and producer text inside comments treated as real code. That
 * last one produced *false failures*, not merely misses. Each fix revealed the
 * next gap, which is the signature of hand-rolled lexing. The TypeScript compiler
 * is already a root devDependency, so parsing properly costs nothing and ends the
 * class: comments and literals are excluded by construction, and aliasing becomes
 * a data-flow question the AST can answer.
 */

const repositoryRoot = resolve(import.meta.dir, '..');
const documentPath = resolve(repositoryRoot, 'documentation/operative-type-safe-api.md');
const agentRunPath = resolve(repositoryRoot, 'packages/operative/src/agent-run.ts');

/**
 * Capabilities this contract requires, each naming the issue that owns declaring
 * and implementing the signature. When that issue lands, its entry must be
 * removed — the "quietly implemented" test below fails if an implemented member
 * is still listed, so this cannot rot into a permanent excuse list.
 */
const PENDING_IMPLEMENTATION: Readonly<Record<string, string>> = {
  snapshot: 'AB-88',
  subscribeSnapshot: 'AB-88',
  children: 'AB-50',
  abortChild: 'AB-50',
  closed: 'AB-37',
};

/**
 * Calls that produce an `AgentRun`, the surface `documentedMembers` describes.
 *
 * Deliberately only `run`. Earlier revisions also listed `createRun`,
 * `createActiveRun`, and `getRun`, which return `ActiveRun` and `RunSummary` —
 * different types with different members. Treating their results as `AgentRun`
 * would reject a legitimate example: `createActiveRun(...).subscribe(...)` is
 * correct on an `ActiveRun`, whose event subscription is exactly the member this
 * contract forbids naming `subscribe` on a run handle. A checker that fails
 * valid code is worse than one with a narrower scope, so the scope is narrow and
 * stated. Extending it means pairing each producer with its own surface.
 */
const RUN_PRODUCERS = new Set(['run']);

function read(path: string): string {
  return readFileSync(path, 'utf-8');
}

function typescriptFences(markdown: string): string[] {
  const fences: string[] = [];
  const pattern = /```ts\n([\s\S]*?)```/g;
  let match = pattern.exec(markdown);
  while (match !== null) {
    if (match[1] !== undefined) fences.push(match[1]);
    match = pattern.exec(markdown);
  }
  return fences;
}

/** Members declared across every block declaring the named interface. */
function declaredMembers(source: string, interfaceName: string): Set<string> {
  const members = new Set<string>();
  let searchFrom = 0;
  let found = false;

  for (;;) {
    const start = source.indexOf(`interface ${interfaceName}`, searchFrom);
    if (start < 0) break;
    found = true;
    for (const member of membersOfBlock(source, start)) members.add(member);
    searchFrom = start + 1;
  }

  if (!found) throw new Error(`interface ${interfaceName} not found`);
  return members;
}

/** Members declared in the brace-balanced block beginning after `start`. */
function membersOfBlock(source: string, start: number): Set<string> {
  const open = source.indexOf('{', start);
  let depth = 0;
  let end = open;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  const block = source.slice(open, end);
  const members = new Set<string>();
  const pattern = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*[(<?:]/gm;
  let match = pattern.exec(block);
  while (match !== null) {
    if (match[1] !== undefined) members.add(match[1]);
    match = pattern.exec(block);
  }
  return members;
}

/** True when a call expression produces a run handle. */
function isRunProducer(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return RUN_PRODUCERS.has(callee.text);
  if (ts.isPropertyAccessExpression(callee)) return RUN_PRODUCERS.has(callee.name.text);
  return false;
}

/** Unwraps `await x` and `(x)` down to the expression underneath. */
function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  for (;;) {
    if (ts.isAwaitExpression(current)) current = current.expression;
    else if (ts.isParenthesizedExpression(current)) current = current.expression;
    else return current;
  }
}

/**
 * Every member invoked on a run handle in one fence.
 *
 * A receiver counts as a run handle when it is a producer call itself, a binding
 * initialised from one, or a binding aliased from another such binding. Aliases
 * resolve to a fixed point, so `const alias = draft` is covered however many
 * hops it takes.
 */
function runHandleCalls(fence: string, index: number): Set<string> {
  const file = ts.createSourceFile(
    `example-${index}.ts`,
    fence,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  const handles = new Set<string>();
  const aliases: Array<{ from: string; to: string }> = [];

  const collectBindings = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const initializer = unwrap(node.initializer);
      if (isRunProducer(initializer)) {
        handles.add(node.name.text);
      } else if (ts.isIdentifier(initializer)) {
        aliases.push({ from: initializer.text, to: node.name.text });
      }
    }
    ts.forEachChild(node, collectBindings);
  };
  collectBindings(file);

  for (let changed = true; changed;) {
    changed = false;
    for (const alias of aliases) {
      if (handles.has(alias.from) && !handles.has(alias.to)) {
        handles.add(alias.to);
        changed = true;
      }
    }
  }

  const members = new Set<string>();

  const onRunHandle = (receiver: ts.Expression): boolean => {
    const target = unwrap(receiver);
    return (ts.isIdentifier(target) && handles.has(target.text)) || isRunProducer(target);
  };

  const collectCalls = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;

      if (ts.isPropertyAccessExpression(callee) && onRunHandle(callee.expression)) {
        members.add(callee.name.text);
      }

      // Element access, which property-access-only collection missed entirely:
      //   run[Symbol.dispose]()   — explicitly part of the AgentRun contract
      //   run['reslut']()         — a typo that would otherwise pass
      if (ts.isElementAccessExpression(callee) && onRunHandle(callee.expression)) {
        const argument = callee.argumentExpression;
        if (ts.isStringLiteralLike(argument)) {
          members.add(argument.text);
        } else if (
          ts.isPropertyAccessExpression(argument) &&
          ts.isIdentifier(argument.expression) &&
          argument.expression.text === 'Symbol'
        ) {
          // Well-known symbols are contract members too. Recorded under their
          // documented spelling so the accounting map can name them.
          members.add(`[Symbol.${argument.name.text}]`);
        }
      }
    }
    ts.forEachChild(node, collectCalls);
  };
  collectCalls(file);

  return members;
}

const document = read(documentPath);
const fences = typescriptFences(document);

/**
 * The contract's own declared surface, taken from the document rather than from
 * a source file. `bureau-types.ts` also declares an `AgentRun`, but that is the
 * earlier spike shape; the ratified one is this document's `RunOutcomeBase`,
 * implemented in `agent-run.ts`.
 */
const documentedMembers = new Set<string>([
  ...declaredMembers(document, 'RunOutcomeBase'),
  'output',
  'abort',
  // Declared on the AgentRun type alias rather than inside RunOutcomeBase, so
  // the interface scan cannot see it, and spelled the way element-access
  // collection records it.
  '[Symbol.dispose]',
]);

describe('documentation/operative-type-safe-api.md examples', () => {
  test('the document contains fenced TypeScript examples to check', () => {
    expect(fences.length).toBeGreaterThan(0);
  });

  test('the documented run-handle surface is readable', () => {
    expect([...documentedMembers].sort()).toContain('result');
    expect([...documentedMembers].sort()).toContain('unwrap');
  });

  test('every run-handle member an example invokes is documented or owned', () => {
    const unaccounted = new Set<string>();
    fences.forEach((fence, index) => {
      for (const member of runHandleCalls(fence, index)) {
        // Object.hasOwn, not `in`: `'constructor' in PENDING_IMPLEMENTATION` and
        // `'toString' in ...` are both true through the prototype chain, so
        // `run.toString()` would otherwise count as an owned capability.
        if (Object.hasOwn(PENDING_IMPLEMENTATION, member)) continue;
        if (documentedMembers.has(member)) continue;
        unaccounted.add(member);
      }
    });

    // A failure means an example calls something that neither exists nor has an
    // owner. Either the example is wrong, or the member needs a
    // PENDING_IMPLEMENTATION entry naming the issue that will deliver it.
    expect([...unaccounted].sort()).toEqual([]);
  });

  test('no required capability has quietly been implemented under its placeholder name', () => {
    const source = read(agentRunPath);
    const stale = Object.keys(PENDING_IMPLEMENTATION).filter((member) =>
      new RegExp(`^\\s*${member}\\s*[(<]`, 'm').test(source),
    );

    // A failure here is good news needing action: the owning issue landed, so
    // drop the entry and let the member be checked as documented surface.
    //
    // KNOWN LIMIT, and the test name says so rather than overclaiming. AB-34 was
    // re-scoped to make these names non-normative — the owning issue picks the
    // real one — which means a rename slips past this check entirely. If AB-37
    // ships `whenClosed()`, the `closed` entry and its example stay green here.
    // The re-scope created this hole: the check assumed names it then stopped
    // fixing.
    //
    // Nothing in a unit test can close it, because the mapping from capability
    // to final name does not exist until the owning issue chooses it. The
    // obligation therefore lives where it can be enforced: each capability's
    // owning issue must remove its entry from this map as part of its own
    // acceptance criteria, which the contract document states.
    expect(stale).toEqual([]);
  });

  test('every required capability names the issue that owns it', () => {
    for (const [member, owner] of Object.entries(PENDING_IMPLEMENTATION)) {
      expect(owner, `${member} must name an owning issue`).toMatch(/^AB-\d+$/);
    }
  });

  test('the state-observation capability is not named subscribe', () => {
    // ActiveRun.subscribe and Bureau.subscribe are event subscriptions. This
    // checks the declared surface rather than a receiver spelling in the prose:
    // an earlier assertion searched for `run.subscribe(`, which would have
    // passed had the contract declared subscribe() with no example calling it.
    expect([...documentedMembers]).not.toContain('subscribe');
    expect(Object.keys(PENDING_IMPLEMENTATION)).not.toContain('subscribe');
  });

  test('the started-work control contract section is present', () => {
    expect(document).toContain('## Started-work control contract');
    expect(document).toContain('### Classification table');
  });
});
