/**
 * This package's registered environment boundary.
 *
 * Every environment read in `@lostgradient/skills` goes through here, which is what the repository's
 * environment-configuration policy enforces. The package has no production configuration — it is a
 * library, and its behavior is a function of its inputs — so this exposes only the boundary's
 * sanctioned single-name read, the same shape `@lostgradient/weft` uses for its own opt-in test flags.
 *
 * A test-only flag deliberately does not get a schema entry: a production configuration schema is
 * a statement about how the package is deployed, and an opt-in gate for a developer's machine is
 * not part of that.
 */

function rawEnvironment(): Record<string, string | undefined> {
  if (typeof Bun !== 'undefined') return Bun.env;
  if (typeof process !== 'undefined') return process.env;
  return {};
}

/** Reads one exact environment variable name, or `undefined` when it is not set. */
export function readEnvironmentVariable(name: string): string | undefined {
  return rawEnvironment()[name];
}
