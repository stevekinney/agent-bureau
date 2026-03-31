import { describe, expect, it } from 'bun:test';

import { createOutputPIIValidator } from './output-pii';

const baseContext = { step: 1, conversationLength: 3, toolCallCount: 0 };

describe('createOutputPIIValidator', () => {
  it('returns a validator with the name "output-pii"', () => {
    const validator = createOutputPIIValidator();
    expect(validator.name).toBe('output-pii');
  });

  it('passes output with no PII', async () => {
    const validator = createOutputPIIValidator();
    const result = await validator.validate('The weather is nice today.', baseContext);
    expect(result.valid).toBe(true);
  });

  describe('email detection', () => {
    it('detects email addresses', async () => {
      const validator = createOutputPIIValidator();
      const result = await validator.validate(
        'Contact us at john.doe@example.com for more info.',
        baseContext,
      );
      expect(result.valid).toBe(false);
      expect(result.category).toBe('pii');
    });

    it('provides redacted version with email replaced', async () => {
      const validator = createOutputPIIValidator();
      const result = await validator.validate('Email me at test@example.com please.', baseContext);
      expect(result.redacted).toContain('[EMAIL_REDACTED]');
      expect(result.redacted).not.toContain('test@example.com');
    });
  });

  describe('phone detection', () => {
    it('detects phone numbers', async () => {
      const validator = createOutputPIIValidator();
      const result = await validator.validate('Call me at 555-123-4567.', baseContext);
      expect(result.valid).toBe(false);
    });

    it('provides redacted version with phone replaced', async () => {
      const validator = createOutputPIIValidator();
      const result = await validator.validate('My number is (555) 123-4567.', baseContext);
      expect(result.redacted).toContain('[PHONE_REDACTED]');
    });

    it('detects phone numbers with country code', async () => {
      const validator = createOutputPIIValidator();
      const result = await validator.validate('Call +1-555-123-4567 for support.', baseContext);
      expect(result.valid).toBe(false);
    });
  });

  describe('API key detection', () => {
    it('detects API key patterns', async () => {
      const validator = createOutputPIIValidator();
      const result = await validator.validate(
        'Your api_key=sk_live_abcdef1234567890 is active.',
        baseContext,
      );
      expect(result.valid).toBe(false);
    });

    it('provides redacted version with key replaced', async () => {
      const validator = createOutputPIIValidator();
      const result = await validator.validate(
        'Set token="abcdef1234567890ab" in your config.',
        baseContext,
      );
      expect(result.redacted).toContain('[KEY_REDACTED]');
    });
  });

  describe('multiple PII types', () => {
    it('detects and redacts multiple PII types in one string', async () => {
      const validator = createOutputPIIValidator();
      const result = await validator.validate(
        'Contact john@example.com or call 555-123-4567.',
        baseContext,
      );
      expect(result.valid).toBe(false);
      expect(result.redacted).toContain('[EMAIL_REDACTED]');
      expect(result.redacted).toContain('[PHONE_REDACTED]');
    });
  });

  it('returns confidence 1.0 when PII is found', async () => {
    const validator = createOutputPIIValidator();
    const result = await validator.validate('Email: user@domain.com', baseContext);
    expect(result.confidence).toBe(1.0);
  });

  it('returns confidence 0 when no PII is found', async () => {
    const validator = createOutputPIIValidator();
    const result = await validator.validate('Just some text.', baseContext);
    expect(result.confidence).toBe(0);
  });
});
