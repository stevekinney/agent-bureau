/**
 * Strict Agent Skills conformance, pinned to one exact upstream revision.
 *
 * Every rule below is transcribed from `skills-ref/src/skills_ref/validator.py` at
 * {@link AGENT_SKILLS_SPECIFICATION_REVISION} — the official reference validator — rather than
 * from the prose specification, because the prose and the validator disagree in one place that
 * matters: the prose says a name may contain "unicode lowercase alphanumeric characters
 * (`a-z`, `0-9`)", while the validator accepts any character for which Python's `str.isalnum()`
 * is true. The validator is what a publisher's skill is actually checked against, so it wins.
 *
 * Upgrading the pin is a superseding decision, not a patch (COR-752, Decision 6): record the new
 * revision, re-run the pinned corpus, and classify every newly non-conformant skill as a
 * diagnostic-import repair or a rejection before the new baseline becomes strict.
 */

/** Upstream repository the pinned revision belongs to. */
export const AGENT_SKILLS_SPECIFICATION_REPOSITORY = 'https://github.com/agentskills/agentskills';

/**
 * The exact upstream commit this package's strict validation agrees with.
 *
 * Changing this constant without re-running the pinned corpus leaves the package claiming a
 * conformance it has not demonstrated, so the corpus test asserts the constant's value directly.
 */
export const AGENT_SKILLS_SPECIFICATION_REVISION = '69ef37e9424c0a7ea9dd2293b559e43ec8176379';

/** Upstream `MAX_SKILL_NAME_LENGTH`. */
export const MAXIMUM_SKILL_NAME_LENGTH = 64;
/** Upstream `MAX_DESCRIPTION_LENGTH`. */
export const MAXIMUM_DESCRIPTION_LENGTH = 1024;
/** Upstream `MAX_COMPATIBILITY_LENGTH`. */
export const MAXIMUM_COMPATIBILITY_LENGTH = 500;

/**
 * Upstream `ALLOWED_FIELDS`. Strict validation rejects every other top-level key, which is how
 * portable `denied-tools` is refused: it is simply not a field the specification defines.
 */
export const PORTABLE_FRONTMATTER_FIELDS = Object.freeze([
  'allowed-tools',
  'compatibility',
  'description',
  'license',
  'metadata',
  'name',
] as const);

/** A top-level frontmatter key the pinned specification defines. */
export type PortableFrontmatterField = (typeof PORTABLE_FRONTMATTER_FIELDS)[number];

const PORTABLE_FRONTMATTER_FIELD_SET: ReadonlySet<string> = new Set(PORTABLE_FRONTMATTER_FIELDS);

/**
 * Every way a skill can fail strict conformance. One code per upstream error branch, so a fixture
 * can assert the exact reason rather than matching on message text.
 */
export type SkillConformanceCode =
  | 'unexpected-field'
  | 'name-missing'
  | 'name-empty'
  | 'name-too-long'
  | 'name-not-lowercase'
  | 'name-hyphen-boundary'
  | 'name-consecutive-hyphens'
  | 'name-invalid-characters'
  | 'name-directory-mismatch'
  | 'description-missing'
  | 'description-empty'
  | 'description-too-long'
  | 'compatibility-not-string'
  | 'compatibility-too-long';

/** One strict-conformance failure. */
export interface SkillConformanceDiagnostic {
  /** Stable machine-readable reason. */
  readonly code: SkillConformanceCode;
  /** Human-readable explanation, shaped after the upstream validator's own wording. */
  readonly message: string;
  /** The offending field, when the failure belongs to one. */
  readonly field?: PortableFrontmatterField;
  /** For `unexpected-field`, the keys that are not part of the specification. */
  readonly unexpectedFields?: readonly string[];
}

/** Options for {@link validatePortableFrontmatter}. */
export interface ValidatePortableFrontmatterOptions {
  /**
   * The name of the directory the `SKILL.md` was read from. Upstream requires it to equal the
   * NFKC-normalized `name`. Omit it when validating frontmatter that has no directory — a
   * registry payload, say — and the match rule is skipped exactly as upstream skips it.
   */
  readonly directoryName?: string;
}

/**
 * Normalizes a skill name the way upstream does before every other check: trim, then NFKC.
 *
 * Order matters. Upstream trims first and normalizes second, so a name padded with whitespace is
 * accepted while a name whose NFKC expansion introduces whitespace is not.
 */
export function normalizeSkillName(name: string): string {
  return name.trim().normalize('NFKC');
}

/**
 * Characters upstream's `c.isalnum() or c == '-'` admits.
 *
 * Python's `str.isalnum()` is `isalpha() or isdecimal() or isdigit() or isnumeric()`, covering
 * Unicode categories L* and N*. `\p{L}` and `\p{N}` are the direct equivalents.
 */
const PORTABLE_NAME_CHARACTERS = /^[\p{L}\p{N}-]*$/u;

/**
 * Counts Unicode code points rather than UTF-16 units.
 *
 * Python strings are sequences of code points, so upstream's `len(name) > 64` counts them — and a
 * name of 64 astral characters is 128 UTF-16 units, which `String#length` would wrongly reject.
 */
function countCodePoints(value: string): number {
  return Array.from(value).length;
}

function pushNameDiagnostics(
  diagnostics: SkillConformanceDiagnostic[],
  rawName: unknown,
  directoryName: string | undefined,
): void {
  if (typeof rawName !== 'string' || rawName.trim() === '') {
    diagnostics.push({
      code: 'name-empty',
      message: "Field 'name' must be a non-empty string",
      field: 'name',
    });
    return;
  }

  const name = normalizeSkillName(rawName);

  // Upstream accumulates every name failure rather than returning at the first one, so a single
  // bad name can report "too long" and "not lowercase" together. Fixtures depend on that.
  if (countCodePoints(name) > MAXIMUM_SKILL_NAME_LENGTH) {
    diagnostics.push({
      code: 'name-too-long',
      message: `Skill name '${name}' exceeds ${MAXIMUM_SKILL_NAME_LENGTH} character limit`,
      field: 'name',
    });
  }

  if (name !== name.toLowerCase()) {
    diagnostics.push({
      code: 'name-not-lowercase',
      message: `Skill name '${name}' must be lowercase`,
      field: 'name',
    });
  }

  if (name.startsWith('-') || name.endsWith('-')) {
    diagnostics.push({
      code: 'name-hyphen-boundary',
      message: 'Skill name cannot start or end with a hyphen',
      field: 'name',
    });
  }

  if (name.includes('--')) {
    diagnostics.push({
      code: 'name-consecutive-hyphens',
      message: 'Skill name cannot contain consecutive hyphens',
      field: 'name',
    });
  }

  if (!PORTABLE_NAME_CHARACTERS.test(name)) {
    diagnostics.push({
      code: 'name-invalid-characters',
      message: `Skill name '${name}' contains invalid characters. Only letters, digits, and hyphens are allowed.`,
      field: 'name',
    });
  }

  if (directoryName !== undefined && directoryName.normalize('NFKC') !== name) {
    diagnostics.push({
      code: 'name-directory-mismatch',
      message: `Directory name '${directoryName}' must match skill name '${name}'`,
      field: 'name',
    });
  }
}

function pushDescriptionDiagnostics(
  diagnostics: SkillConformanceDiagnostic[],
  rawDescription: unknown,
): void {
  if (typeof rawDescription !== 'string' || rawDescription.trim() === '') {
    diagnostics.push({
      code: 'description-empty',
      message: "Field 'description' must be a non-empty string",
      field: 'description',
    });
    return;
  }

  if (countCodePoints(rawDescription) > MAXIMUM_DESCRIPTION_LENGTH) {
    diagnostics.push({
      code: 'description-too-long',
      message: `Description exceeds ${MAXIMUM_DESCRIPTION_LENGTH} character limit`,
      field: 'description',
    });
  }
}

function pushCompatibilityDiagnostics(
  diagnostics: SkillConformanceDiagnostic[],
  rawCompatibility: unknown,
): void {
  if (typeof rawCompatibility !== 'string') {
    diagnostics.push({
      code: 'compatibility-not-string',
      message: "Field 'compatibility' must be a string",
      field: 'compatibility',
    });
    return;
  }

  if (countCodePoints(rawCompatibility) > MAXIMUM_COMPATIBILITY_LENGTH) {
    diagnostics.push({
      code: 'compatibility-too-long',
      message: `Compatibility exceeds ${MAXIMUM_COMPATIBILITY_LENGTH} character limit`,
      field: 'compatibility',
    });
  }
}

/**
 * Validates parsed frontmatter against the pinned specification and returns every failure.
 *
 * An empty array means the frontmatter is conformant. This mirrors upstream's `validate_metadata`
 * branch for branch, including its accumulate-don't-short-circuit behavior, so the pinned corpus
 * can assert agreement rather than approximate it.
 *
 * Note what is deliberately *not* checked, because upstream does not check it: the type of
 * `allowed-tools`, the shape of `metadata`, and the content of `license`. Adding rejections the
 * reference validator does not have would be its own divergence.
 */
export function validatePortableFrontmatter(
  frontmatter: Readonly<Record<string, unknown>>,
  options?: ValidatePortableFrontmatterOptions,
): SkillConformanceDiagnostic[] {
  const diagnostics: SkillConformanceDiagnostic[] = [];

  const unexpectedFields = Object.keys(frontmatter)
    .filter((key) => !PORTABLE_FRONTMATTER_FIELD_SET.has(key))
    .toSorted();

  if (unexpectedFields.length > 0) {
    diagnostics.push({
      code: 'unexpected-field',
      message: `Unexpected fields in frontmatter: ${unexpectedFields.join(', ')}. Only ${[...PORTABLE_FRONTMATTER_FIELDS].join(', ')} are allowed.`,
      unexpectedFields,
    });
  }

  if (!('name' in frontmatter)) {
    diagnostics.push({
      code: 'name-missing',
      message: 'Missing required field in frontmatter: name',
      field: 'name',
    });
  } else {
    pushNameDiagnostics(diagnostics, frontmatter['name'], options?.directoryName);
  }

  if (!('description' in frontmatter)) {
    diagnostics.push({
      code: 'description-missing',
      message: 'Missing required field in frontmatter: description',
      field: 'description',
    });
  } else {
    pushDescriptionDiagnostics(diagnostics, frontmatter['description']);
  }

  if ('compatibility' in frontmatter) {
    pushCompatibilityDiagnostics(diagnostics, frontmatter['compatibility']);
  }

  return diagnostics;
}

/**
 * True when `name` satisfies the pinned specification's name grammar on its own — length,
 * lowercase, hyphen placement, and character set, but not the directory-match rule, which needs
 * a directory to compare against.
 */
export function isPortableSkillName(name: string): boolean {
  if (name.trim() === '') return false;
  const normalized = normalizeSkillName(name);
  return (
    countCodePoints(normalized) <= MAXIMUM_SKILL_NAME_LENGTH &&
    normalized === normalized.toLowerCase() &&
    !normalized.startsWith('-') &&
    !normalized.endsWith('-') &&
    !normalized.includes('--') &&
    PORTABLE_NAME_CHARACTERS.test(normalized)
  );
}

/**
 * Reads the `allowed-tools` field into tool requests.
 *
 * The portable wire format is one space-separated string, and splitting on whitespace rather than
 * commas is what keeps a parameterized request such as `Bash(git:*)` intact — the commas that used
 * to be the separator here appear *inside* real tool requests.
 *
 * A YAML sequence is read as well, because the reference validator does not type-check this field
 * and its reader carries a sequence through. Returning nothing for a sequence meant a skill author
 * who wrote the intuitive list got no allow-list at all, silently, in strict mode — a permissions
 * surface failing open with no diagnostic. Serialization still emits the portable single string,
 * so the sequence is read, never re-published.
 */
export function parseAllowedTools(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((tool): tool is string => typeof tool === 'string')
      .map((tool) => tool.trim())
      .filter((tool) => tool !== '');
  }
  if (typeof value !== 'string') return [];
  return value.split(/\s+/u).filter((tool) => tool !== '');
}

/** Serializes tool requests back into the portable single-string wire format. */
export function serializeAllowedTools(tools: readonly string[]): string {
  return tools.join(' ');
}
