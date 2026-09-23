import type {
  NormalizedTextQuery,
  TextMatchScore,
  TextQueryMode,
  TextSearchIndex,
  TextToken,
} from './text-query';

export function emptyTextScore(): TextMatchScore {
  return {
    score: 0,
    fields: [],
    tagMatches: [],
    schemaMatches: [],
    metadataMatches: [],
    reasons: [],
  };
}

export function scoreTextMatchFromIndex(
  index: TextSearchIndex,
  normalized: NormalizedTextQuery,
): TextMatchScore {
  const result = emptyTextScore();
  addStringFieldScore(
    result,
    'name',
    index.name,
    index.nameTokens ?? tokenize(index.name),
    normalized,
  );
  addStringFieldScore(
    result,
    'description',
    index.description,
    index.descriptionTokens ?? tokenize(index.description),
    normalized,
  );
  addTokenFieldScore(result, 'tags', index.tags, 'tagMatches', 'tags', normalized);
  addTokenFieldScore(
    result,
    'schemaKeys',
    index.schemaKeys,
    'schemaMatches',
    'schema-keys',
    normalized,
  );
  addTokenFieldScore(
    result,
    'metadataKeys',
    index.metadataKeys,
    'metadataMatches',
    'metadata-keys',
    normalized,
  );
  return result;
}

export function scoreTextMatchValueFromIndex(
  index: TextSearchIndex,
  normalized: NormalizedTextQuery,
): number {
  return (
    stringFieldScore('name', index.name, index.nameTokens ?? tokenize(index.name), normalized) +
    stringFieldScore(
      'description',
      index.description,
      index.descriptionTokens ?? tokenize(index.description),
      normalized,
    ) +
    tokenFieldScore('tags', index.tags, normalized) +
    tokenFieldScore('schemaKeys', index.schemaKeys, normalized) +
    tokenFieldScore('metadataKeys', index.metadataKeys, normalized)
  );
}

function addStringFieldScore(
  result: TextMatchScore,
  field: 'name' | 'description',
  value: string,
  tokens: readonly string[],
  query: NormalizedTextQuery,
): void {
  const score = stringFieldScore(field, value, tokens, query);
  if (score <= 0) return;
  result.score += score;
  result.fields.push(field);
  result.reasons.push(field);
}

function addTokenFieldScore(
  result: TextMatchScore,
  field: 'tags' | 'schemaKeys' | 'metadataKeys',
  tokens: readonly TextToken[],
  matchKey: 'tagMatches' | 'schemaMatches' | 'metadataMatches',
  reasonLabel: string,
  query: NormalizedTextQuery,
): void {
  if (!query.fields.includes(field)) return;
  const weight = query.weights[field];
  if (weight <= 0) return;
  const tokenResult = scoreTokenMatches(tokens, query);
  if (!tokenResult.matches.length) return;
  result.score += tokenResult.score * weight;
  result.fields.push(field);
  result[matchKey] = tokenResult.matches;
  result.reasons.push(`${reasonLabel}(${tokenResult.matches.join(', ')})`);
}

function stringFieldScore(
  field: 'name' | 'description',
  value: string,
  tokens: readonly string[],
  query: NormalizedTextQuery,
): number {
  if (!query.fields.includes(field)) return 0;
  const weight = query.weights[field];
  if (weight <= 0) return 0;
  const score = scoreStringMatch(value, tokens, query);
  return score > 0 ? score * weight : 0;
}

function tokenFieldScore(
  field: 'tags' | 'schemaKeys' | 'metadataKeys',
  tokens: readonly TextToken[],
  query: NormalizedTextQuery,
): number {
  if (!query.fields.includes(field)) return 0;
  const weight = query.weights[field];
  if (weight <= 0) return 0;
  const score = scoreTokenMatchValue(tokens, query);
  return score > 0 ? score * weight : 0;
}

function scoreStringMatch(
  value: string,
  tokens: readonly string[],
  query: NormalizedTextQuery,
): number {
  if (!value || !query.tokens.length) return 0;
  if (query.mode === 'contains') {
    return query.tokens.filter((token) => value.includes(token)).length;
  }
  if (query.mode === 'exact') {
    return query.tokens.filter((token) => value === token || tokens.includes(token)).length;
  }
  return query.tokens.reduce(
    (score, token) => score + bestFuzzyTokenScore(tokens, token, query.threshold),
    0,
  );
}

function bestFuzzyTokenScore(
  tokens: readonly string[],
  queryToken: string,
  threshold: number,
): number {
  let best = 0;
  for (const valueToken of tokens) {
    if (maxSimilarityPossible(valueToken, queryToken) < threshold) continue;
    const score = similarity(valueToken, queryToken);
    if (score > best) {
      best = score;
      if (best === 1) break;
    }
  }
  return best >= threshold ? best : 0;
}

function scoreTokenMatches(
  tokens: readonly TextToken[],
  query: NormalizedTextQuery,
): { matches: string[]; score: number } {
  if (!tokens.length || !query.tokens.length) {
    return { matches: [], score: 0 };
  }
  const matches = new Set<string>();
  let score = 0;
  for (const queryToken of query.tokens) {
    const best = bestTokenMatch(tokens, queryToken, query.mode, query.threshold);
    if (best.score > 0) {
      score += best.score;
      matches.add(best.raw);
    }
  }
  return { matches: Array.from(matches), score };
}

function scoreTokenMatchValue(tokens: readonly TextToken[], query: NormalizedTextQuery): number {
  if (!tokens.length || !query.tokens.length) return 0;
  return query.tokens.reduce(
    (score, queryToken) =>
      score + bestTokenMatch(tokens, queryToken, query.mode, query.threshold).score,
    0,
  );
}

function bestTokenMatch(
  tokens: readonly TextToken[],
  queryToken: string,
  mode: TextQueryMode,
  threshold: number,
): { raw: string; score: number } {
  let best = { raw: '', score: 0 };
  for (const token of tokens) {
    const score = scoreTokenMatch(token.normalized, queryToken, mode, threshold);
    if (score > best.score) {
      best = { raw: token.raw, score };
      if (score === 1) break;
    }
  }
  return best;
}

function scoreTokenMatch(
  token: string,
  queryToken: string,
  mode: TextQueryMode,
  threshold: number,
): number {
  if (!token) return 0;
  if (mode === 'contains') return token.includes(queryToken) ? 1 : 0;
  if (mode === 'exact') return token === queryToken ? 1 : 0;
  if (token === queryToken) return 1;
  if (maxSimilarityPossible(token, queryToken) < threshold) return 0;
  const score = similarity(token, queryToken);
  return score >= threshold ? score : 0;
}

export function tokenize(value: string): string[] {
  if (!value) return [];
  const normalized = normalizeForSearch(value);
  const withBoundaries = normalized
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-zA-Z])([0-9])/g, '$1 $2')
    .replace(/([0-9])([a-zA-Z])/g, '$1 $2');
  return withBoundaries
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter(Boolean);
}

export function normalizeText(value: string): string {
  return normalizeForSearch(value).toLowerCase();
}

export function normalizeForSearch(value: unknown): string {
  if (typeof value === 'string') {
    return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (value && typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return '';
    }
  }
  return '';
}

function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const maxLength = Math.max(a.length, b.length);
  if (!maxLength) return 1;
  return 1 - levenshteinDistance(a, b) / maxLength;
}

export function maxSimilarityPossible(a: string, b: string): number {
  const maxLength = Math.max(a.length, b.length);
  if (!maxLength) return 1;
  const minDistance = Math.abs(a.length - b.length);
  return 1 - minDistance / maxLength;
}

function levenshteinDistance(a: string, b: string): number {
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const previous = Array.from({ length: b.length + 1 }, (_value, index) => index);
  const current = Array.from<number>({ length: b.length + 1 });
  for (let row = 1; row <= a.length; row++) {
    current[0] = row;
    fillDistanceRow(a.charCodeAt(row - 1), b, previous, current);
    previous.splice(0, previous.length, ...current);
  }
  return previous[b.length] ?? 0;
}

function fillDistanceRow(
  sourceCode: number,
  target: string,
  previous: readonly number[],
  current: number[],
): void {
  for (let column = 1; column <= target.length; column++) {
    const cost = sourceCode === target.charCodeAt(column - 1) ? 0 : 1;
    const deletion = (previous[column] ?? 0) + 1;
    const insertion = (current[column - 1] ?? 0) + 1;
    const substitution = (previous[column - 1] ?? 0) + cost;
    current[column] = Math.min(deletion, insertion, substitution);
  }
}
