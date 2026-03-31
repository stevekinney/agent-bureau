import { describe, expect, it } from 'bun:test';

import { createGroundingValidator } from './grounding';

const baseContext = { step: 1, conversationLength: 3, toolCallCount: 0 };

describe('createGroundingValidator', () => {
  it('returns a validator with the name "grounding"', () => {
    const validator = createGroundingValidator();
    expect(validator.name).toBe('grounding');
  });

  it('passes output that contains no claims', async () => {
    const validator = createGroundingValidator();
    const result = await validator.validate('I can help with that!', baseContext);
    expect(result.valid).toBe(true);
  });

  it('passes output where numbers appear in the conversation context', async () => {
    const validator = createGroundingValidator({
      conversationText: 'The temperature is 72 degrees.',
    });
    const result = await validator.validate('The temperature is 72 degrees.', baseContext);
    expect(result.valid).toBe(true);
  });

  it('flags output with ungrounded URLs', async () => {
    const validator = createGroundingValidator({
      conversationText: 'Tell me about the weather.',
    });
    const result = await validator.validate(
      'Check out https://example.com/weather for more details.',
      baseContext,
    );
    expect(result.valid).toBe(false);
    expect(result.category).toBe('grounding');
  });

  it('passes output with grounded URLs', async () => {
    const validator = createGroundingValidator({
      conversationText: 'The documentation is at https://docs.example.com/api.',
    });
    const result = await validator.validate(
      'You can find it at https://docs.example.com/api.',
      baseContext,
    );
    expect(result.valid).toBe(true);
  });

  it('flags output with ungrounded numbers with units', async () => {
    const validator = createGroundingValidator({
      conversationText: 'Tell me about the building.',
    });
    const result = await validator.validate(
      'The building is 450 meters tall and was built in 1985.',
      baseContext,
    );
    expect(result.valid).toBe(false);
  });

  it('passes output with grounded numbers', async () => {
    const validator = createGroundingValidator({
      conversationText: 'The building is 450 meters tall.',
    });
    const result = await validator.validate('It is 450 meters in height.', baseContext);
    expect(result.valid).toBe(true);
  });

  it('uses custom groundingThreshold', async () => {
    const validator = createGroundingValidator({
      conversationText: 'The price is $50.',
      groundingThreshold: 0.5,
    });
    // Two claims: $50 (grounded) and $100 (ungrounded) — ratio 0.5 meets threshold
    const result = await validator.validate('Items cost $50 and $100.', baseContext);
    expect(result.valid).toBe(true);
  });

  it('flags when ratio is below threshold', async () => {
    const validator = createGroundingValidator({
      conversationText: 'Hello.',
      groundingThreshold: 0.8,
    });
    const result = await validator.validate('The answer is 42 km and costs $99.', baseContext);
    expect(result.valid).toBe(false);
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('handles empty output', async () => {
    const validator = createGroundingValidator();
    const result = await validator.validate('', baseContext);
    expect(result.valid).toBe(true);
  });

  it('flags quoted text not found in conversation', async () => {
    const validator = createGroundingValidator({
      conversationText: 'Tell me a fact.',
    });
    const result = await validator.validate(
      'As the saying goes, "the early bird catches the worm" and "time is money".',
      baseContext,
    );
    expect(result.valid).toBe(false);
  });

  it('passes quoted text found in conversation', async () => {
    const validator = createGroundingValidator({
      conversationText: 'The motto is "the early bird catches the worm".',
    });
    const result = await validator.validate(
      'As you mentioned, "the early bird catches the worm".',
      baseContext,
    );
    expect(result.valid).toBe(true);
  });
});
