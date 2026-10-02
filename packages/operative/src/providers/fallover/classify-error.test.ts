/**
 * `classifyProviderError`'s `sampling-parameter-unsupported` branch and its
 * companion `extractSamplingParameterFields` (COR-989).
 *
 * The verbatim messages below were captured live from the Anthropic Messages
 * API on 2026-10-02 (`max_tokens: 1`, one user message, only the listed
 * parameter): `claude-opus-4-8` rejected `temperature: 0.5`, `top_p: 0.9`, and
 * `top_k: 5` with a 400 naming that one field, and `claude-sonnet-5` rejected
 * `temperature: 0.5` the same way. The full record lives in the header of
 * `test/provider-anthropic-sampling.test.ts`. Fixtures marked `synthetic` are
 * not responses the API returned: positives recombine only the recorded
 * sentences, and negatives are authored text.
 */
import { describe, expect, it } from 'bun:test';

import { classifyProviderError, extractSamplingParameterFields } from './classify-error.ts';

// Verbatim: claude-opus-4-8 and claude-sonnet-5, `temperature: 0.5`.
const TEMPERATURE_DEPRECATED = '`temperature` is deprecated for this model.';
// Verbatim: claude-opus-4-8, `top_p: 0.9`.
const TOP_P_DEPRECATED = '`top_p` is deprecated for this model.';
// Verbatim: claude-opus-4-8, `top_k: 5`.
const TOP_K_DEPRECATED = '`top_k` is deprecated for this model.';

/**
 * Mirrors the SDK's `APIError.makeMessage` for a parsed body with no top-level
 * `message`: the status, a space, then the whole body stringified. `status` is
 * set as an own property because `extractStatusCode` reads it from there.
 */
function anthropicError(message: string, status?: number): Error {
  const body = JSON.stringify({
    type: 'error',
    error: { type: 'invalid_request_error', message },
    request_id: 'req_011CfdsPMwH14uBNi4UpGWt9',
  });
  const error = new Error(status === undefined ? body : `${status} ${body}`);
  if (status !== undefined) Object.assign(error, { status });
  return error;
}

describe('classifyProviderError — sampling-parameter-unsupported', () => {
  it.each([TEMPERATURE_DEPRECATED, TOP_P_DEPRECATED, TOP_K_DEPRECATED])(
    'classifies the verbatim 400 %p as sampling-parameter-unsupported',
    (message) => {
      expect(classifyProviderError(anthropicError(message, 400))).toBe(
        'sampling-parameter-unsupported',
      );
    },
  );

  it('leaves the matching message unknown when no status is present', () => {
    expect(classifyProviderError(anthropicError(TEMPERATURE_DEPRECATED))).toBe('unknown');
  });

  it('leaves the matching message unknown under a 422', () => {
    expect(classifyProviderError(anthropicError(TEMPERATURE_DEPRECATED, 422))).toBe('unknown');
  });

  it.each([
    [401, 'auth'],
    [429, 'rate-limit'],
    [500, 'server-error'],
  ] as const)('lets status %p win over the matching message (%p)', (status, expected) => {
    expect(classifyProviderError(anthropicError(TEMPERATURE_DEPRECATED, status))).toBe(expected);
  });

  it('lets the overflow check win when the message also mentions max_tokens', () => {
    // synthetic: a recorded sentence plus an overflow marker.
    const error = anthropicError(`${TEMPERATURE_DEPRECATED} max_tokens`, 400);
    expect(classifyProviderError(error)).toBe('overflow');
  });

  it.each([
    // synthetic: names a field but carries no rejection phrase.
    [
      'a field without the rejection phrase',
      '`temperature`: Input should be less than or equal to 1',
    ],
    // synthetic: the rejection phrase with a name that only starts like a field.
    ['the rejection phrase without a field', '`top_probability` is deprecated for this model.'],
    // synthetic: an unrelated invalid_request_error.
    ['an unrelated invalid request', 'messages: at least one message is required'],
    // synthetic: the "use only one" failure, which is out of scope.
    [
      'the cannot-both-be-specified rejection',
      '`temperature` and `top_p` cannot both be specified for this model. Please use only one.',
    ],
  ])('leaves %s unknown under a 400', (_label, message) => {
    expect(classifyProviderError(anthropicError(message, 400))).toBe('unknown');
  });
});

describe('extractSamplingParameterFields', () => {
  it('returns the one field a verbatim message names', () => {
    expect(extractSamplingParameterFields(anthropicError(TOP_P_DEPRECATED, 400))).toEqual([
      'top_p',
    ]);
  });

  it('returns top_k from its verbatim message', () => {
    expect(extractSamplingParameterFields(anthropicError(TOP_K_DEPRECATED, 400))).toEqual([
      'top_k',
    ]);
  });

  it('returns two fields in fixed order, not order of appearance', () => {
    // synthetic: two recorded sentences joined, top_p first.
    const error = anthropicError(`${TOP_P_DEPRECATED} ${TEMPERATURE_DEPRECATED}`, 400);
    expect(extractSamplingParameterFields(error)).toEqual(['temperature', 'top_p']);
  });

  it('returns a repeated field once', () => {
    // synthetic: one recorded sentence repeated.
    const error = anthropicError(`${TEMPERATURE_DEPRECATED} ${TEMPERATURE_DEPRECATED}`, 400);
    expect(extractSamplingParameterFields(error)).toEqual(['temperature']);
  });

  it('returns an empty array for a non-matching error', () => {
    const error = anthropicError('messages: at least one message is required', 400);
    expect(extractSamplingParameterFields(error)).toEqual([]);
  });

  it('returns an empty array for the cannot-both-be-specified rejection', () => {
    // synthetic, as above.
    const error = anthropicError(
      '`temperature` and `top_p` cannot both be specified for this model. Please use only one.',
      400,
    );
    expect(extractSamplingParameterFields(error)).toEqual([]);
  });

  it('extracts at least one field from every error classified as sampling-parameter-unsupported', () => {
    const errors = [
      anthropicError(TEMPERATURE_DEPRECATED, 400),
      anthropicError(TOP_P_DEPRECATED, 400),
      anthropicError(TOP_K_DEPRECATED, 400),
      // synthetic: two recorded sentences joined.
      anthropicError(`${TOP_K_DEPRECATED} ${TEMPERATURE_DEPRECATED}`, 400),
    ];

    for (const error of errors) {
      expect(classifyProviderError(error)).toBe('sampling-parameter-unsupported');
      expect(extractSamplingParameterFields(error).length).toBeGreaterThan(0);
    }
  });
});
