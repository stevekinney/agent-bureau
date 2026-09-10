// Fixture: a cross-package import reachable through the target package's declared exports map
// (`fixture-pkg-a/test` is a declared subpath). Not reported.
// Named `.ts`, not `.test.ts`, so `bun test` never tries to execute it — the fake package it
// imports does not exist as a real, resolvable module outside this gate's own AST scan.
import type { testHelper } from 'fixture-pkg-a/test';

export type ReExported = typeof testHelper;
