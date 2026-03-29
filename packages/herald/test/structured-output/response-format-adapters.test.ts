import { describe, expect, it } from 'bun:test';

import {
  toGeminiResponseFormat,
  toOpenAIResponseFormat,
} from '../../src/structured-output/response-format-adapters.ts';
import type { ResponseFormat } from '../../src/structured-output/types.ts';

describe('toOpenAIResponseFormat', () => {
  it('returns undefined for text format', () => {
    const format: ResponseFormat = { type: 'text' };
    expect(toOpenAIResponseFormat(format)).toBeUndefined();
  });

  it('maps json to json_object type', () => {
    const format: ResponseFormat = { type: 'json' };
    expect(toOpenAIResponseFormat(format)).toEqual({ type: 'json_object' });
  });

  it('maps json_schema to the structured output format with strict mode', () => {
    const schema = { type: 'object', properties: { name: { type: 'string' } } };
    const format: ResponseFormat = { type: 'json_schema', schema, name: 'user' };
    expect(toOpenAIResponseFormat(format)).toEqual({
      type: 'json_schema',
      json_schema: { name: 'user', schema, strict: true },
    });
  });

  it('uses "response" as the default name when none is provided', () => {
    const schema = { type: 'object', properties: {} };
    const format: ResponseFormat = { type: 'json_schema', schema };
    const result = toOpenAIResponseFormat(format);
    expect(result).toEqual({
      type: 'json_schema',
      json_schema: { name: 'response', schema, strict: true },
    });
  });
});

describe('toGeminiResponseFormat', () => {
  it('returns undefined for text format', () => {
    const format: ResponseFormat = { type: 'text' };
    expect(toGeminiResponseFormat(format)).toBeUndefined();
  });

  it('maps json to application/json mime type', () => {
    const format: ResponseFormat = { type: 'json' };
    expect(toGeminiResponseFormat(format)).toEqual({
      response_mime_type: 'application/json',
    });
  });

  it('maps json_schema to mime type with response_schema', () => {
    const schema = { type: 'object', properties: { name: { type: 'string' } } };
    const format: ResponseFormat = { type: 'json_schema', schema };
    expect(toGeminiResponseFormat(format)).toEqual({
      response_mime_type: 'application/json',
      response_schema: schema,
    });
  });
});
