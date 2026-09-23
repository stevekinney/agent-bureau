import {
  buildTextSearchIndex,
  normalizeTextQuery,
  scoreTextMatchFromIndex,
  scoreTextMatchValueFromIndex,
  type NormalizedTextQuery,
  type TextSearchIndex,
} from '../query-predicates';
import { normalizeTags } from '../tag-utilities';
import { selectEmbeddingCandidates } from './embedding-candidates';
import { scoreEmbeddingMatch } from './embedding-scoring';
import { getQueryEmbeddingInfo } from './embeddings';
import {
  buildTagSet,
  collectTagMatches,
  createMatchComparator,
  mergeMatchDetails,
  mergeUnique,
  normalizeTagWeights,
  normalizeWeight,
  scoreTagMatches,
  scoreTagMatchesValue,
  selectTopMatches,
} from './ranking-utilities';
import { normalizeLimit, normalizeOffset } from './selection';
import type {
  Embedder,
  EmbeddingIndex,
  EmbeddingInfo,
  QueryResult,
  ToolDefinition,
  ToolMatch,
  ToolMatchDetails,
  ToolRankContext,
  ToolRanker,
  ToolSearchOptions,
  ToolTieBreaker,
} from './types';

type RankingContext = {
  tagSet: Set<string>;
  tagWeights: Record<string, number>;
  tagWeight: number;
  textWeight: number;
  normalizedText: NormalizedTextQuery | null;
  queryEmbedding: EmbeddingInfo | undefined;
  embeddingCandidates: Set<ToolDefinition> | null;
  explain: boolean;
  ranker: ToolRanker | undefined;
  preferredTags: string[];
  resolveIndex: (tool: ToolDefinition) => TextSearchIndex;
};

type RankLimitContext = {
  compare: (a: ToolMatch, b: ToolMatch) => number;
  tieBreaker: ToolTieBreaker;
  topLimit: number | undefined;
};

export function rankTools(
  tools: QueryResult,
  options: ToolSearchOptions = {},
  getIndex?: (tool: ToolDefinition) => TextSearchIndex,
  embedder?: Embedder,
  getEmbeddingIndex?: () => EmbeddingIndex,
): ToolMatch[] {
  const context = createRankingContext(options, getIndex, embedder, getEmbeddingIndex);
  const limits = createRankLimitContext(options);
  const ranked = canUseOptimizedRanking(tools, context, limits)
    ? buildOptimizedMatches(tools, context, limits)
    : buildAllMatches(tools, context, limits.topLimit);
  return ranked.toSorted(limits.compare);
}

function createRankingContext(
  options: ToolSearchOptions,
  getIndex: ((tool: ToolDefinition) => TextSearchIndex) | undefined,
  embedder: Embedder | undefined,
  getEmbeddingIndex: (() => EmbeddingIndex) | undefined,
): RankingContext {
  const settings = createRankSettings(options);
  const queryEmbedding = getQueryEmbedding(embedder, settings.normalizedText);
  return {
    ...settings,
    queryEmbedding,
    embeddingCandidates: getEmbeddingCandidates(
      queryEmbedding,
      settings.normalizedText,
      getEmbeddingIndex,
    ),
    explain: Boolean(options.explain),
    ranker: options.ranker,
    resolveIndex: getIndex ?? buildTextSearchIndex,
  };
}

function createRankSettings(
  options: ToolSearchOptions,
): Pick<
  RankingContext,
  'preferredTags' | 'tagWeights' | 'tagWeight' | 'textWeight' | 'normalizedText' | 'tagSet'
> {
  const rank = options.rank;
  const preferredTags = normalizeTags(rank?.tags ?? []);
  const tagWeights = normalizeTagWeights(rank?.tagWeights);
  return {
    preferredTags,
    tagWeights,
    tagWeight: normalizeWeight(rank?.weights?.tags),
    textWeight: normalizeWeight(rank?.weights?.text),
    normalizedText: rank?.text === undefined ? null : normalizeTextQuery(rank.text),
    tagSet: buildTagSet(preferredTags, tagWeights),
  };
}

function getQueryEmbedding(
  embedder: Embedder | undefined,
  normalizedText: NormalizedTextQuery | null,
): EmbeddingInfo | undefined {
  return embedder && normalizedText?.raw
    ? getQueryEmbeddingInfo(embedder, normalizedText.raw)
    : undefined;
}

function getEmbeddingCandidates(
  queryEmbedding: EmbeddingInfo | undefined,
  normalizedText: NormalizedTextQuery | null,
  getEmbeddingIndex: (() => EmbeddingIndex) | undefined,
): Set<ToolDefinition> | null {
  return queryEmbedding && normalizedText && getEmbeddingIndex
    ? selectEmbeddingCandidates(getEmbeddingIndex(), queryEmbedding, normalizedText)
    : null;
}

function createRankLimitContext(options: ToolSearchOptions): RankLimitContext {
  const tieBreaker = options.tieBreaker ?? 'name';
  const maxResults = normalizeLimit(options.limit);
  const offset = normalizeOffset(options.offset);
  return {
    compare: createMatchComparator(tieBreaker),
    tieBreaker,
    topLimit: maxResults === undefined ? undefined : maxResults + offset,
  };
}

function canUseOptimizedRanking(
  tools: QueryResult,
  context: RankingContext,
  limits: RankLimitContext,
): boolean {
  if (limits.topLimit === undefined || limits.topLimit <= 0) return false;
  if (limits.topLimit >= tools.length || context.ranker) return false;
  return limits.tieBreaker === 'name' || limits.tieBreaker === 'none';
}

function buildOptimizedMatches(
  tools: QueryResult,
  context: RankingContext,
  limits: RankLimitContext,
): ToolMatch[] {
  const scored = tools.map((tool) => ({
    tool,
    score: scoreToolMatchValue(tool, context),
    reasons: [],
  }));
  const top =
    limits.topLimit === undefined
      ? scored
      : selectTopMatches(scored, limits.topLimit, limits.compare);
  return buildMatches(
    top.map((match) => match.tool),
    context,
    undefined,
  );
}

function buildAllMatches(
  tools: QueryResult,
  context: RankingContext,
  topLimit: number | undefined,
): ToolMatch[] {
  return buildMatches(tools, context, topLimit);
}

function buildMatches(
  tools: readonly ToolDefinition[],
  context: RankingContext,
  topLimit: number | undefined,
): ToolMatch[] {
  const matches = tools
    .map((tool) => buildToolMatch(tool, context))
    .filter((entry): entry is ToolMatch => entry !== null);
  return topLimit === undefined ? matches : matches.slice(0, topLimit);
}

export function scoreToolMatchValue(tool: ToolDefinition, context: RankingContext): number {
  return (
    scoreTagMatchValue(tool, context) +
    scoreTextMatchValue(tool, context) +
    scoreEmbeddingMatchValue(tool, context)
  );
}

function scoreTagMatchValue(tool: ToolDefinition, context: RankingContext): number {
  return context.tagSet.size
    ? scoreTagMatchesValue(tool, context.tagSet, context.tagWeight, context.tagWeights)
    : 0;
}

function scoreTextMatchValue(tool: ToolDefinition, context: RankingContext): number {
  if (!context.normalizedText || context.textWeight === 0) return 0;
  return (
    scoreTextMatchValueFromIndex(context.resolveIndex(tool), context.normalizedText) *
    context.textWeight
  );
}

function scoreEmbeddingMatchValue(tool: ToolDefinition, context: RankingContext): number {
  if (!shouldScoreEmbedding(tool, context)) return 0;
  const score = scoreEmbeddingMatch(tool, context.normalizedText, context.queryEmbedding);
  return score ? score.score * context.textWeight : 0;
}

function shouldScoreEmbedding(
  tool: ToolDefinition,
  context: RankingContext,
): context is RankingContext & {
  normalizedText: NormalizedTextQuery;
  queryEmbedding: EmbeddingInfo;
} {
  return Boolean(
    context.normalizedText &&
    context.queryEmbedding &&
    (!context.embeddingCandidates || context.embeddingCandidates.has(tool)),
  );
}

export function buildToolMatch(tool: ToolDefinition, context: RankingContext): ToolMatch | null {
  const state = createMatchState(tool);
  applyTagMatch(state, context);
  applyTextMatch(state, context);
  applyEmbeddingMatch(state, context);
  const rankerResult = applyCustomRanker(state, context);
  if (rankerResult === 'exclude' || state.score < 0) return null;
  return buildMatchResult(state, context.explain);
}

type MatchState = {
  tool: ToolDefinition;
  score: number;
  reasons: string[];
  matches: ToolMatchDetails;
  index?: TextSearchIndex;
};

function createMatchState(tool: ToolDefinition): MatchState {
  return { tool, score: 0, reasons: [], matches: {} };
}

function getMatchIndex(state: MatchState, context: RankingContext): TextSearchIndex {
  state.index ??= context.resolveIndex(state.tool);
  return state.index;
}

function applyTagMatch(state: MatchState, context: RankingContext): void {
  if (!context.tagSet.size) return;
  const tagMatches = collectTagMatches(state.tool, context.tagSet);
  if (!tagMatches.length) return;
  state.score += scoreTagMatches(tagMatches, context.tagWeight, context.tagWeights);
  state.reasons.push(...tagMatches.map((tag) => `tag:${tag}`));
  if (context.explain) state.matches.tags = mergeUnique(state.matches.tags, tagMatches);
}

function applyTextMatch(state: MatchState, context: RankingContext): void {
  if (!context.normalizedText || context.textWeight === 0) return;
  const textScore = scoreTextMatchFromIndex(getMatchIndex(state, context), context.normalizedText);
  if (textScore.score <= 0) return;
  state.score += textScore.score * context.textWeight;
  state.reasons.push(...textScore.reasons.map((reason) => `text:${reason}`));
  if (context.explain) mergeTextDetails(state.matches, textScore);
}

function mergeTextDetails(
  matches: ToolMatchDetails,
  textScore: ReturnType<typeof scoreTextMatchFromIndex>,
): void {
  matches.fields = mergeUnique(matches.fields, textScore.fields);
  matches.tags = mergeUnique(matches.tags, textScore.tagMatches);
  matches.schemaKeys = mergeUnique(matches.schemaKeys, textScore.schemaMatches);
  matches.metadataKeys = mergeUnique(matches.metadataKeys, textScore.metadataMatches);
}

function applyEmbeddingMatch(state: MatchState, context: RankingContext): void {
  if (!shouldScoreEmbedding(state.tool, context)) return;
  const embeddingScore = scoreEmbeddingMatch(
    state.tool,
    context.normalizedText,
    context.queryEmbedding,
  );
  if (!embeddingScore) return;
  state.score += embeddingScore.score * context.textWeight;
  state.reasons.push(`embedding:${embeddingScore.field}:${embeddingScore.similarity.toFixed(2)}`);
  if (context.explain)
    state.matches.embedding = { field: embeddingScore.field, score: embeddingScore.similarity };
}

function applyCustomRanker(state: MatchState, context: RankingContext): 'exclude' | 'keep' {
  if (!context.ranker) return 'keep';
  const rankResult = context.ranker(state.tool, createRankerContext(state, context));
  if (!rankResult) return 'keep';
  if (typeof rankResult === 'number') {
    state.score += rankResult;
    return 'keep';
  }
  if (rankResult.exclude) return 'exclude';
  state.score = rankResult.override ? rankResult.score : state.score + rankResult.score;
  if (rankResult.reasons?.length) state.reasons.push(...rankResult.reasons);
  if (context.explain && rankResult.matches) mergeMatchDetails(state.matches, rankResult.matches);
  return 'keep';
}

function createRankerContext(state: MatchState, context: RankingContext): ToolRankContext {
  return {
    text: context.normalizedText,
    preferredTags: context.preferredTags,
    tagWeights: context.tagWeights,
    weights: { tags: context.tagWeight, text: context.textWeight },
    index: getMatchIndex(state, context),
  };
}

function buildMatchResult(state: MatchState, explain: boolean): ToolMatch {
  const result: ToolMatch = { tool: state.tool, score: state.score, reasons: state.reasons };
  if (explain) result.matches = state.matches;
  return result;
}
