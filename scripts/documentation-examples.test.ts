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
 * Which capability of the Required capabilities table each placeholder stands
 * for, so its owner can be compared against the contract rather than restated.
 */
const CAPABILITY_OF_MEMBER: Readonly<Record<string, string>> = {
  snapshot: 'Cached snapshot',
  subscribeSnapshot: 'Non-consuming state observation',
  children: 'Child discovery',
  abortChild: 'Scoped child cancellation',
  closed: 'Cleanup acknowledgement',
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

/**
 * The type whose surface this harness checks against.
 *
 * `DiagnosticAgentRun` is deliberately excluded. It declares a different surface
 * — no `unwrap()`, no `output()`, by design rather than by omission — so
 * admitting it here would check its examples against the wrong contract, the
 * same mistake that made an earlier revision reject `createAgentEvaluation`.
 */
const RUN_HANDLE_TYPE = 'AgentRun';

/**
 * Annotations that make a binding a receiver whose `.run()` yields a handle.
 *
 * The mirror of `RUN_HANDLE_TYPE`. A fence that factors a run through
 * `function fire(office: Bureau)` recorded `office` as neither agent nor
 * bureau, so a typo on its run's result went unchecked — the same miss typed
 * `AgentRun` parameters had, one step earlier in the chain.
 */
const BUREAU_TYPE = 'Bureau';
const AGENT_TYPE = 'RunnableAgent';

/**
 * The packages that provide this contract, by their real published names.
 *
 * A name is not a factory on its own. `import { createAgent } from
 * 'evaluation-kit'` is some other library's function that happens to agree on
 * a spelling, and treating it as ours rejected the legitimate members of
 * whatever *it* returns — a false failure on correct documentation.
 */
const CONTRACT_MODULES = new Set(['@lostgradient/operative', 'bureau']);

/**
 * Supertypes the contract inherits from without declaring, and the members they
 * contribute.
 *
 * `RunOutcomeBase extends AsyncIterable<RunEvent>`, so `run[Symbol.asyncIterator]()`
 * is a real member of the documented surface that no fence declares. Skipping
 * heritage altogether rejected it — a false failure on a correct example — and
 * resolving heritage without this map would instead throw on a global type. A
 * Map rather than an object literal: `AMBIENT['constructor']` on an object
 * resolves through the prototype chain to a truthy value.
 */
const AMBIENT_SUPERTYPE_MEMBERS = new Map<string, readonly string[]>([
  ['AsyncIterable', ['[Symbol.asyncIterator]']],
  ['Iterable', ['[Symbol.iterator]']],
  ['Disposable', ['[Symbol.dispose]']],
  ['AsyncDisposable', ['[Symbol.asyncDispose]']],
]);

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

/**
 * The run-handle surface, resolved from the contract's own declarations.
 *
 * Earlier revisions scanned `interface RunOutcomeBase` for members and then
 * listed `output`, `abort`, and `[Symbol.dispose]` as string literals beside it.
 * Those literals vouched for members independently of the document, so deleting
 * `OutputMethod.output()` from the contract would leave `run.output()` in an
 * example still accepted — the exact drift this harness exists to catch, hidden
 * by the harness itself.
 *
 * The alias is resolved instead: its intersection is walked and every
 * constituent looked up as an interface, another alias, or an inline object
 * type, so the accepted surface is exactly what the document declares. A
 * constituent the document references but no longer declares raises rather than
 * silently shrinking the surface, because a smaller surface fails open.
 */
function declaredRunSurface(sources: readonly string[]): Set<string> {
  const interfaces = new Map<string, ts.InterfaceDeclaration[]>();
  const aliases = new Map<string, ts.TypeAliasDeclaration>();

  sources.forEach((source, index) => {
    const file = ts.createSourceFile(
      `surface-${index}.ts`,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const collect = (node: ts.Node): void => {
      // Two fences declaring the same interface both count, the way TypeScript
      // merges declarations and the way the earlier text scan read every block.
      if (ts.isInterfaceDeclaration(node)) {
        const existing = interfaces.get(node.name.text);
        if (existing) existing.push(node);
        else interfaces.set(node.name.text, [node]);
      }
      if (ts.isTypeAliasDeclaration(node)) {
        // Last-wins let any later fence replace the normative declaration: an
        // illustrative `type AgentRun` carrying a misspelled member would make
        // that misspelling the checked surface. A type alias cannot be declared
        // twice in one scope, so a second one is an error, not a redefinition.
        // Interfaces above are unioned instead, which is how they merge.
        if (aliases.has(node.name.text)) {
          throw new Error(
            `${node.name.text} is declared more than once across the contract's fences`,
          );
        }
        aliases.set(node.name.text, node);
      }
      ts.forEachChild(node, collect);
    };
    collect(file);
  });

  const surface = new Set<string>();
  const resolved = new Set<string>();

  const addMembers = (members: ts.NodeArray<ts.TypeElement>): void => {
    for (const member of members) {
      const name = member.name;
      if (name === undefined) continue;
      if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) surface.add(name.text);
      // Spelled the way element-access collection records `run[Symbol.dispose]()`.
      else if (ts.isComputedPropertyName(name)) surface.add(`[${name.expression.getText()}]`);
    }
  };

  const visit = (node: ts.TypeNode | undefined): void => {
    if (node === undefined) return;
    if (ts.isParenthesizedTypeNode(node)) return visit(node.type);
    if (ts.isTypeLiteralNode(node)) return addMembers(node.members);
    if (ts.isIntersectionTypeNode(node) || ts.isUnionTypeNode(node)) {
      for (const constituent of node.types) visit(constituent);
      return;
    }
    // Both branches of a conditional belong to the surface, for different
    // instantiations: `OutputMethod` yields `output()` for an agent with an
    // output schema and `{}` for one without.
    if (ts.isConditionalTypeNode(node)) {
      visit(node.trueType);
      visit(node.falseType);
      return;
    }
    if (!ts.isTypeReferenceNode(node) || !ts.isIdentifier(node.typeName)) return;
    visitName(node.typeName.text);
  };

  const visitName = (name: string): void => {
    if (resolved.has(name)) return;
    resolved.add(name);

    const declarations = interfaces.get(name);
    if (declarations) {
      for (const declaration of declarations) {
        addMembers(declaration.members);
        // An inherited member is still a member an example may legitimately
        // call, so heritage is followed rather than stopped at.
        for (const clause of declaration.heritageClauses ?? []) {
          for (const base of clause.types) {
            if (ts.isIdentifier(base.expression)) visitName(base.expression.text);
          }
        }
      }
      return;
    }

    const alias = aliases.get(name);
    if (alias) return visit(alias.type);

    const ambient = AMBIENT_SUPERTYPE_MEMBERS.get(name);
    if (ambient) {
      for (const member of ambient) surface.add(member);
      return;
    }

    throw new Error(
      `${name} is reachable from ${RUN_HANDLE_TYPE} but neither the contract nor the ambient supertype map declares it`,
    );
  };

  const root = aliases.get(RUN_HANDLE_TYPE);
  if (root === undefined) throw new Error(`${RUN_HANDLE_TYPE} is not declared in the contract`);
  visit(root.type);
  return surface;
}

/** True when a call expression produces a run handle. */
function isRunProducer(node: ts.Node, isReceiver: (receiver: ts.Expression) => boolean): boolean {
  if (!ts.isCallExpression(node)) return false;
  const callee = unwrap(node.expression);

  // Both spellings start a run, and only the first was recognised:
  //   bureau.run(...)      — the ordinary form
  //   bureau['run'](...)   — the same call, so a typo on its result must fail
  let receiver: ts.Expression | undefined;
  if (ts.isPropertyAccessExpression(callee) && callee.name.text === RUN_PRODUCER_METHOD) {
    receiver = callee.expression;
  } else if (
    ts.isElementAccessExpression(callee) &&
    ts.isStringLiteralLike(callee.argumentExpression) &&
    callee.argumentExpression.text === RUN_PRODUCER_METHOD
  ) {
    receiver = callee.expression;
  }
  if (receiver === undefined) return false;

  // The receiver is an expression rather than a name, so a factory call used
  // directly as one — `createAgent(...).run('q')` — is not invisible.
  return isReceiver(unwrap(receiver));
}

/**
 * Every name a binding introduces, including through object and array patterns.
 *
 * `{ bureau }`, `[first, ...rest]`, and nested combinations all bind names that
 * shadow outer ones. A rest element and a defaulted element bind as well.
 */
function boundNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  const names: string[] = [];
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    names.push(...boundNames(element.name));
  }
  return names;
}

/**
 * Whether an annotation makes the thing it annotates a run handle.
 *
 * Exactly `AgentRun`, including its generic instantiations. A substring match on
 * the annotation text would also claim `Promise<AgentRun>` and `AgentRun[]` and
 * then reject their legitimate members — a false failure on correct
 * documentation, which is worse than the miss it fixes.
 *
 * Recording every parameter as definitively not-a-handle was that miss: a fence
 * factoring handle use into a typed helper went entirely unchecked, so
 * `function inspect(run: AgentRun) { run.reslut(); }` passed.
 */
function isNamedType(annotation: ts.TypeNode | undefined, name: string): boolean {
  if (annotation === undefined) return false;
  const node = ts.isParenthesizedTypeNode(annotation) ? annotation.type : annotation;
  return (
    ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && node.typeName.text === name
  );
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

  // What each local name actually imports. Matching the local spelling alone
  // meant an aliased import was not recognised as a factory, so its `.run()`
  // produced nothing to check and a typo on the result passed.
  const importedAs = new Map<string, string>();
  const namespaceImports = new Set<string>();
  const collectImports = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && node.importClause) {
      const clause = node.importClause;
      // Only a package that actually provides this contract can contribute a
      // factory. An import from anywhere else binds the name to something the
      // sets must not claim, so it resolves to nothing they recognise.
      const specifier = ts.isStringLiteralLike(node.moduleSpecifier)
        ? node.moduleSpecifier.text
        : '';
      const foreign = !CONTRACT_MODULES.has(specifier);
      // A default import is not any of these factories either, and recording it
      // as `default` says so rather than letting its local spelling stand in.
      if (clause.name) importedAs.set(clause.name.text, 'default');
      if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        if (!foreign) namespaceImports.add(clause.namedBindings.name.text);
        else importedAs.set(clause.namedBindings.name.text, 'foreign');
      }
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          const imported = (element.propertyName ?? element.name).text;
          importedAs.set(element.name.text, foreign ? 'foreign' : imported);
        }
      }
    }
    ts.forEachChild(node, collectImports);
  };
  collectImports(file);

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
   * Whether this receiver's `.run()` yields a handle.
   *
   * A resolved binding wins over the conventional spelling, so an inner
   * `const bureau = helper()` shadows the outer one and its `.run()` is no
   * longer treated as producing a handle. The bare name is honoured only when
   * the fence never binds it, which is the fragment case these examples use.
   */
  const isRunReceiver = (receiver: ts.Expression, chain: number[], pos: number): boolean => {
    // An unnamed receiver: `createAgent({ ... }).run('q').result()`.
    if (factoryCall(receiver, AGENT_FACTORIES, chain, pos)) return true;
    if (factoryCall(receiver, BUREAU_FACTORIES, chain, pos)) return true;
    if (!ts.isIdentifier(receiver)) return false;
    const state = lookup(chain, receiver.text, pos);
    if (state) return state.agent || state.bureau;
    return receiver.text === CONVENTIONAL_RUN_RECEIVER;
  };

  const producesHandle = (expression: ts.Expression, chain: number[], pos: number): boolean => {
    const value = unwrap(expression);
    if (isRunProducer(value, (candidate) => isRunReceiver(candidate, chain, pos))) return true;
    return ts.isIdentifier(value) && lookup(chain, value.text, pos)?.handle === true;
  };

  const factoryCall = (
    expression: ts.Expression,
    factories: ReadonlySet<string>,
    chain: number[],
    pos: number,
  ): boolean => {
    const value = unwrap(expression);
    if (!ts.isCallExpression(value)) return false;
    const callee = unwrap(value.expression);

    // `agents.createBureau(...)` through `import * as agents`, unless the fence
    // rebound the namespace name to something of its own.
    if (
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      namespaceImports.has(callee.expression.text) &&
      lookup(chain, callee.expression.text, pos) === undefined
    ) {
      return factories.has(callee.name.text);
    }

    if (!ts.isIdentifier(callee)) return false;
    // Spelling is not identity, in both directions. A fence may shadow
    // `createAgent` with its own local, parameter, or function declaration, and
    // that name then returns something unrelated — so a binding in force means
    // this is not the import. And `import { createBureau as makeBureau }` is
    // the factory under a name the sets have never heard of, so the local name
    // resolves to what it actually imports before being matched.
    if (lookup(chain, callee.text, pos) !== undefined) return false;
    return factories.has(importedAs.get(callee.text) ?? callee.text);
  };

  /** Whether this initialiser makes the binding an agent, whose .run() yields a handle. */
  const producesAgent = (expression: ts.Expression, chain: number[], pos: number): boolean => {
    if (factoryCall(expression, AGENT_FACTORIES, chain, pos)) return true;
    // An alias carries it: `const a = researcher; a.run(...)`.
    const value = unwrap(expression);
    return ts.isIdentifier(value) && lookup(chain, value.text, pos)?.agent === true;
  };

  /** Whether this initialiser makes the binding a bureau. */
  const producesBureau = (expression: ts.Expression, chain: number[], pos: number): boolean => {
    if (factoryCall(expression, BUREAU_FACTORIES, chain, pos)) return true;
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
          // A binding pattern introduces names as surely as an identifier does.
          // Recording only the identifier form meant `function inspect({ bureau })`
          // left `bureau` unbound, so the conventional-receiver fallback claimed
          // it and rejected the members of whatever its `.run()` returned — a
          // false failure on correct documentation.
          const named = ts.isIdentifier(parameter.name);
          for (const bound of boundNames(parameter.name)) {
            record(here[here.length - 1] ?? 0, bound, {
              pos: parameter.getStart(file),
              handle: named && isNamedType(parameter.type, RUN_HANDLE_TYPE),
              agent: named && isNamedType(parameter.type, AGENT_TYPE),
              bureau: named && isNamedType(parameter.type, BUREAU_TYPE),
            });
          }
        }
      }
    }

    // A function declaration binds its name in the scope it sits in, not the one
    // it opens, and hoists to the top of that scope. Recording only variables,
    // assignments, and parameters meant a fence shadowing a factory this way —
    // `function createAgent() { ... }` — still resolved the name to the import.
    //
    // Only a fence-local implementation shadows: it has a body and is not
    // exported. This document declares the real factories in their own fences
    // — `createAgent`'s two overload signatures and
    // `export declare function createBureau` — and those declare that very
    // function rather than a different one sharing its name. Treating them as
    // shadows would stop tracking any example added to those fences, which is
    // the silent-miss failure this whole resolver exists to avoid.
    const exported = (declaration: ts.FunctionDeclaration): boolean =>
      declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ===
      true;
    if (ts.isFunctionDeclaration(node) && node.name && node.body && !exported(node)) {
      record(chain[chain.length - 1] ?? 0, node.name.text, {
        pos: 0,
        handle: false,
        agent: false,
        bureau: false,
      });
    }

    // I fixed this for parameters and left declarations identifier-only, so
    // `const { bureau } = evaluationKit` recorded nothing and the conventional
    // fallback claimed the shadowing local — a false failure on correct code.
    // A destructured initialiser cannot be proven to hold a producer, so these
    // bind as ordinary names: a miss is survivable, a false failure is not.
    if (ts.isVariableDeclaration(node) && !ts.isIdentifier(node.name)) {
      for (const bound of boundNames(node.name)) {
        record(here[here.length - 1] ?? 0, bound, {
          pos: node.getStart(file),
          handle: false,
          agent: false,
          bureau: false,
        });
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
        // `const { 'reslut': value } = bureau.run(...)` names the member with a
        // string literal, exactly as `run['reslut']()` does. The element-access
        // collector already handled that spelling; this one did not.
        if (ts.isIdentifier(property) || ts.isStringLiteralLike(property)) {
          destructured.add(property.text);
        }
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
    if (isRunProducer(target, (candidate) => isRunReceiver(candidate, chain, pos))) return true;
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

/**
 * Table lines the row parser could not read.
 *
 * A row with a missing cell or an accidentally unescaped pipe was silently
 * dropped, and every gate below then passed without examining that resource at
 * all while the row-count assertion stayed satisfied by the rest of the table.
 * Silence from an unparsed row is the same vacuous pass as silence from an
 * unparsed fence.
 */
function malformedClassificationRows(markdown: string): string[] {
  const start = markdown.indexOf('### Classification table');
  if (start < 0) throw new Error('classification table not found');
  const end = markdown.indexOf('\n### ', start + 1);
  const section = markdown.slice(start, end < 0 ? markdown.length : end);

  const malformed: string[] = [];
  for (const line of section.split('\n')) {
    if (!line.startsWith('|')) continue;
    if (line.includes(':---')) continue;
    const cells = line.replace(/\\\|/g, '\u0000').split('|').slice(1, -1);
    if (cells.length !== 7) malformed.push(`${cells.length} cells: ${line.slice(0, 90)}`);
  }
  return malformed;
}

/** Every classification cell of a row, so a gate cannot check only some of them. */
function cellsOf(row: ClassificationRow): string[] {
  return [row.resource, row.ownership, row.execution, row.durability, row.identity, row.locator];
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
 * earlier spike shape; the ratified one is this document's, implemented in
 * `agent-run.ts`.
 */
const documentedMembers = declaredRunSurface(fences);

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
      // Method form `snapshot(): T`, generic form `snapshot<T>()`,
      // function-valued property form `snapshot: () => T`, and accessor form
      // `get snapshot(): T`. Each was added after a review round found the
      // previous set let a real implementation keep its exemption.
      new RegExp(
        `^\\s*(?:readonly\\s+|get\\s+|set\\s+|static\\s+)*${member}\\s*([(<]|:\\s*(\\(|async|function))`,
        'm',
      ).test(source),
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

  test('every required capability names the issue the contract assigns it', () => {
    // Checking the identifier's *shape* let the harness and the contract
    // disagree about substance: reassigning `snapshot` to AB-99 stayed green
    // while the Required capabilities table still said AB-88. The owner is now
    // compared against the table row this capability corresponds to, so the two
    // cannot drift apart silently.
    const owners = requiredCapabilityOwners(document);
    for (const [member, owner] of Object.entries(PENDING_IMPLEMENTATION)) {
      expect(owner, `${member} must name an owning issue`).toMatch(/^AB-\d+$/);
      const capability = CAPABILITY_OF_MEMBER[member];
      expect(capability, `${member} must correspond to a declared capability`).toBeDefined();
      expect(owner, `${member} must be owned by whoever owns "${capability}"`).toBe(
        owners(capability ?? ''),
      );
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

/**
 * Capability to owning issue, read from the Required capabilities table.
 *
 * Restating this map in the harness would let the two disagree, which is the
 * class of defect the table exists to prevent.
 */
function requiredCapabilityOwners(markdown: string): (capability: string) => string {
  const start = markdown.indexOf('### Required capabilities');
  if (start < 0) throw new Error('required capabilities section not found');
  const end = markdown.indexOf('\n### ', start + 1);
  const section = markdown.slice(start, end < 0 ? markdown.length : end);

  const owners = new Map<string, string>();
  for (const line of section.split('\n')) {
    if (!line.startsWith('|') || line.includes(':---')) continue;
    const cells = line
      .replace(/\\\|/g, '\u0000')
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.replace(/\u0000/g, '\\|').trim());
    const capability = cells[0];
    const owner = cells[cells.length - 1];
    if (!capability || !owner || !/^AB-\d+$/.test(owner)) continue;
    owners.set(capability, owner);
  }

  return (capability: string): string => {
    const owner = owners.get(capability);
    if (!owner) throw new Error(`Required capabilities declares no owner for "${capability}"`);
    return owner;
  };
}

/** Every capability the Required capabilities table declares, in its own words. */
function requiredCapabilityNames(markdown: string): string[] {
  const start = markdown.indexOf('### Required capabilities');
  if (start < 0) throw new Error('required capabilities section not found');
  const end = markdown.indexOf('\n### ', start + 1);
  const section = markdown.slice(start, end < 0 ? markdown.length : end);

  const names: string[] = [];
  for (const line of section.split('\n')) {
    if (!line.startsWith('|') || line.includes(':---')) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    const capability = cells[0];
    const owner = cells[cells.length - 1];
    if (!capability || !owner || !/^AB-\d+$/.test(owner)) continue;
    names.push(capability);
  }
  return names;
}

/** The issue the unowned-background-work rule assigns to one half of the split. */
function ruleOwner(markdown: string, half: string): string {
  const match = new RegExp(`\\*\\*(AB-\\d+) owns ${half}\\*\\*`).exec(markdown);
  if (!match?.[1]) {
    throw new Error(`the unowned-background-work rule no longer assigns an owner for "${half}"`);
  }
  return match[1];
}

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
    //
    // Presence of a permitted phrase is not enough on its own. A cell reading
    // "Independently owned when constructed directly; Bureau-owned when Bureau
    // starts it" passed on its first clause while its second named an ownership
    // value that does not exist. So the permitted phrases are removed and any
    // remaining claim of ownership in the residue is a coinage — which catches
    // the next one too, however it is spelled.
    const permitted = 'independently owned|parent-owned|inline';
    const offenders = rows
      .filter(
        (row) =>
          !new RegExp(permitted, 'i').test(row.ownership) ||
          /\bowned\b/i.test(row.ownership.replace(new RegExp(permitted, 'gi'), '')),
      )
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
    // Every cell, not three of them. A row declaring its non-conformance in the
    // identity or execution-mode cell was never examined, so a generic owner
    // like "this amendment" satisfied the check below it and the defect stayed
    // unassigned — the gate claimed more than it checked.
    const offenders = rows
      .filter((row) => /non-conformance/i.test(cellsOf(row).join(' ')))
      .filter((row) => !/AB-\d+/.test(row.owner))
      .map((row) => row.resource);
    expect(offenders).toEqual([]);
  });

  test('every gap a row records names the issue that owns that capability', () => {
    // THE DEFECT THIS ENDS. Five rows were corrected by hand across three review
    // rounds for one thing: the row records a multi-part gap and names a single
    // owner, so the named issue can close while the rest of the declared
    // non-conformance stays unowned. Restating the split in prose did not stop
    // it recurring on the next row, which is what a gate is for.
    //
    // Owners are read from the document's own Required capabilities table and
    // from the unowned-background-work rule, never restated here, so the mapping
    // cannot drift from the contract.
    //
    // KNOWN LIMIT, stated rather than overclaimed: this recognises the table's
    // established vocabulary for recording an absent capability, listed below in
    // one place. A row inventing a new phrasing for the same gap is not caught.
    // That is the cost of gap prose rather than a structured column, and the
    // vocabulary is centralised so extending it is a one-line change.
    const capabilityOwners = requiredCapabilityOwners(document);
    const shutdownOwner = ruleOwner(document, 'the awaitable shutdown');
    const identityOwner = ruleOwner(document, 'identity and the observation surface');

    const gaps: ReadonlyArray<{ readonly absent: RegExp; readonly owner: string }> = [
      {
        absent: /no (cached )?snapshot|required snapshot/i,
        owner: capabilityOwners('Cached snapshot'),
      },
      {
        absent: /no (state )?observation|no inspection|nothing observes|no caller can inspect/i,
        owner: capabilityOwners('Non-consuming state observation'),
      },
      { absent: /no child discovery/i, owner: capabilityOwners('Child discovery') },
      {
        absent: /cleanup acknowledgement|cleanup-acknowledgement|cleanup confirmed/i,
        owner: capabilityOwners('Cleanup acknowledgement'),
      },
      { absent: /no awaitable shutdown|nothing can await or cancel/i, owner: shutdownOwner },
      { absent: /no identity|no identifier|none of its own/i, owner: identityOwner },
    ];

    const offenders: string[] = [];
    for (const row of rows) {
      // Scoped to rows that declare a non-conformance. A row recording a
      // limitation it is not calling a breach — an inline operation with
      // nothing to reattach to — is classified, not owed a capability owner.
      const text = cellsOf(row).join(' ');
      if (!/non-conformance/i.test(text)) continue;
      for (const gap of gaps) {
        if (!gap.absent.test(text)) continue;
        if (row.owner.includes(gap.owner)) continue;
        const complaint = `${row.resource}: records a gap owned by ${gap.owner}, which its owner cell does not name`;
        if (!offenders.includes(complaint)) offenders.push(complaint);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('a row whose locator is a live handle accounts for every required capability', () => {
    // A live handle for independently owned work owes the whole capability set,
    // so a row documenting one must say where each capability stands. Review
    // found these one at a time — the diagnostic handle, then the flagship
    // `AgentRun` — which is the shape of a missing gate, not a missing sentence.
    //
    // Scoped to handle-bearing rows deliberately, and the scope was measured
    // rather than guessed. Requiring every independently owned row to recite all
    // five would have flagged twelve of twelve, most of them vacuously: a
    // heartbeat loop has no children to discover, and a gate that forces
    // boilerplate teaches people to write boilerplate.
    const mentions: ReadonlyArray<readonly [string, RegExp]> = [
      ['Cached snapshot', /snapshot/i],
      ['Non-consuming state observation', /observ|inspect/i],
      ['Child discovery', /child discovery|children/i],
      ['Scoped child cancellation', /scoped child cancellation|abortChild/i],
      ['Cleanup acknowledgement', /cleanup/i],
    ];

    // Adding a capability to the contract without teaching this gate to
    // recognise it would silently narrow what the gate checks.
    expect([...mentions.map(([name]) => name)].sort()).toEqual(
      requiredCapabilityNames(document).sort(),
    );

    const offenders: string[] = [];
    for (const row of rows) {
      const text = cellsOf(row).join(' ');
      if (!/non-conformance/i.test(text)) continue;
      if (!/independently owned/i.test(row.ownership)) continue;
      if (!/Live `|\bhandle\b/i.test(row.locator)) continue;
      for (const [capability, mentioned] of mentions) {
        if (mentioned.test(text)) continue;
        offenders.push(`${row.resource}: says nothing about "${capability}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('every table row parses into the seven classification columns', () => {
    // Without this the row parser's `continue` was a silent exemption: a row
    // that failed to parse escaped every check below while the table still
    // looked full.
    expect(malformedClassificationRows(document)).toEqual([]);
  });

  test('no resource is classified twice', () => {
    // The section promises every resource is "classified once". Two rows for one
    // resource are validated independently, so contradictory ownership,
    // durability, or owners would all pass while the contract said two things.
    const seen = new Set<string>();
    const duplicated = rows
      .map((row) => row.resource)
      .filter((resource) => {
        if (seen.has(resource)) return true;
        seen.add(resource);
        return false;
      });
    expect(duplicated).toEqual([]);
  });

  test('no row conditions an owner on an open question', () => {
    // "AB-88 if these writes should become inspectable" reads as ownership and
    // is not: it defers the decision that assigning an owner is supposed to
    // settle, and it satisfies every other check on this table. A row either
    // names the issue that owns the gap or does not record the gap.
    const offenders = rows
      .filter((row) => /\bAB-\d+\s+(if|unless|should|might|may|perhaps)\b/i.test(row.owner))
      .map((row) => `${row.resource}: ${row.owner}`);
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
