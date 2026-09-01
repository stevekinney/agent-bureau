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
const RUN_PRODUCER_METHOD = 'run';

/**
 * Receivers whose `.run(...)` yields an `AgentRun`.
 *
 * Matching by method name alone treated `createAgentEvaluation(...).run()`,
 * which returns a `Promise<EvaluationReport>`, as a run handle and rejected
 * `then` as undocumented. Restricting to `bureau` alone then went too far the
 * other way and hid the contract's own standalone path, where a `RunnableAgent`
 * returned by `createAgent` is the receiver.
 *
 * So receivers are resolved from the fence: `bureau` by convention, plus any
 * binding initialised from `createAgent`/`createLazyAgent`. Both are named
 * because both produce the surface this contract describes, and neither
 * silently admits an unrelated `.run()`.
 */
const AGENT_FACTORIES = new Set(['createAgent', 'createLazyAgent']);
const BUREAU_FACTORIES = new Set(['createBureau']);
const CONVENTIONAL_RUN_RECEIVER = 'bureau';

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
function isRunProducer(node: ts.Node, isAgent: (name: string) => boolean): boolean {
  if (!ts.isCallExpression(node)) return false;
  const callee = unwrap(node.expression);
  if (!ts.isPropertyAccessExpression(callee)) return false;
  if (callee.name.text !== RUN_PRODUCER_METHOD) return false;
  const receiver = unwrap(callee.expression);
  if (!ts.isIdentifier(receiver)) return false;
  return isAgent(receiver.text);
}

/**
 * Strips the transparent wrappers that do not change what an expression refers
 * to: `await x`, `(x)`, `x as T`, `<T>x`, `x!`, `x satisfies T`.
 */
function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  for (;;) {
    if (ts.isAwaitExpression(current)) current = current.expression;
    else if (ts.isParenthesizedExpression(current)) current = current.expression;
    else if (ts.isAsExpression(current)) current = current.expression;
    else if (ts.isTypeAssertionExpression(current)) current = current.expression;
    else if (ts.isNonNullExpression(current)) current = current.expression;
    else if (ts.isSatisfiesExpression(current)) current = current.expression;
    else return current;
  }
}

/**
 * Every member invoked on a run handle in one fence.
 *
 * Two passes over one scope structure, which is what makes both properties hold
 * at once. Review found the failure mode of each single-pass design:
 *
 * - Keying bindings by bare name conflates shadowed declarations, so an inner
 *   `const run = helper()` was attributed to an outer run handle and its members
 *   reported invalid — a false failure on correct documentation.
 * - Resolving in one ordered pass loses forward references, so an alias declared
 *   before the handle it points at silently stopped being tracked.
 *
 * Pass one records what every binding holds, per scope. Pass two resolves calls
 * against the scope active at that node.
 *
 * Bindings are position-stamped, so a call resolves against the state at its own
 * position rather than the binding's final value. Agent-ness rides on the same
 * events, which makes agent receivers scope-aware: an inner binding shadowing an
 * outer agent no longer inherits its handle-producing behaviour. Scopes are identified by a
 * deterministic pre-order counter, so both passes agree on which scope is which
 * without needing a type checker.
 */
function runHandleCalls(fence: string, index: number): Set<string> {
  const file = ts.createSourceFile(
    `example-${index}.ts`,
    fence,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  const opensScope = (node: ts.Node): boolean =>
    ts.isBlock(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isForStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isCaseBlock(node);

  const destructured = new Set<string>();

  // scopeId -> name -> the binding's value at each point it was set.
  //
  // Position-stamped rather than a single final value, so a call resolves
  // against the state at *its* position. A fence that reassigns a handle
  // between two calls on it previously resolved both against the later state.
  // Agent-ness is carried on the same events, which makes agent receivers
  // scope-aware for free — a shadowed agent binding no longer leaks outward.
  interface BindingState {
    readonly pos: number;
    readonly handle: boolean;
    /** Initialised from an agent factory, so `.run()` yields a handle. */
    readonly agent: boolean;
    /** Initialised from `createBureau`, so `.run()` yields a handle. */
    readonly bureau: boolean;
  }
  const bindings = new Map<number, Map<string, BindingState[]>>();
  bindings.set(0, new Map());

  /** The binding in force for `name` at `pos`, or undefined when unbound. */
  const lookup = (chain: number[], name: string, pos: number): BindingState | undefined => {
    for (let i = chain.length - 1; i >= 0; i -= 1) {
      const states = bindings.get(chain[i] ?? 0)?.get(name);
      if (states === undefined) continue;
      let current: BindingState | undefined;
      for (const state of states) {
        if (state.pos <= pos) current = state;
      }
      // A name declared in this scope shadows an outer one even before its
      // initialiser runs — that is a temporal dead zone, not the outer binding.
      return current ?? { pos, handle: false, agent: false, bureau: false };
    }
    return undefined;
  };

  const record = (scope: number, name: string, state: BindingState): void => {
    const forScope = bindings.get(scope);
    if (!forScope) return;
    const existing = forScope.get(name);
    if (existing) existing.push(state);
    else forScope.set(name, [state]);
  };

  /**
   * Whether `name` is a receiver whose `.run()` yields a handle.
   *
   * A resolved binding wins over the conventional spelling, so an inner
   * `const bureau = helper()` shadows the outer one and its `.run()` is no
   * longer treated as producing a handle. The bare name is honoured only when
   * the fence never binds it, which is the fragment case these examples use.
   */
  const isRunReceiver = (name: string, chain: number[], pos: number): boolean => {
    const state = lookup(chain, name, pos);
    if (state) return state.agent || state.bureau;
    return name === CONVENTIONAL_RUN_RECEIVER;
  };

  const producesHandle = (expression: ts.Expression, chain: number[], pos: number): boolean => {
    const value = unwrap(expression);
    if (isRunProducer(value, (name) => isRunReceiver(name, chain, pos))) return true;
    return ts.isIdentifier(value) && lookup(chain, value.text, pos)?.handle === true;
  };

  const factoryCall = (expression: ts.Expression, factories: ReadonlySet<string>): boolean => {
    const value = unwrap(expression);
    return (
      ts.isCallExpression(value) &&
      ts.isIdentifier(value.expression) &&
      factories.has(value.expression.text)
    );
  };

  /** Whether this initialiser makes the binding an agent, whose .run() yields a handle. */
  const producesAgent = (expression: ts.Expression, chain: number[], pos: number): boolean => {
    if (factoryCall(expression, AGENT_FACTORIES)) return true;
    // An alias carries it: `const a = researcher; a.run(...)`.
    const value = unwrap(expression);
    return ts.isIdentifier(value) && lookup(chain, value.text, pos)?.agent === true;
  };

  /** Whether this initialiser makes the binding a bureau. */
  const producesBureau = (expression: ts.Expression, chain: number[], pos: number): boolean => {
    if (factoryCall(expression, BUREAU_FACTORIES)) return true;
    const value = unwrap(expression);
    return ts.isIdentifier(value) && lookup(chain, value.text, pos)?.bureau === true;
  };

  // ── Pass one: record every binding, in its own scope ────────────────
  let counter = 0;
  const declarePass = (node: ts.Node, chain: number[]): void => {
    let here = chain;
    if (opensScope(node)) {
      counter += 1;
      bindings.set(counter, new Map());
      here = [...chain, counter];
    }

    // Parameters bind in the scope their function opened. Without this, a
    // parameter named like an outer handle does not shadow it and its members
    // are reported as invalid AgentRun calls — a false failure on correct code.
    if (opensScope(node)) {
      const parameters = (node as ts.SignatureDeclarationBase).parameters;
      if (parameters) {
        for (const parameter of parameters) {
          if (ts.isIdentifier(parameter.name)) {
            record(here[here.length - 1] ?? 0, parameter.name.text, {
              pos: parameter.getStart(file),
              handle: false,
              agent: false,
              bureau: false,
            });
          }
        }
      }
    }

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const pos = node.getStart(file);
      const holds = node.initializer ? producesHandle(node.initializer, here, pos) : false;
      const agent = node.initializer ? producesAgent(node.initializer, here, pos) : false;
      const bureau = node.initializer ? producesBureau(node.initializer, here, pos) : false;
      record(here[here.length - 1] ?? 0, node.name.text, { pos, handle: holds, agent, bureau });
    }

    // Destructuring a handle is still invoking its members:
    //   const { result, reslut } = bureau.run(...)
    // The names are taken from the pattern rather than from a call site, since
    // there is no call expression to see.
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      producesHandle(node.initializer, here, node.getStart(file))
    ) {
      for (const element of node.name.elements) {
        const property = element.propertyName ?? element.name;
        if (ts.isIdentifier(property)) destructured.add(property.text);
      }
    }

    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      const pos = node.getStart(file);
      const name = node.left.text;
      const holds = producesHandle(node.right, here, pos);
      const agent = producesAgent(node.right, here, pos);
      const bureau = producesBureau(node.right, here, pos);
      // Reassignment records an event in the declaring scope, so calls before
      // it keep resolving to the earlier state and calls after see the new one.
      let target = here[here.length - 1] ?? 0;
      for (let i = here.length - 1; i >= 0; i -= 1) {
        if (bindings.get(here[i] ?? 0)?.has(name)) {
          target = here[i] ?? 0;
          break;
        }
      }
      record(target, name, { pos, handle: holds, agent, bureau });
    }

    ts.forEachChild(node, (child) => declarePass(child, here));
  };
  // Aliases can point forward (`const alias = draft` before `draft` is bound),
  // so repeat the pass until nothing changes. Scope ids are deterministic, so
  // each repetition sees the same scopes and only the binding values settle.
  let previous = '';
  for (let attempt = 0; attempt < 5; attempt += 1) {
    counter = 0;
    declarePass(file, [0]);
    const snapshot = JSON.stringify([...bindings].map(([id, m]) => [id, [...m]]));
    if (snapshot === previous) break;
    previous = snapshot;
  }

  // ── Pass two: resolve calls against the scope active at each node ───
  const members = new Set<string>();
  let walkCounter = 0;

  const onRunHandle = (receiver: ts.Expression, chain: number[], pos: number): boolean => {
    const target = unwrap(receiver);
    if (isRunProducer(target, (name) => isRunReceiver(name, chain, pos))) return true;
    return ts.isIdentifier(target) && lookup(chain, target.text, pos)?.handle === true;
  };

  const callPass = (node: ts.Node, chain: number[]): void => {
    let here = chain;
    if (opensScope(node)) {
      walkCounter += 1;
      here = [...chain, walkCounter];
    }

    if (ts.isCallExpression(node)) {
      const callee = node.expression;

      if (
        ts.isPropertyAccessExpression(callee) &&
        onRunHandle(callee.expression, here, node.getStart(file))
      ) {
        members.add(callee.name.text);
      }

      // Element access, which property-access-only collection missed entirely:
      //   run[Symbol.dispose]()   — explicitly part of the AgentRun contract
      //   run['reslut']()         — a typo that would otherwise pass
      if (
        ts.isElementAccessExpression(callee) &&
        onRunHandle(callee.expression, here, node.getStart(file))
      ) {
        const argument = callee.argumentExpression;
        if (ts.isStringLiteralLike(argument)) {
          members.add(argument.text);
        } else if (
          ts.isPropertyAccessExpression(argument) &&
          ts.isIdentifier(argument.expression) &&
          argument.expression.text === 'Symbol'
        ) {
          members.add(`[Symbol.${argument.name.text}]`);
        }
      }
    }

    ts.forEachChild(node, (child) => callPass(child, here));
  };
  callPass(file, [0]);
  for (const member of destructured) members.add(member);

  return members;
}

// ── Classification-table consistency ────────────────────────────────
//
// Fifteen review rounds found the same four defects in this table over and over:
// a durability cell stating "Durable" without the backing-store condition the
// vocabulary requires; a non-conformance recorded with no owning issue; an
// ownership value outside the declared vocabulary; and a cross-reference to a
// section that does not exist. Each was fixed by hand and then reappeared on the
// next row someone added.
//
// These checks turn all four into gates. A contract that states rules its own
// table can violate is not enforcing them.

interface ClassificationRow {
  readonly resource: string;
  readonly ownership: string;
  readonly execution: string;
  readonly durability: string;
  readonly identity: string;
  readonly locator: string;
  readonly owner: string;
}

function classificationRows(markdown: string): ClassificationRow[] {
  const start = markdown.indexOf('### Classification table');
  if (start < 0) throw new Error('classification table not found');
  const end = markdown.indexOf('\n### ', start + 1);
  const section = markdown.slice(start, end < 0 ? markdown.length : end);

  const rows: ClassificationRow[] = [];
  for (const line of section.split('\n')) {
    if (!line.startsWith('|')) continue;
    if (line.includes(':---')) continue;
    // A cell may contain an escaped pipe, as a TypeScript union in prose does:
    // `Promise<ScheduleSummary \\| null>`. Splitting on a raw pipe counted those
    // as separators, gave the row the wrong column count, and silently skipped
    // it — so a row could violate every gate below by containing a union type.
    const cells = line
      .replace(/\\\|/g, '\u0000')
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.replace(/\u0000/g, '\\|').trim());
    if (cells.length !== 7) continue;
    if (cells[0] === 'Resource') continue;
    rows.push({
      resource: cells[0] ?? '',
      ownership: cells[1] ?? '',
      execution: cells[2] ?? '',
      durability: cells[3] ?? '',
      identity: cells[4] ?? '',
      locator: cells[5] ?? '',
      owner: cells[6] ?? '',
    });
  }
  return rows;
}

/** GitHub-style heading slug, for checking in-document anchors. */
function slug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
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
      // Method form `snapshot(): T`, generic form `snapshot<T>()`, and
      // function-valued property form `snapshot: () => T`. Matching only the
      // first two meant an ordinary alternative signature under the exact
      // placeholder name left the entry green.
      new RegExp(`^\\s*(readonly\\s+)?${member}\\s*([(<]|:\\s*(\\(|async|function))`, 'm').test(
        source,
      ),
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

describe('documentation/operative-type-safe-api.md fences', () => {
  test('every fence parses as TypeScript', () => {
    // A fence that does not parse yields no members, so every accounting check
    // below it passes vacuously. Silence from a broken example is the failure
    // mode this catches.
    const broken: string[] = [];
    fences.forEach((fence, index) => {
      const file = ts.createSourceFile(
        `example-${index}.ts`,
        fence,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      const diagnostics = (file as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics;
      if (diagnostics && diagnostics.length > 0) broken.push(`fence ${index}`);
    });
    expect(broken).toEqual([]);
  });

  test('every required capability is exercised by an example', () => {
    // The map claims these are what the examples illustrate. An entry no
    // example calls is an owner tracked for nothing, and would survive its
    // implementation unnoticed.
    const invoked = new Set<string>();
    fences.forEach((fence, index) => {
      for (const member of runHandleCalls(fence, index)) invoked.add(member);
    });
    const unexercised = Object.keys(PENDING_IMPLEMENTATION).filter(
      (capability) => !invoked.has(capability),
    );
    expect(unexercised).toEqual([]);
  });
});

describe('documentation/operative-type-safe-api.md classification table', () => {
  const rows = classificationRows(document);

  test('the table is readable and non-trivial', () => {
    expect(rows.length).toBeGreaterThan(10);
  });

  test('every ownership value comes from the declared vocabulary', () => {
    // WorkOwnership is independent | parent-owned | inline. Detachment is a
    // separate boolean on the snapshot, and the Detachment section calls a
    // detached operation independently owned — so a cell whose ownership is
    // only "detached" cannot be translated into the required shape without
    // inventing a fourth value.
    const permitted = /independently owned|parent-owned|inline/i;
    const offenders = rows
      .filter((row) => !permitted.test(row.ownership))
      .map((row) => `${row.resource}: ${row.ownership}`);
    expect(offenders).toEqual([]);
  });

  test('no durability cell claims durability without its backing-store condition', () => {
    // The vocabulary states durability follows the ultimate backing store,
    // transitively. A cell asserting "Durable" with no condition is the mistake
    // that recurred on five separate rows.
    const conditional =
      /only when|conditional|persist|backing store|process-local|inherit|undeterminable|from the child|same condition|whatever the wrapped|follows the/i;
    // A cell that denies durability is not asserting it. "Drives durable work;
    // is not itself durable work" is the honest statement the gate should allow.
    const denies = /not itself durable|is not durable|never durable/i;
    const offenders = rows
      .filter(
        (row) =>
          /durable/i.test(row.durability) &&
          !denies.test(row.durability) &&
          !conditional.test(row.durability),
      )
      .map((row) => `${row.resource}: ${row.durability}`);
    expect(offenders).toEqual([]);
  });

  test('every declared non-conformance names an owning issue', () => {
    const offenders = rows
      .filter((row) => /non-conformance/i.test(`${row.locator} ${row.ownership} ${row.durability}`))
      .filter((row) => !/AB-\d+/.test(row.owner))
      .map((row) => row.resource);
    expect(offenders).toEqual([]);
  });

  test('every row names an owner or states why none is needed', () => {
    const offenders = rows
      .filter((row) => !/AB-\d+|unchanged|this amendment|not yet filed|settled/i.test(row.owner))
      .map((row) => `${row.resource}: ${row.owner}`);
    expect(offenders).toEqual([]);
  });
});

describe('documentation/operative-type-safe-api.md internal references', () => {
  test('every in-document anchor link resolves to a heading', () => {
    const headings = new Set(
      [...document.matchAll(/^#+\s+(.+)$/gm)].map((match) => slug(match[1] ?? '')),
    );
    const broken = [...document.matchAll(/\]\(#([a-z0-9-]+)\)/g)]
      .map((match) => match[1] ?? '')
      .filter((target) => !headings.has(target));
    expect([...new Set(broken)]).toEqual([]);
  });

  test('every required capability is described in the capabilities section', () => {
    const start = document.indexOf('### Required capabilities');
    expect(start).toBeGreaterThan(-1);
    const end = document.indexOf('\n### ', start + 1);
    const section = document.slice(start, end < 0 ? document.length : end);

    // Each pending capability must be recognisable in the section that ratifies
    // it, so the harness map and the contract cannot drift apart silently.
    const described: Record<string, RegExp> = {
      snapshot: /cached snapshot/i,
      subscribeSnapshot: /non-consuming state observation|state observation/i,
      children: /child discovery/i,
      abortChild: /scoped child cancellation/i,
      closed: /cleanup acknowledgement/i,
    };
    const missing = Object.keys(PENDING_IMPLEMENTATION).filter(
      (capability) => !described[capability]?.test(section),
    );
    expect(missing).toEqual([]);
  });
});
