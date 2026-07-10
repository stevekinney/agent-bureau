/**
 * The minimal R2 surface the Cloudflare text-value store backend needs.
 *
 * Modeled on Cloudflare's `R2Bucket` binding so the real binding satisfies
 * this interface structurally with no adapter — `R2Bucket.get(key)` (no
 * `onlyIf` option) resolves to the `R2ObjectBody | null` overload, `put`
 * accepts a `string` value, `delete` accepts a single key, and `list`'s
 * `R2Objects` result is a structural superset of {@link R2ListResult}. A
 * recording fake (see `src/test/fake-r2.ts`) satisfies the same shape for
 * tests.
 */

/** The subset of `R2ObjectBody` this backend reads: the text body. */
export interface R2ObjectBody {
  text(): Promise<string>;
}

/** The subset of `R2Object` this backend reads from a list result: the key. */
export interface R2ObjectMetadata {
  key: string;
}

/** Options for {@link R2Bucket.list}. */
export interface R2ListOptions {
  prefix?: string;
  cursor?: string;
  limit?: number;
}

/**
 * The result of {@link R2Bucket.list}. Cloudflare paginates list results (a
 * default page is capped well under most prefixes' key counts), so a full
 * prefix listing must follow `cursor` until `truncated` is `false`.
 */
export interface R2ListResult {
  objects: R2ObjectMetadata[];
  truncated: boolean;
  cursor?: string;
}

/**
 * The injectable R2 interface. In production this is an R2 bucket binding; in
 * tests it is a recording fake.
 */
export interface R2Bucket {
  /**
   * Check whether `key` exists without reading its body. Real R2 `head()`
   * resolves to `R2Object | null` (metadata only); typed here as
   * `Promise<unknown>` since this backend only ever checks the result against
   * `null`, and `unknown` keeps the interface honest about not touching
   * `R2Object`'s other fields.
   */
  head(key: string): Promise<unknown>;
  /** Read an object's body, or `null` if the key is absent. */
  get(key: string): Promise<R2ObjectBody | null>;
  /**
   * Write `value` at `key`, replacing any existing object. Typed to return
   * `Promise<unknown>` (not `Promise<void>`) so the real `R2Bucket.put`
   * (`Promise<R2Object | null>`) satisfies this interface structurally: a
   * `Promise<X>` is not assignable to `Promise<void>` for non-`void` `X`, so
   * the narrower return type would reject the real binding.
   */
  put(key: string, value: string): Promise<unknown>;
  /** Delete `key`. No-op when absent. */
  delete(key: string): Promise<void>;
  /** List objects, optionally scoped by `prefix` and paginated via `cursor`. */
  list(options?: R2ListOptions): Promise<R2ListResult>;
}
