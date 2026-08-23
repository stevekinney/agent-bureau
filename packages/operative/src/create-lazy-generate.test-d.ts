// Type-level contract for AB-20. This file is checked by `tsc --noEmit`;
// it is not a runtime Bun test.

import type { CreateLazyGenerateOptions, LazyGenerateLoader } from './create-lazy-generate';
import { createLazyGenerate } from './create-lazy-generate';
import type { GenerateFunction, GenerateResponse } from './types';

const response = { content: 'typed', toolCalls: [] } satisfies GenerateResponse;
const directGenerate: GenerateFunction = () => Promise.resolve(response);

const directLazy: GenerateFunction = createLazyGenerate(() => directGenerate);
void directLazy;

const namedLazy: GenerateFunction = createLazyGenerate(() =>
  import('./create-lazy-generate-type-fixtures').then((module) => module.namedGenerate),
);
void namedLazy;

const defaultLazy: GenerateFunction = createLazyGenerate(() =>
  import('./create-lazy-generate-type-fixtures').then((module) => module.default),
);
void defaultLazy;

const barrelLazy: GenerateFunction = createLazyGenerate(() =>
  import('./create-lazy-generate-type-barrel').then((module) => module.namedGenerate),
);
void barrelLazy;

const literalImportLazy: GenerateFunction = createLazyGenerate(() =>
  import('./create-lazy-generate-type-fixtures').then(
    ({ namedGenerate: selectedGenerate }) => selectedGenerate,
  ),
);
void literalImportLazy;

declare const widenedUnknownModule: Promise<unknown>;

// @ts-expect-error — callers must select and narrow the export before passing it to createLazyGenerate.
const unknownModuleLazy = createLazyGenerate(() => widenedUnknownModule);
void unknownModuleLazy;

const narrowedUnknownModuleLazy: GenerateFunction = createLazyGenerate(async () => {
  const module = await widenedUnknownModule;
  if (
    typeof module === 'object' &&
    module !== null &&
    'default' in module &&
    typeof module.default === 'function'
  ) {
    return module.default as GenerateFunction;
  }
  return directGenerate;
});
void narrowedUnknownModuleLazy;

const promiseLikeLoader: LazyGenerateLoader = () => Promise.resolve(directGenerate);
void promiseLikeLoader;

const options: CreateLazyGenerateOptions = { label: 'typed-provider' };
void options;

// @ts-expect-error — loader-level cancellation is not part of the public options contract.
const optionsWithSignal: CreateLazyGenerateOptions = { signal: AbortSignal.abort() };
void optionsWithSignal;

const moduleObjectLoader = () => import('./create-lazy-generate-type-fixtures');

// @ts-expect-error — module objects are not accepted; the caller must select the callable export.
const moduleObjectLazy = createLazyGenerate(moduleObjectLoader);
void moduleObjectLazy;

type GenerateFunctionWithPreload = GenerateFunction & { preload: () => void };

// @ts-expect-error — the lazy wrapper is an ordinary GenerateFunction, with no stateful helper API.
const lazyWithPreload: GenerateFunctionWithPreload = directLazy;
void lazyWithPreload;
