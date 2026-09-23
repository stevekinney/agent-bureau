import { afterEach, expect, test } from 'bun:test';
import { readEnvironmentConfiguration } from './environment-configuration.ts';
import { resolveGeminiApiKey } from './providers/shared/gemini-api-key.ts';

const originalGoogleKey = process.env['GOOGLE_API_KEY'];
const originalBaseUrl = process.env['OPENAI_BASE_URL'];
const originalCollision = process.env['openai_base_url'];

afterEach(() => {
  if (originalGoogleKey === undefined) delete process.env['GOOGLE_API_KEY'];
  else process.env['GOOGLE_API_KEY'] = originalGoogleKey;
  if (originalBaseUrl === undefined) delete process.env['OPENAI_BASE_URL'];
  else process.env['OPENAI_BASE_URL'] = originalBaseUrl;
  if (originalCollision === undefined) delete process.env['openai_base_url'];
  else process.env['openai_base_url'] = originalCollision;
});

test('provider configuration stays lazy and preserves exact names and empty values', () => {
  delete process.env['GOOGLE_API_KEY'];
  delete process.env['OPENAI_BASE_URL'];
  process.env['openai_base_url'] = 'https://unrelated.invalid';
  expect(readEnvironmentConfiguration().googleApiKey).toBeUndefined();
  expect(readEnvironmentConfiguration().openaiBaseUrl).toBeUndefined();
  process.env['GOOGLE_API_KEY'] = 'first-key';
  process.env['OPENAI_BASE_URL'] = 'https://first.invalid';
  const first = readEnvironmentConfiguration();
  process.env['GOOGLE_API_KEY'] = '';
  process.env['OPENAI_BASE_URL'] = '';
  expect(readEnvironmentConfiguration().googleApiKey).toBe('');
  expect(readEnvironmentConfiguration().openaiBaseUrl).toBe('');
  expect(first.googleApiKey).toBe('first-key');
  expect(first.openaiBaseUrl).toBe('https://first.invalid');
});

test('credentials remain usable but are redacted during serialization', () => {
  process.env['GOOGLE_API_KEY'] = 'private-test-key';
  const configuration = readEnvironmentConfiguration();
  expect(configuration.googleApiKey).toBe('private-test-key');
  expect(JSON.stringify(configuration)).not.toContain('private-test-key');
  expect(JSON.stringify(configuration)).toContain('[redacted]');
});

test('explicit provider keys retain precedence including explicit empty values', () => {
  process.env['GOOGLE_API_KEY'] = 'environment-key';
  expect(resolveGeminiApiKey('explicit-key')).toBe('explicit-key');
  expect(resolveGeminiApiKey(undefined)).toBe('environment-key');
  expect(() => resolveGeminiApiKey('')).toThrow('Missing API key');
  delete process.env['GOOGLE_API_KEY'];
  expect(() => resolveGeminiApiKey(undefined)).toThrow('Missing API key');
});
