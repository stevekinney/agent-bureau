/**
 * Type-declaration packages that every isolated packed-consumer verification
 * must pin, both as a devDependency and in `overrides`.
 *
 * Why this exists (2026-09-09): the consumer checks in
 * `verify-operative-consumer.ts` and `verify-bureau-tarball-boundary.ts`
 * type-check a fresh install with `skipLibCheck: false`, and `bun-types`
 * (pulled by the pinned `@types/bun` 1.3.14) declares `@types/node` as
 * `"*"`, which Bun resolves to the registry's `latest` dist-tag. On
 * 2026-09-09 DefinitelyTyped pointed `latest` at the 22 line (22.20.2), and
 * `bun-types` 1.3.14's declarations do not compile against `@types/node` 22
 * or 24 (`TextEncoderEncodeIntoResult`, `ConnectionOptions`, `KeyObject`,
 * `TLSSocket` are missing there); they need 25 or newer. The required
 * `coverage-and-package-shape` check failed on every open pull request with
 * no change in this repository. A plain devDependency does not fix that,
 * because the nested `"*"` still resolves independently; an `overrides`
 * entry does.
 *
 * The monorepo's own `bun.lock` resolves `@types/node` 22.19.15 and compiles
 * only because `tsconfig.base.json` sets `skipLibCheck: true`; the consumer
 * checks deliberately do not, so they pin the newest line `bun-types` 1.3.14
 * compiles against. Bump this together with `@types/bun`.
 */
export const PINNED_TYPE_DEPENDENCIES: Readonly<Record<string, string>> = {
  '@types/node': '26.5.1',
};
