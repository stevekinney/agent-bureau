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

const STOP_WORDS_EN = new Set([
  // Articles and determiners
  'a',
  'an',
  'the',
  'this',
  'that',
  'these',
  'those',
  // Pronouns
  'i',
  'me',
  'my',
  'we',
  'our',
  'you',
  'your',
  'he',
  'she',
  'it',
  'they',
  'them',
  // Common verbs
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'could',
  'should',
  'can',
  'may',
  'might',
  // Prepositions
  'in',
  'on',
  'at',
  'to',
  'for',
  'of',
  'with',
  'by',
  'from',
  'about',
  'into',
  'through',
  'during',
  'before',
  'after',
  'above',
  'below',
  'between',
  'under',
  'over',
  // Conjunctions
  'and',
  'or',
  'but',
  'if',
  'then',
  'because',
  'as',
  'while',
  'when',
  'where',
  'what',
  'which',
  'who',
  'how',
  'why',
  // Time references (vague)
  'yesterday',
  'today',
  'tomorrow',
  'earlier',
  'later',
  'recently',
  'ago',
  'just',
  'now',
  // Vague references
  'thing',
  'things',
  'stuff',
  'something',
  'anything',
  'everything',
  'nothing',
  // Question/request words
  'please',
  'help',
  'find',
  'show',
  'get',
  'tell',
  'give',
]);

const STOP_WORDS_ES = new Set([
  'el',
  'la',
  'los',
  'las',
  'un',
  'una',
  'unos',
  'unas',
  'este',
  'esta',
  'ese',
  'esa',
  'yo',
  'me',
  'mi',
  'nosotros',
  'nosotras',
  'tu',
  'tus',
  'usted',
  'ustedes',
  'ellos',
  'ellas',
  'de',
  'del',
  'a',
  'en',
  'con',
  'por',
  'para',
  'sobre',
  'entre',
  'y',
  'o',
  'pero',
  'si',
  'porque',
  'como',
  'es',
  'son',
  'fue',
  'fueron',
  'ser',
  'estar',
  'haber',
  'tener',
  'hacer',
  'ayer',
  'hoy',
  'mañana',
  'antes',
  'despues',
  'después',
  'ahora',
  'recientemente',
  'que',
  'qué',
  'cómo',
  'cuando',
  'cuándo',
  'donde',
  'dónde',
  'porqué',
  'favor',
  'ayuda',
]);

const STOP_WORDS_PT = new Set([
  'o',
  'a',
  'os',
  'as',
  'um',
  'uma',
  'uns',
  'umas',
  'este',
  'esta',
  'esse',
  'essa',
  'eu',
  'me',
  'meu',
  'minha',
  'nos',
  'nós',
  'você',
  'vocês',
  'ele',
  'ela',
  'eles',
  'elas',
  'de',
  'do',
  'da',
  'em',
  'com',
  'por',
  'para',
  'sobre',
  'entre',
  'e',
  'ou',
  'mas',
  'se',
  'porque',
  'como',
  'é',
  'são',
  'foi',
  'foram',
  'ser',
  'estar',
  'ter',
  'fazer',
  'ontem',
  'hoje',
  'amanhã',
  'antes',
  'depois',
  'agora',
  'recentemente',
  'que',
  'quê',
  'quando',
  'onde',
  'porquê',
  'favor',
  'ajuda',
]);

const STOP_WORDS_ZH = new Set([
  '我',
  '我们',
  '你',
  '你们',
  '他',
  '她',
  '它',
  '他们',
  '这',
  '那',
  '这个',
  '那个',
  '这些',
  '那些',
  '的',
  '了',
  '着',
  '过',
  '得',
  '地',
  '吗',
  '呢',
  '吧',
  '啊',
  '呀',
  '嘛',
  '啦',
  '是',
  '有',
  '在',
  '被',
  '把',
  '给',
  '让',
  '用',
  '到',
  '去',
  '来',
  '做',
  '说',
  '看',
  '找',
  '想',
  '要',
  '能',
  '会',
  '可以',
  '和',
  '与',
  '或',
  '但',
  '但是',
  '因为',
  '所以',
  '如果',
  '虽然',
  '而',
  '也',
  '都',
  '就',
  '还',
  '又',
  '再',
  '才',
  '只',
  '之前',
  '以前',
  '之后',
  '以后',
  '刚才',
  '现在',
  '昨天',
  '今天',
  '明天',
  '最近',
  '东西',
  '事情',
  '事',
  '什么',
  '哪个',
  '哪些',
  '怎么',
  '为什么',
  '多少',
  '请',
  '帮',
  '帮忙',
  '告诉',
]);

const STOP_WORDS_KO = new Set([
  '은',
  '는',
  '이',
  '가',
  '을',
  '를',
  '의',
  '에',
  '에서',
  '로',
  '으로',
  '와',
  '과',
  '도',
  '만',
  '까지',
  '부터',
  '한테',
  '에게',
  '께',
  '처럼',
  '같이',
  '보다',
  '마다',
  '밖에',
  '대로',
  '나',
  '나는',
  '내가',
  '나를',
  '너',
  '우리',
  '저',
  '저희',
  '그',
  '그녀',
  '그들',
  '이것',
  '저것',
  '그것',
  '여기',
  '저기',
  '거기',
  '있다',
  '없다',
  '하다',
  '되다',
  '이다',
  '아니다',
  '보다',
  '주다',
  '오다',
  '가다',
  '것',
  '거',
  '등',
  '수',
  '때',
  '곳',
  '중',
  '분',
  '잘',
  '더',
  '또',
  '매우',
  '정말',
  '아주',
  '많이',
  '너무',
  '좀',
  '그리고',
  '하지만',
  '그래서',
  '그런데',
  '그러나',
  '또는',
  '그러면',
  '왜',
  '어떻게',
  '뭐',
  '언제',
  '어디',
  '누구',
  '무엇',
  '어떤',
  '어제',
  '오늘',
  '내일',
  '최근',
  '지금',
  '아까',
  '나중',
  '전에',
  '제발',
  '부탁',
]);

const KO_TRAILING_PARTICLES = [
  '에서',
  '으로',
  '에게',
  '한테',
  '처럼',
  '같이',
  '보다',
  '까지',
  '부터',
  '마다',
  '밖에',
  '대로',
  '은',
  '는',
  '이',
  '가',
  '을',
  '를',
  '의',
  '에',
  '로',
  '와',
  '과',
  '도',
  '만',
].sort((a, b) => b.length - a.length);

const STOP_WORDS_JA = new Set([
  'これ',
  'それ',
  'あれ',
  'この',
  'その',
  'あの',
  'ここ',
  'そこ',
  'あそこ',
  'する',
  'した',
  'して',
  'です',
  'ます',
  'いる',
  'ある',
  'なる',
  'できる',
  'の',
  'こと',
  'もの',
  'ため',
  'そして',
  'しかし',
  'また',
  'でも',
  'から',
  'まで',
  'より',
  'だけ',
  'なぜ',
  'どう',
  '何',
  'いつ',
  'どこ',
  '誰',
  'どれ',
  '昨日',
  '今日',
  '明日',
  '最近',
  '今',
  'さっき',
  '前',
  '後',
]);

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
    if (/[\u3040-\u30ff]/.test(segment)) {
      const parts =
        segment.match(/[a-z0-9_]+|[\u30a0-\u30ffー]+|[\u4e00-\u9fff]+|[\u3040-\u309f]{2,}/g) ?? [];
      for (const part of parts) {
        if (/^[\u4e00-\u9fff]+$/.test(part)) {
          expandCJKUnigrams(part, tokens);
        } else {
          tokens.push(part);
        }
      }
    } else if (/[\u4e00-\u9fff]/.test(segment)) {
      // Chinese — split into Latin and CJK runs; generate CJK unigrams + bigrams.
      const parts = segment.match(/[a-z0-9_]+|[\u4e00-\u9fff]+/g) ?? [];
      for (const part of parts) {
        if (/^[\u4e00-\u9fff]+$/.test(part)) {
          expandCJKUnigrams(part, tokens);
        } else {
          tokens.push(part);
        }
      }
    } else if (/[\uac00-\ud7af\u3131-\u3163]/.test(segment)) {
      // Korean — keep word, strip trailing particles.
      const stem = stripKoreanTrailingParticle(segment);
      const stemIsStopWord = stem !== null && STOP_WORDS_KO.has(stem);
      if (!STOP_WORDS_KO.has(segment) && !stemIsStopWord) {
        tokens.push(segment);
      }
      if (stem && !STOP_WORDS_KO.has(stem) && isUsefulKoreanStem(stem)) {
        tokens.push(stem);
      }
    } else {
      tokens.push(segment);
    }
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
