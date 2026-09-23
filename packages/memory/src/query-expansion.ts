import {
  KO_TRAILING_PARTICLES,
  STOP_WORDS_JA,
  STOP_WORDS_KO,
  STOP_WORDS_ZH,
} from './stop-words-east-asian';
import { STOP_WORDS_EN, STOP_WORDS_ES, STOP_WORDS_PT } from './stop-words-latin';

/**
 * Query expansion utilities for improving BM25 keyword search.
 *
 * Extracts meaningful keywords from conversational queries by removing stop
 * words, short tokens, pure numbers, and punctuation-only tokens. Supports
 * English, Spanish, Portuguese, Chinese, Korean, and Japanese.
 */

import { expandCJKUnigrams } from './text-search';

// ---------------------------------------------------------------------------
// Stop word lists
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripKoreanTrailingParticle(token: string): string | null {
  for (const particle of KO_TRAILING_PARTICLES) {
    if (token.length > particle.length && token.endsWith(particle)) {
      return token.slice(0, -particle.length);
    }
  }
  return null;
}

function isUsefulKoreanStem(stem: string): boolean {
  if (/[\uac00-\ud7af]/.test(stem)) return stem.length >= 2;
  return /^[a-z0-9_]+$/i.test(stem);
}

function appendScriptTokens(segment: string, tokens: string[]): void {
  const patterns = /[a-z0-9_]+|[\u30a0-\u30ffー]+|[\u4e00-\u9fff]+|[\u3040-\u309f]{2,}/g;
  const parts = segment.match(patterns) ?? [];
  for (const part of parts) {
    if (/^[\u4e00-\u9fff]+$/.test(part)) expandCJKUnigrams(part, tokens);
    else tokens.push(part);
  }
}

function appendChineseTokens(segment: string, tokens: string[]): void {
  const parts = segment.match(/[a-z0-9_]+|[\u4e00-\u9fff]+/g) ?? [];
  for (const part of parts) {
    if (/^[\u4e00-\u9fff]+$/.test(part)) expandCJKUnigrams(part, tokens);
    else tokens.push(part);
  }
}

function appendKoreanTokens(segment: string, tokens: string[]): void {
  const stem = stripKoreanTrailingParticle(segment);
  const stemIsStopWord = stem !== null && STOP_WORDS_KO.has(stem);
  if (!STOP_WORDS_KO.has(segment) && !stemIsStopWord) tokens.push(segment);
  if (stem && !STOP_WORDS_KO.has(stem) && isUsefulKoreanStem(stem)) tokens.push(stem);
}

/**
 * Returns true if the token is a stop word in any supported language.
 */
export function isStopWord(token: string): boolean {
  return (
    STOP_WORDS_EN.has(token) ||
    STOP_WORDS_ES.has(token) ||
    STOP_WORDS_PT.has(token) ||
    STOP_WORDS_ZH.has(token) ||
    STOP_WORDS_KO.has(token) ||
    STOP_WORDS_JA.has(token)
  );
}

function isValidKeyword(token: string): boolean {
  if (!token || token.length === 0) return false;
  // Single-character English tokens are likely stop words or fragments.
  // Two-character tokens (e.g., "db", "AI", "UI", "ML", "OS") are preserved
  // because they often represent meaningful technical abbreviations.
  if (/^[a-zA-Z]+$/.test(token) && token.length < 2) return false;
  // Pure numbers are not useful for semantic search.
  if (/^\d+$/.test(token)) return false;
  // All-punctuation tokens are not useful.
  if (/^[\p{P}\p{S}]+$/u.test(token)) return false;
  return true;
}

function tokenizeForKeywords(text: string): string[] {
  const tokens: string[] = [];
  const normalized = text.toLowerCase().trim();
  const segments = normalized.split(/[\s\p{P}]+/u).filter(Boolean);

  for (const segment of segments) {
    // Japanese text mixes scripts — extract script-specific chunks.
    if (/[\u3040-\u30ff]/.test(segment)) appendScriptTokens(segment, tokens);
    else if (/[\u4e00-\u9fff]/.test(segment)) appendChineseTokens(segment, tokens);
    else if (/[\uac00-\ud7af\u3131-\u3163]/.test(segment)) appendKoreanTokens(segment, tokens);
    else tokens.push(segment);
  }

  return tokens;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extracts meaningful keywords from a conversational query.
 *
 * Removes stop words, short tokens, numbers, and punctuation across
 * English, Spanish, Portuguese, Chinese, Korean, and Japanese.
 *
 * @example
 * extractKeywords('that thing we discussed about the API')
 * // → ['discussed', 'api']
 *
 * extractKeywords('之前讨论的那个方案')
 * // → ['讨论', '方案', '讨方'] (character bigrams)
 */
export function extractKeywords(query: string): string[] {
  const tokens = tokenizeForKeywords(query);
  const keywords: string[] = [];
  const seen = new Set<string>();

  for (const token of tokens) {
    if (isStopWord(token)) continue;
    if (!isValidKeyword(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    keywords.push(token);
  }

  return keywords;
}
