import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, test } from 'bun:test';

/**
 * AB-34's fourth verification command.
 *
 * `documentation/operative-type-safe-api.md` is a contract document: its fenced
 * examples are the normative illustration of the typed Agent and Bureau API, and
 * AB-15 shipped it with no mechanism to check that they stay true. A renamed
 * method or a typo in an example is invisible until a reader copies it.
 *
 * Full type-checking of the fences is not possible, and not merely because it is
 * awkward. The examples are deliberately fragments — they call `bureau` and `run`
 * without declaring them — so no fence is a standalone module. More importantly,
 * AB-34 documents contract members that are ratified but not yet implemented:
 * `snapshot()`/`subscribeSnapshot()` belong to AB-88 and `children()`/`abortChild()`
 * to AB-50. Type-checking would fail against today's source by design.
 *
 * So this harness checks what is both checkable and actually at risk: every member
 * an example invokes on a run handle is either declared by this contract document
 * itself, or listed below as a required capability with the issue that owns its
 * signature. Both directions are asserted, so an entry cannot outlive its
 * implementation and a new example cannot reference a capability nobody owns.
 *
 * AB-34 was re-scoped after three review rounds: it states the capabilities every
 * independently owned handle must provide and leaves the signatures to AB-88,
 * AB-50, and AB-37. So the map below is no longer "declared here, unimplemented"
 * — it is "required here, declared by that issue". The examples use placeholder
 * names; the owning issue picks the real one. What this harness still guarantees
 * is that no capability appears in an example without a named owner.
 *
 * Members are matched against declared interface members rather than by grepping
 * whole files. An earlier draft of this harness grepped, and reported
 * `subscribe` as already shipped because `Bureau` has an unrelated event
 * subscription of that name — a false positive that would have hidden the real
 * finding: `ActiveRun.subscribe` already means event subscription in this same
 * package, which is why AB-34's snapshot notifier is named `subscribeSnapshot`.
 */

const repositoryRoot = resolve(import.meta.dir, '..');
const documentPath = resolve(repositoryRoot, 'documentation/operative-type-safe-api.md');
const agentRunPath = resolve(repositoryRoot, 'packages/operative/src/agent-run.ts');

/**
 * Capabilities this contract requires, each naming the issue that owns declaring
 * and implementing the signature. When that issue lands, its entry must be
 * removed — the "quietly implemented" test below fails if an implemented member
 * is still listed, so this cannot rot into a permanent excuse list.
 *
 * The key is the placeholder name used in the illustrative examples. The owning
 * issue may choose a different one; when it does, this map and the examples move
 * together, and the test that every invoked member is accounted for is what
 * forces that.
 */
const PENDING_IMPLEMENTATION: Readonly<Record<string, string>> = {
  snapshot: 'AB-88',
  subscribeSnapshot: 'AB-88',
  children: 'AB-50',
  abortChild: 'AB-50',
  closed: 'AB-37',
};

/** Calls in the examples that are not run-handle members. */
const NOT_RUN_HANDLE_MEMBERS = new Set([
  'log',
  'run',
  'createSchedule',
  'abortRun',
  'getRun',
  'listRuns',
  'toISOString',
  'unsubscribe',
]);

function read(path: string): string {
  return readFileSync(path, 'utf-8');
}

/**
 * Members declared across *every* block declaring the named interface.
 *
 * This document declares `RunOutcomeBase` twice on purpose: once as AB-15
 * shipped it, and again in the AB-34 amendment that adds to it. Reading only the
 * first occurrence made the harness self-defeating — the amendment's members
 * passed solely because pending entries are checked first, so the moment AB-88
 * shipped `snapshot()` the stale-pending test would demand its removal and the
 * example call would immediately become unaccounted. The harness could not have
 * survived the implementation it exists to track.
 */
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
 * Variables a fence initialises from a run-producing call.
 *
 * An earlier version matched a hard-coded list of identifier names, which meant
 * `const draft = bureau.run(...)` was invisible and a typo on it would pass. The
 * binding name carries no meaning; what makes a variable a run handle is what it
 * was assigned from.
 */
function runHandleBindings(source: string): Set<string> {
  const names = new Set<string>();
  // `const x = bureau.run(...)`, `const x = await agent.run(...)`, `const x = createRun(...)`
  const pattern =
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:[A-Za-z_$][\w$]*\.)?(?:run|createRun|createActiveRun|getRun)\s*\(/g;
  let match = pattern.exec(source);
  while (match !== null) {
    if (match[1] !== undefined) names.add(match[1]);
    match = pattern.exec(source);
  }
  return names;
}

/** Members invoked on any variable that holds a run handle. */
function runHandleCalls(source: string): Set<string> {
  const bindings = runHandleBindings(source);
  // Names conventionally used for a run handle even where the assignment is
  // elided in a fragment.
  for (const conventional of ['run', 'parentRun', 'activeRun', 'childRun']) {
    bindings.add(conventional);
  }

  const members = new Set<string>();
  const record = (name: string | undefined): void => {
    if (name !== undefined && !NOT_RUN_HANDLE_MEMBERS.has(name)) members.add(name);
  };

  for (const binding of bindings) {
    const pattern = new RegExp(`\\b${binding}\\.([A-Za-z_$][\\w$]*)\\s*\\(`, 'g');
    let match = pattern.exec(source);
    while (match !== null) {
      record(match[1]);
      match = pattern.exec(source);
    }
  }

  // Calls chained straight off a run producer, which never create a binding:
  //   await bureau.run('writer', '...').unwrap()
  // Without this, such a call is invoked on a run handle but invisible to the
  // binding scan, so a typo in it would pass a test that claims to account for
  // every run-handle member the examples invoke.
  const chained =
    /(?:[A-Za-z_$][\w$]*\.)?(?:run|createRun|createActiveRun|getRun)\s*\([^)]*\)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g;
  let chainMatch = chained.exec(source);
  while (chainMatch !== null) {
    record(chainMatch[1]);
    chainMatch = chained.exec(source);
  }

  return members;
}

const document = read(documentPath);
const fences = typescriptFences(document);

/**
 * The contract's own declared surface, taken from the document rather than from
 * a source file. `bureau-types.ts` also declares an `AgentRun`, but that is the
 * earlier spike shape (`result`/`abort`/dispose only); the ratified one is this
 * document's `RunOutcomeBase` plus the AB-34 additions, implemented in
 * `agent-run.ts`. Reading the document keeps this check about whether the
 * examples match the contract they illustrate.
 */
const documentedMembers = new Set<string>([
  ...declaredMembers(document, 'RunOutcomeBase'),
  'output',
  'abort',
]);

describe('documentation/operative-type-safe-api.md examples', () => {
  test('the document contains fenced TypeScript examples to check', () => {
    expect(fences.length).toBeGreaterThan(0);
  });

  test('the documented run-handle surface is readable', () => {
    expect([...documentedMembers].sort()).toContain('result');
    expect([...documentedMembers].sort()).toContain('unwrap');
  });

  test('every run-handle member an example invokes is shipped or explicitly pending', () => {
    const unaccounted = new Set<string>();
    for (const fence of fences) {
      for (const member of runHandleCalls(fence)) {
        if (member in PENDING_IMPLEMENTATION) continue;
        if (documentedMembers.has(member)) continue;
        unaccounted.add(member);
      }
    }

    // A failure means an example calls something that neither exists nor has an
    // owner. Either the example is wrong, or the member needs a
    // PENDING_IMPLEMENTATION entry naming the issue that will deliver it.
    expect([...unaccounted].sort()).toEqual([]);
  });

  test('no pending member has quietly been implemented', () => {
    const source = read(agentRunPath);
    const stale = Object.keys(PENDING_IMPLEMENTATION).filter((member) =>
      new RegExp(`^\\s*${member}\\s*[(<]`, 'm').test(source),
    );

    // A failure here is good news needing action: the owning issue landed, so
    // drop the entry and let the member be checked as shipped surface.
    expect(stale).toEqual([]);
  });

  test('every pending member names the issue that owns it', () => {
    for (const [member, owner] of Object.entries(PENDING_IMPLEMENTATION)) {
      expect(owner, `${member} must name an owning issue`).toMatch(/^AB-\d+$/);
    }
  });

  test('the snapshot notifier is not named subscribe, which already means events', () => {
    // ActiveRun.subscribe and Bureau.subscribe are event subscriptions. A
    // snapshot notifier called `subscribe` on a sibling run handle would read as
    // the same thing and mean something else.
    expect(PENDING_IMPLEMENTATION).not.toHaveProperty('subscribe');
    expect(document).not.toContain('run.subscribe(');
  });

  test('the started-work control contract section is present', () => {
    expect(document).toContain('## Started-work control contract');
    expect(document).toContain('### Classification table');
  });
});
