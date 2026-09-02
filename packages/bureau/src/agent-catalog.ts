/**
 * The unified typed agent catalog (AB-15, AB-22).
 *
 * `AgentDefinitions` replaces the synchronous builder's registry: a plain
 * literal object passed to `createBureau({ agents })`, fixed for the
 * bureau's lifetime. `BureauAgentCatalog` is the read-only, immutable view
 * `bureau.agents` exposes over it — `get`/`find`/`has`/`names`/`entries`/
 * `query`, and nothing that mutates.
 */

import type { RunnableAgent } from '@lostgradient/operative';

/**
 * A plain literal map of agent name to `RunnableAgent`. There is no
 * constructor, no `.register()`/`.unregister()` lifecycle, and no event
 * stream for registration changes — the map is fixed at `createBureau(...)`
 * call time. The value bound is a two-member union —
 * `RunnableAgent<never, false> | RunnableAgent<any, true>` — covering the
 * "no output schema" shape and the "has some output schema" shape
 * separately, rather than one instantiation of `RunnableAgent<O, H>`. No
 * single concrete `(O, H)` pair works: `AgentRun<O, H>.unwrap()`'s return
 * type is `[H] extends [true] ? O : string`, and a real `StandaloneAgent`
 * (createAgent's return type, structurally similar to but nominally
 * distinct from `RunnableAgent`) forces that conditional to fully expand
 * during the structural check — `<never, boolean>` fits every no-schema
 * agent but rejects every schema'd one (schema'd `unwrap()` returns the
 * schema type, not `string`); `<any, boolean>`/`<any, any>` do the reverse
 * or fail outright, because a concrete (non-generic-parameter) `H`
 * deterministically picks ONE conditional branch — `boolean` picks false,
 * and `any` picks true (`[any] extends [true]` resolves the true branch
 * here, not a union of both, unlike a bare `Cond<any>` reference checked in
 * isolation). Two exact-shape union members sidestep the conditional
 * entirely: each member matches one shape outright, and `any` in the second
 * member's `O` slot only needs to absorb the OUTPUT type (which `unwrap()`
 * returns) once `H` is already the concrete literal `true` picking that
 * branch. `AgentOutput`/`AgentHasOutput` below infer from each entry's OWN
 * concrete type (`D[TName]`), not from this bound, so lookups through the
 * catalog stay precisely typed regardless of this union's own imprecision.
 */
export type AgentDefinitions = Record<
  string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- required for the has-output union member; see comment above.
  RunnableAgent<never, false> | RunnableAgent<any, true>
>;

/** The literal agent names of `D`, widened to `string` for runtime use. */
export type AgentNames<D extends AgentDefinitions> = keyof D & string;

/** `D[TName]`'s validated output type — `never` when that agent has none. */
export type AgentOutput<D extends AgentDefinitions, TName extends keyof D> =
  D[TName] extends RunnableAgent<infer O, boolean> ? O : never;

/** Whether `D[TName]` was built with an `output` schema. */
export type AgentHasOutput<D extends AgentDefinitions, TName extends keyof D> =
  D[TName] extends RunnableAgent<unknown, infer H> ? H : false;

export interface AgentCatalogEntry<
  D extends AgentDefinitions,
  TName extends keyof D & string = keyof D & string,
> {
  readonly name: TName;
  readonly agent: D[TName];
}

/**
 * Read-only, immutable inspection surface over a fixed `AgentDefinitions`
 * map — `bureau.agents`. Nothing here mutates the catalog; the map itself is
 * fixed for the bureau's lifetime (AB-15).
 */
export interface BureauAgentCatalog<D extends AgentDefinitions> {
  /** Compile-time-safe lookup — only a literal key of `D` type-checks. */
  get<TName extends keyof D & string>(name: TName): D[TName];
  /**
   * Runtime lookup for a name that arrived as a plain `string` (an HTTP path
   * parameter, a webhook payload). TypeScript cannot narrow a runtime string
   * back to a literal key, so the return type is the widened
   * `RunnableAgent<unknown, boolean>`.
   */
  find(name: string): RunnableAgent<unknown, boolean> | undefined;
  has(name: string): boolean;
  /** Definition order — the order `Object.keys(agents)` produced. */
  names(): Array<keyof D & string>;
  entries(): Array<AgentCatalogEntry<D>>;
  query(predicate: (entry: AgentCatalogEntry<D>) => boolean): Array<AgentCatalogEntry<D>>;
}

/**
 * Builds the immutable `BureauAgentCatalog` view over a fixed
 * `AgentDefinitions` map. `Object.entries` preserves string-key insertion
 * order, so `names()`/`entries()`/`query()` iterate in the exact order
 * `agents` was written in — the "preserve definition order" contract.
 *
 * `find`/`has` are exact-key lookups. The predecessor `AgentRegistry.query()`
 * matched `text` against agent name/description case-insensitively; that
 * shape doesn't survive here — `RunnableAgent` carries no `description`, and
 * `find`/`get`/`has` narrow (or must narrow) on an exact name so `has`
 * narrowing a literal string to `keyof D` isn't undermined by a lookup that
 * silently accepts a differently-cased name it wouldn't `.get()`. A
 * case-insensitive *search* is still available through `query(predicate)`,
 * where the predicate can lower-case both sides itself.
 */
export function createAgentCatalog<D extends AgentDefinitions>(agents: D): BureauAgentCatalog<D> {
  // `Object.entries`/`Map` widen each value to the Record's own bound
  // (`RunnableAgent<never, false> | RunnableAgent<any, true>`), losing the
  // per-key precision `AgentCatalogEntry<D>` promises. The cast below
  // restores it: at runtime every entry genuinely IS `agents[name]`, so this
  // is a type-level-only correction, not a behavior change — TypeScript
  // cannot itself prove `Object.entries(agents)[i][1] extends D[TName]` for
  // a generic `D`, since `Object.entries`'s signature necessarily widens to
  // the Record's value bound.
  const entries = Object.entries(agents).map(
    ([name, agent]) => ({ name, agent }) as AgentCatalogEntry<D>,
  );
  const byName = new Map<string, AgentCatalogEntry<D>>(entries.map((entry) => [entry.name, entry]));

  const catalog: BureauAgentCatalog<D> = {
    // Same cast rationale as above: `byName.get(name)!.agent` is genuinely
    // `D[TName]` for a `TName` the caller supplied, but the `Map`'s own
    // value type is the widened `AgentCatalogEntry<D>['agent']`, which
    // TypeScript cannot narrow back to the caller's specific `TName`.
    get<TName extends keyof D & string>(name: TName): D[TName] {
      const entry = byName.get(name);
      if (!entry) {
        throw new Error(`Unknown agent "${name}"`);
      }
      return entry.agent as D[TName];
    },
    find(name) {
      return byName.get(name)?.agent;
    },
    has(name) {
      return byName.has(name);
    },
    names() {
      return entries.map((entry) => entry.name);
    },
    entries() {
      return [...entries];
    },
    query(predicate) {
      return entries.filter(predicate);
    },
  };

  return Object.freeze(catalog);
}
