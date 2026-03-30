import type { EvaluationCase, SemanticMatcher } from './types';

/** Type guard for SemanticMatcher objects loaded from JSON datasets. */
function isSemanticMatcher(value: unknown): value is SemanticMatcher {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record['type'] === 'semantic' &&
    typeof record['reference'] === 'string' &&
    typeof record['threshold'] === 'number'
  );
}

/**
 * Parses the `expectedOutput` field from a JSON dataset entry. Accepts
 * either a plain string or a SemanticMatcher object (`{ type, reference, threshold }`).
 * RegExp matchers cannot be represented in JSON and must be added programmatically.
 */
function parseExpectedOutput(value: unknown): string | SemanticMatcher | undefined {
  if (typeof value === 'string') return value;
  if (isSemanticMatcher(value)) return value;
  return undefined;
}

/**
 * Zod-like shape validation for evaluation case objects loaded from JSON.
 * Uses manual validation rather than Zod to keep the runtime dependency-free,
 * since Zod is only a devDependency in this package.
 */
function validateEvaluationCase(value: unknown, index: number): EvaluationCase {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Dataset entry at index ${index} is not an object`);
  }

  const record = value as Record<string, unknown>;

  if (typeof record['name'] !== 'string' || record['name'].length === 0) {
    throw new Error(
      `Dataset entry at index ${index} is missing a required "name" field (must be a non-empty string)`,
    );
  }

  if (typeof record['input'] !== 'string' || record['input'].length === 0) {
    throw new Error(
      `Dataset entry at index ${index} is missing a required "input" field (must be a non-empty string)`,
    );
  }

  return {
    name: record['name'],
    input: record['input'],
    systemPrompt: typeof record['systemPrompt'] === 'string' ? record['systemPrompt'] : undefined,
    expectedOutput: parseExpectedOutput(record['expectedOutput']),
    expectedToolCalls: Array.isArray(record['expectedToolCalls'])
      ? (record['expectedToolCalls'] as EvaluationCase['expectedToolCalls'])
      : undefined,
    maxSteps: typeof record['maxSteps'] === 'number' ? record['maxSteps'] : undefined,
    tags: Array.isArray(record['tags']) ? (record['tags'] as string[]) : undefined,
    timeout: typeof record['timeout'] === 'number' ? record['timeout'] : undefined,
  };
}

/**
 * Loads a single JSON dataset file and validates each entry as an EvaluationCase.
 * The file must contain a JSON array of objects, each with at least `name` and `input` fields.
 *
 * @param path - Absolute or relative path to a JSON file containing evaluation cases.
 * @returns A validated array of EvaluationCase objects.
 * @throws When the file is not found, contains invalid JSON, or entries fail validation.
 */
export async function loadDataset(path: string): Promise<EvaluationCase[]> {
  const file = Bun.file(path);
  const exists = await file.exists();

  if (!exists) {
    throw new Error(`Dataset file not found: ${path}`);
  }

  let raw: string;
  try {
    raw = await file.text();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read dataset file "${path}": ${message}`, { cause: error });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in dataset file "${path}": failed to parse`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`Dataset file "${path}" must contain a JSON array, got ${typeof parsed}`);
  }

  return parsed.map((entry, index) => validateEvaluationCase(entry, index));
}

/**
 * Loads multiple JSON dataset files matching a glob pattern and merges all
 * evaluation cases into a single array.
 *
 * @param pattern - A glob pattern (e.g., `"datasets/*.json"` or `"datasets/{a,b}.json"`).
 * @returns A merged array of EvaluationCase objects from all matching files.
 * @throws When any matched file contains invalid JSON or entries fail validation.
 */
export async function loadDatasets(pattern: string): Promise<EvaluationCase[]> {
  const matchedPaths: string[] = [];

  // Bun.Glob.scan needs a cwd. For absolute patterns, extract the longest
  // directory prefix that contains no glob metacharacters so that wildcards
  // in directory components (e.g. `/data/*/cases.json`) work correctly.
  // Only directory segments (not the final filename segment) are candidates.
  let cwd = '.';
  let scanPattern = pattern;

  if (pattern.startsWith('/')) {
    const segments = pattern.split('/');
    const directorySegments: string[] = [];

    // segments[0] is '' (leading slash), segments[1..n-1] are directories,
    // segments[n] is the filename/glob. Only consider directory segments.
    for (let i = 1; i < segments.length - 1; i++) {
      const segment = segments[i];
      if (segment !== undefined && /[*?{[]/.test(segment)) break;
      if (segment !== undefined) directorySegments.push(segment);
    }

    cwd = directorySegments.length > 0 ? '/' + directorySegments.join('/') : '/';
    scanPattern = pattern.slice(cwd === '/' ? 1 : cwd.length + 1);
  }

  const glob = new Bun.Glob(scanPattern);
  for await (const match of glob.scan({ cwd, absolute: true })) {
    matchedPaths.push(match);
  }

  // Sort for deterministic order across platforms
  matchedPaths.sort();

  const results: EvaluationCase[] = [];
  for (const filePath of matchedPaths) {
    const cases = await loadDataset(filePath);
    results.push(...cases);
  }

  return results;
}
