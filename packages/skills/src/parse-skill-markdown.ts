import matter from 'gray-matter';
import { FAILSAFE_SCHEMA, load as loadYaml } from 'js-yaml';

import {
  isPortableSkillName,
  normalizeSkillName,
  parseAllowedTools,
  PORTABLE_FRONTMATTER_FIELDS,
  serializeAllowedTools,
  validatePortableFrontmatter,
  type SkillConformanceDiagnostic,
} from './conformance';
import type { SkillContent, SkillMetadata } from './types';

/**
 * Error thrown when a SKILL.md file cannot be parsed.
 * Wraps the underlying parse failure in `cause` for debugging.
 */
export class SkillParseError extends Error {
  override readonly cause?: Error;

  constructor(message: string, cause?: Error) {
    super(message);
    this.name = 'SkillParseError';
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Thrown when a `SKILL.md` parses as YAML but does not satisfy the pinned specification.
 *
 * Carries every failure rather than the first, because a publisher fixing a skill should see the
 * whole list instead of peeling it one error per run.
 */
export class SkillConformanceError extends SkillParseError {
  readonly diagnostics: readonly SkillConformanceDiagnostic[];

  constructor(diagnostics: readonly SkillConformanceDiagnostic[]) {
    super(
      `SKILL.md is not conformant with the pinned Agent Skills specification: ${diagnostics
        .map((diagnostic) => diagnostic.message)
        .join('; ')}`,
    );
    this.name = 'SkillConformanceError';
    this.diagnostics = diagnostics;
  }
}

/** Returns true when `name` satisfies the pinned specification's name grammar. */
export function isValidSkillName(name: string): boolean {
  return isPortableSkillName(name);
}

const PORTABLE_FIELD_SET: ReadonlySet<string> = new Set(PORTABLE_FRONTMATTER_FIELDS);

/** A change diagnostic import made to input it could not use as written. */
export type SkillImportRepairCode =
  | 'yaml-value-quoted'
  | 'unsupported-field-dropped'
  | 'allowed-tools-comma-separated'
  | 'allowed-tools-sequence-joined';

/** One repair, reported so a caller can never mistake a repaired import for a conformant one. */
export interface SkillImportRepair {
  readonly code: SkillImportRepairCode;
  readonly message: string;
  readonly field?: string;
}

/** The outcome of a diagnostic import. */
export interface SkillImportResult {
  /** Best-effort content. Present even when the input is not conformant. */
  readonly content: SkillContent;
  /**
   * Top-level fields the specification does not define, preserved exactly as parsed.
   *
   * Kept rather than discarded so an import is lossless: a client-specific key can be inspected,
   * migrated into `metadata`, or reported back to its author instead of vanishing.
   */
  readonly preservedFields: Readonly<Record<string, unknown>>;
  /** Every repair applied to reach {@link content}. */
  readonly repairs: readonly SkillImportRepair[];
  /** Every strict-conformance failure the input has. */
  readonly conformance: readonly SkillConformanceDiagnostic[];
  /**
   * True only when strict validation passed *and* nothing needed repairing.
   *
   * A repaired artifact is never conformant, however small the repair: what a publisher ships is
   * the original bytes, and those are what another client will strictly validate.
   */
  readonly conformant: boolean;
}

interface ExtractedFrontmatter {
  readonly data: Record<string, unknown>;
  readonly body: string;
  readonly repaired: boolean;
}

/**
 * Rewrites top-level YAML values containing unquoted colons so the document parses.
 *
 * `description: Use this: when handling PDFs` is the single most common authoring mistake, and
 * quoting the value is a faithful reading of the author's intent.
 */
function quoteUnquotedColonValues(content: string): string | undefined {
  const fenceMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fenceMatch?.[1]) return undefined;

  const fixedLines = fenceMatch[1].split('\n').map((line) => {
    const match = line.match(/^([a-zA-Z][\w-]*?):\s+(.+)$/);
    if (
      match?.[2] &&
      match[2].includes(':') &&
      !match[2].startsWith('"') &&
      !match[2].startsWith("'")
    ) {
      return `${match[1]}: "${match[2].replaceAll('"', '\\"')}"`;
    }
    return line;
  });

  // A function replacer, not a string one: `$&`, `` $` `` and `$'` in a skill's own frontmatter
  // are replacement patterns to `String#replace`, and because this match starts at offset 0 and
  // spans the whole fence, `` $` `` silently truncated the value to nothing and `$&` duplicated
  // the fence until the document no longer parsed.
  const replacement = `---\n${fixedLines.join('\n')}\n---`;
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---/, () => replacement);
}

/**
 * Resolves every YAML scalar as a string, and never uses `gray-matter`'s cache.
 *
 * Two independent reasons, both defects found in this package rather than theory.
 *
 * The schema is the important one. The reference parser uses `strictyaml`, where every scalar is a
 * string; `gray-matter` defaults to `js-yaml`'s implicit typing, so `name: 1.0` arrives as the
 * number `1`, `name: 0x1f` as `31`, and `description: 2026-09-19` as a `Date`. That is not a
 * cosmetic difference — it changed validation verdicts in both directions against the pinned
 * validator: `1.0` was accepted here and rejected upstream, while `0x1f` and `1e5` were rejected
 * here and accepted upstream. `FAILSAFE_SCHEMA` resolves scalars exactly as `strictyaml` does and
 * removes the whole class.
 *
 * The cache is the second. `gray-matter` memoizes by input string and stores the entry *before*
 * parsing, so a document that throws leaves a half-built, empty entry behind and the next parse of
 * the same string returns that instead of throwing. Strict parsing followed by diagnostic import of
 * the same bytes is exactly that sequence, and it silently produced a skill with no name. Passing
 * an options object takes the uncached path.
 */
function parseFrontmatterUncached(content: string): matter.GrayMatterFile<string> {
  return matter(content, {
    engines: {
      yaml: (source: string): object => loadYaml(source, { schema: FAILSAFE_SCHEMA }) ?? {},
    },
  });
}

/**
 * Parses YAML frontmatter.
 *
 * `allowRepair` is what separates the two modes, and it matters more than it looks: the repair
 * below used to run unconditionally and report nothing, so a strict parse silently accepted a
 * document the pinned validator rejects. Strict mode now fails on unparseable YAML and lets
 * diagnostic import be the only path that rewrites anything (COR-752, Decision 6).
 */
function extractFrontmatter(content: string, allowRepair: boolean): ExtractedFrontmatter {
  try {
    const result = parseFrontmatterUncached(content);
    return { data: result.data, body: result.content, repaired: false };
  } catch (strictError) {
    const cause = strictError instanceof Error ? strictError : new Error(String(strictError));
    if (!allowRepair) {
      throw new SkillParseError('Failed to parse SKILL.md frontmatter', cause);
    }

    const repairedContent = quoteUnquotedColonValues(content);
    if (repairedContent === undefined) {
      throw new SkillParseError('Failed to parse SKILL.md frontmatter', cause);
    }

    try {
      const result = parseFrontmatterUncached(repairedContent);
      return { data: result.data, body: result.content, repaired: true };
    } catch {
      throw new SkillParseError('Failed to parse SKILL.md frontmatter', cause);
    }
  }
}

/**
 * Rewrites the two `allowed-tools` shapes authors actually write into the portable wire format.
 *
 * Both are worth repairing rather than merely rejecting. A YAML sequence is the intuitive way to
 * express a list, and a comma-separated string is what this package itself accepted before it was
 * pinned to the specification — so existing skills in this workspace are written that way. Neither
 * is conformant, and reporting the repair is what keeps that distinction honest.
 */
function normalizeAllowedTools(data: Record<string, unknown>): {
  readonly data: Record<string, unknown>;
  readonly repairs: SkillImportRepair[];
} {
  const value = data['allowed-tools'];
  const repairs: SkillImportRepair[] = [];

  if (Array.isArray(value)) {
    // Strict parsing reads a sequence too, so this repair changes no verdict — it exists to tell
    // the author that the portable wire format is one string, which is what serialization emits.
    repairs.push({
      code: 'allowed-tools-sequence-joined',
      message:
        "Field 'allowed-tools' was a YAML sequence; the specification's wire format is one space-separated string.",
      field: 'allowed-tools',
    });
    return { data, repairs };
  }

  if (typeof value === 'string' && value.includes(',')) {
    const tools = value
      .split(',')
      .map((tool) => tool.trim())
      .filter((tool) => tool !== '');
    repairs.push({
      code: 'allowed-tools-comma-separated',
      message:
        "Field 'allowed-tools' was comma-separated; the specification's wire format is one space-separated string.",
      field: 'allowed-tools',
    });
    return { data: { ...data, 'allowed-tools': serializeAllowedTools(tools) }, repairs };
  }

  return { data, repairs };
}

function buildMetadata(data: Readonly<Record<string, unknown>>): SkillMetadata {
  const rawName = data['name'];
  const rawDescription = data['description'];

  const metadata: SkillMetadata = {
    name: typeof rawName === 'string' ? normalizeSkillName(rawName) : '',
    description: typeof rawDescription === 'string' ? rawDescription.trim() : '',
  };

  const license = data['license'];
  if (typeof license === 'string' && license.trim()) metadata.license = license.trim();

  const compatibility = data['compatibility'];
  if (typeof compatibility === 'string' && compatibility.trim()) {
    metadata.compatibility = compatibility.trim();
  }

  // `allowed-tools` only ever narrows (COR-752, Decision 2), so there is no deny half to read. A
  // skill author must not be able to disable a tool for the agent that loaded them, because that
  // would let untrusted content suppress a safety-relevant one; native deny policy lives in Bureau
  // configuration instead.
  //
  // A portable `denied-tools` is not a specification field at all, so strict validation rejects it
  // as an unexpected field rather than needing a rule of its own. COR-1228 deliberately read and
  // discarded the key instead, because promoting it to a hard failure would have left authors with
  // no repair path while no diagnostic-import mode existed. That mode exists now
  // (`importSkillMarkdown`), which is the condition COR-752's Decision 6 named — so the refusal is
  // a conformance failure here, and an author whose skill carries the key gets both a diagnostic
  // and a way to load it anyway.
  const allowList = parseAllowedTools(data['allowed-tools']);
  if (allowList.length > 0) metadata.toolPolicy = { allowList };

  const rawMetadata = data['metadata'];
  if (rawMetadata && typeof rawMetadata === 'object' && !Array.isArray(rawMetadata)) {
    const record = Object.fromEntries(
      Object.entries(rawMetadata).map(([key, value]) => [key, String(value)]),
    );
    if (Object.keys(record).length > 0) metadata.metadata = record;
  }

  return metadata;
}

/** Options shared by strict parsing and diagnostic import. */
export interface ParseSkillMarkdownOptions {
  /**
   * The directory the `SKILL.md` was read from. Supplying it enables the specification's
   * name-must-match-directory rule; omitting it skips that rule, exactly as upstream does when it
   * has no directory to compare against.
   */
  readonly directoryName?: string;
}

/**
 * Parses a `SKILL.md` strictly against the pinned Agent Skills specification.
 *
 * Throws {@link SkillConformanceError} when the document parses but does not conform, and
 * {@link SkillParseError} when it does not parse at all. Nothing is repaired: use
 * {@link importSkillMarkdown} for input that may need it.
 */
export function parseSkillMarkdown(
  content: string,
  options?: ParseSkillMarkdownOptions,
): SkillContent {
  const { data: normalized, body } = extractFrontmatter(content, false);

  const diagnostics = validatePortableFrontmatter(
    normalized,
    options?.directoryName === undefined ? undefined : { directoryName: options.directoryName },
  );
  if (diagnostics.length > 0) throw new SkillConformanceError(diagnostics);

  return { metadata: buildMetadata(normalized), body: body.trim() };
}

/**
 * Imports a `SKILL.md` diagnostically: repairs what it can, preserves what it cannot use, and
 * reports all of it.
 *
 * The result is never labelled conformant on the strength of a repair. Strict validation runs
 * against the repaired document too, so a caller sees both what had to change and what is still
 * wrong, and can decide whether to publish a corrected artifact or reject the input.
 *
 * Conformance failures are returned, never thrown. A document that is not YAML at all, or has no
 * frontmatter fence, still throws {@link SkillParseError}: there is no content to report on, and
 * {@link SkillImportResult} has no state for "unparseable".
 */
export function importSkillMarkdown(
  content: string,
  options?: ParseSkillMarkdownOptions,
): SkillImportResult {
  const extracted = extractFrontmatter(content, true);
  const { data: normalized, repairs: toolRepairs } = normalizeAllowedTools(extracted.data);

  const repairs: SkillImportRepair[] = [...toolRepairs];
  if (extracted.repaired) {
    repairs.push({
      code: 'yaml-value-quoted',
      message:
        'Frontmatter did not parse as written; top-level values containing unquoted colons were quoted.',
    });
  }

  const preservedFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(normalized)) {
    if (PORTABLE_FIELD_SET.has(key)) continue;
    preservedFields[key] = value;
    repairs.push({
      code: 'unsupported-field-dropped',
      message: `Field '${key}' is not defined by the pinned specification and is not carried into portable output.`,
      field: key,
    });
  }

  const conformance = validatePortableFrontmatter(
    normalized,
    options?.directoryName === undefined ? undefined : { directoryName: options.directoryName },
  );

  return {
    content: { metadata: buildMetadata(normalized), body: extracted.body.trim() },
    preservedFields,
    repairs,
    conformance,
    conformant: conformance.length === 0 && repairs.length === 0,
  };
}

/**
 * Serializes `SkillContent` back into a portable `SKILL.md`.
 *
 * Output carries only fields the pinned specification defines, in its wire representation —
 * notably `allowed-tools` as one space-separated string. Anything a diagnostic import preserved
 * stays out: re-emitting a field this package refuses to honour would republish a claim it does
 * not act on.
 */
export function serializeSkillMarkdown(content: SkillContent): string {
  const { metadata, body } = content;
  return matter.stringify(body ? `\n${body}\n` : '', serializeMetadata(metadata));
}

function serializeMetadata(metadata: SkillMetadata): Record<string, unknown> {
  const frontmatterData: Record<string, unknown> = {
    name: metadata.name,
    description: metadata.description,
  };

  if (metadata.license) frontmatterData['license'] = metadata.license;
  if (metadata.compatibility) frontmatterData['compatibility'] = metadata.compatibility;

  const allowList = metadata.toolPolicy?.allowList;
  if (allowList?.length) frontmatterData['allowed-tools'] = serializeAllowedTools(allowList);
  // No `denied-tools` round trip: the key is not honoured on the way in, so writing it back out
  // would re-publish a declaration this package refuses to act on.

  if (metadata.metadata && Object.keys(metadata.metadata).length > 0) {
    frontmatterData['metadata'] = metadata.metadata;
  }

  return frontmatterData;
}
