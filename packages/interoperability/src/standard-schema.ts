/**
 * The Standard Schema spec (https://standardschema.dev) — a shared interface
 * implemented by Zod, Valibot, ArkType, and other validation libraries so
 * consuming code can accept "any validator" without depending on a specific
 * library. Vendored here (rather than depending on `@standard-schema/spec`)
 * because the spec is a handful of types with no runtime code.
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': StandardSchemaV1.Props<Input, Output>;
}

// eslint-disable-next-line @typescript-eslint/no-namespace
export declare namespace StandardSchemaV1 {
  export interface Props<Input = unknown, Output = Input> {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => Result<Output> | Promise<Result<Output>>;
    readonly types?: Types<Input, Output> | undefined;
  }

  export type Result<Output> = SuccessResult<Output> | FailureResult;

  export interface SuccessResult<Output> {
    readonly value: Output;
    readonly issues?: undefined;
  }

  export interface FailureResult {
    readonly issues: ReadonlyArray<Issue>;
  }

  export interface Issue {
    readonly message: string;
    readonly path?: ReadonlyArray<PropertyKey | PathSegment> | undefined;
  }

  export interface PathSegment {
    readonly key: PropertyKey;
  }

  export interface Types<Input = unknown, Output = Input> {
    readonly input: Input;
    readonly output: Output;
  }

  export type InferInput<Schema extends StandardSchemaV1> = NonNullable<
    Schema['~standard']['types']
  >['input'];

  export type InferOutput<Schema extends StandardSchemaV1> = NonNullable<
    Schema['~standard']['types']
  >['output'];
}

/**
 * Type guard for any Standard Schema-conforming validator (Zod, Valibot,
 * ArkType, etc.) — anything exposing a `~standard` props object. Note that
 * Zod schemas satisfy this guard too, since Zod v4 implements the spec; check
 * for a library-specific shape first (e.g. `instanceof z.ZodType`) when the
 * distinction matters.
 */
export function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  if (typeof value !== 'object' || value === null) return false;
  const props = (value as Record<string, unknown>)['~standard'];
  return (
    typeof props === 'object' &&
    props !== null &&
    typeof (props as Record<string, unknown>)['validate'] === 'function'
  );
}

/**
 * Runs a Standard Schema validator against a value and normalizes the
 * (possibly async) result into a promise. Standard Schema's `validate` may
 * return its result synchronously or as a promise; `await`-ing a non-promise
 * value resolves it immediately, so this is safe for both.
 */
export async function validateStandardSchema<Output>(
  schema: StandardSchemaV1<unknown, Output>,
  value: unknown,
): Promise<StandardSchemaV1.Result<Output>> {
  return await schema['~standard'].validate(value);
}
