const KEBAB_TAG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Tag type utilities.
 *
 * Note: Kebab-case validation is performed at runtime via `assertKebabCaseTag()`.
 * We intentionally avoid compile-time recursive string template literal types
 * (like `IsKebabCase<S>`) because they cause exponential type instantiation
 * when many tools with literal tag tuples are combined in consuming code.
 *
 * The tradeoff: you won't get a compile-time error for `tags: ['Invalid Tag']`,
 * but you will get a clear runtime error from `assertKebabCaseTag()`.
 */

/**
 * Type for enforcing kebab-case tags.
 * Uses simple string type to prevent type explosion.
 * Runtime validation via assertKebabCaseTag provides actual enforcement.
 */
export type KebabCaseString<S extends string> = S;

/**
 * Type for an array of kebab-case tags.
 * Uses simple readonly string array to prevent type explosion.
 * Runtime validation via assertKebabCaseTag provides actual enforcement.
 */
export type EnforceKebabCaseArray<T extends readonly string[]> = T;

/**
 * Normalizes the tags option type.
 * Simplified to prevent recursive type evaluation that causes type explosion.
 */
export type NormalizeTagsOption<Tags extends readonly string[] | undefined> = Tags;

export function assertKebabCaseTag(tag: string, context: string): string {
  if (typeof tag !== 'string') {
    throw new Error(`${context}: tag must be a string`);
  }
  const trimmed = tag.trim();
  if (!trimmed) {
    throw new Error(`${context}: tag must not be empty`);
  }
  if (!KEBAB_TAG_RE.test(trimmed)) {
    throw new Error(
      `${context}: tag "${tag}" must be kebab-case (lowercase letters, digits, hyphen)`,
    );
  }
  return trimmed;
}

export function uniqTags<T extends readonly string[]>(tags: T): string[] {
  return Array.from(new Set(tags));
}

export function normalizeTags(tags: readonly string[]): string[] {
  return tags.filter(Boolean).map((tag) => String(tag).toLowerCase());
}
