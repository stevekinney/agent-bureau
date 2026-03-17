import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import {
  conversationSchema,
  conversationShape,
  jsonValueSchema,
  messageInputSchema,
  messageRoleSchema,
  messageSchema,
  multiModalContentSchema,
  tokenUsageSchema,
  toolCallSchema,
  toolResultSchema,
} from '../src/schemas';
import { CURRENT_SCHEMA_VERSION } from '../src/versioning';

describe('schemas', () => {
  test('messageRoleSchema accepts tool-use literal', () => {
    const res = messageRoleSchema.safeParse('tool-use');
    expect(res.success).toBeTrue();
  });

  test('multiModalContentSchema validates url', () => {
    const ok = multiModalContentSchema.safeParse({
      type: 'image',
      url: 'https://example.com/a.png',
    });
    expect(ok.success).toBeTrue();
  });

  test('jsonValueSchema rejects non-JSON values', () => {
    expect(jsonValueSchema.safeParse(new Date()).success).toBeFalse();
    expect(jsonValueSchema.safeParse(Number.POSITIVE_INFINITY).success).toBeFalse();
  });

  test('jsonValueSchema rejects non-plain objects', () => {
    const value = Object.create({}) as Record<string, unknown>;
    value.name = 'test';
    const result = jsonValueSchema.safeParse(value);
    expect(result.success).toBeFalse();
    if (!result.success) {
      const messages = result.error.issues.flatMap((issue) => {
        if (issue.code === 'invalid_union') {
          const errors = (issue as { errors: Array<Array<{ message: string }>> }).errors;
          return errors.flat().map((nested) => nested.message);
        }
        return issue.message;
      });
      expect(messages).toContain('expected a plain object');
    }
  });

  test('messageSchema basic shape', () => {
    const m = {
      id: 'id',
      role: 'user',
      content: 'hi',
      position: 0,
      createdAt: new Date().toISOString(),
      metadata: {},
      hidden: false,
    } as const;
    const res = messageSchema.safeParse(m);
    expect(res.success).toBeTrue();
  });

  test('conversationSchema basic shape', () => {
    const now = new Date().toISOString();
    const c = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      id: 'c1',
      status: 'active',
      metadata: {},
      ids: [],
      messages: {},
      createdAt: now,
      updatedAt: now,
    } as const;
    const res = conversationSchema.safeParse(c);
    expect(res.success).toBeTrue();
  });

  test('conversationShape is exported', () => {
    expect(conversationShape).toBeDefined();
    expect(typeof conversationShape).toBe('object');
  });

  test('conversationShape has all required fields', () => {
    expect(conversationShape).toHaveProperty('schemaVersion');
    expect(conversationShape).toHaveProperty('id');
    expect(conversationShape).toHaveProperty('title');
    expect(conversationShape).toHaveProperty('status');
    expect(conversationShape).toHaveProperty('metadata');
    expect(conversationShape).toHaveProperty('ids');
    expect(conversationShape).toHaveProperty('messages');
    expect(conversationShape).toHaveProperty('createdAt');
    expect(conversationShape).toHaveProperty('updatedAt');
  });

  test('conversationShape includes id field', () => {
    expect('id' in conversationShape).toBe(true);
    // Verify id is a zod string schema
    expect(conversationShape.id).toBeDefined();
  });

  test('conversationShape can be used to create a ZodObject', () => {
    const schemaFromShape = z.object(conversationShape);
    expect(schemaFromShape).toBeDefined();

    const now = new Date().toISOString();
    const testData = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      id: 'test-id',
      status: 'active' as const,
      metadata: {},
      ids: [],
      messages: {},
      createdAt: now,
      updatedAt: now,
    };

    const result = schemaFromShape.safeParse(testData);
    expect(result.success).toBe(true);
  });

  test('conversationSchema.shape matches conversationShape', () => {
    // The schema should be built from the shape
    const schemaShape = (conversationSchema as any).shape;

    // Check that the same fields exist
    expect('schemaVersion' in schemaShape).toBe(true);
    expect('id' in schemaShape).toBe(true);
    expect('title' in schemaShape).toBe(true);
    expect('status' in schemaShape).toBe(true);
    expect('metadata' in schemaShape).toBe(true);
    expect('ids' in schemaShape).toBe(true);
    expect('messages' in schemaShape).toBe(true);
    expect('createdAt' in schemaShape).toBe(true);
    expect('updatedAt' in schemaShape).toBe(true);
  });

  test('conversationShape works with storage systems', () => {
    // Simulate what a storage system would do
    const hasIdField = 'id' in conversationShape;
    expect(hasIdField).toBe(true);

    // Storage system should detect this and not add its own id field
    const enhancedShape = {
      ...conversationShape,
      // Only add id if not present (simulating storage-unit behavior)
      ...(!hasIdField ? { id: z.string() } : {}),
      type: z.literal('conversation'),
    };

    const schema = z.object(enhancedShape);

    const now = new Date().toISOString();
    const testData = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      id: 'original-id',
      type: 'conversation',
      status: 'active' as const,
      metadata: {},
      ids: [],
      messages: {},
      createdAt: now,
      updatedAt: now,
    };

    const result = schema.safeParse(testData);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe('original-id');
    }
  });
});

describe('Standard Schema compliance', () => {
  test('all schemas have ~standard property', () => {
    const schemas = [
      conversationSchema,
      jsonValueSchema,
      messageSchema,
      messageInputSchema,
      messageRoleSchema,
      multiModalContentSchema,
      toolCallSchema,
      toolResultSchema,
      tokenUsageSchema,
    ];

    for (const schema of schemas) {
      expect(schema).toHaveProperty('~standard');
      expect(schema['~standard']).toHaveProperty('version', 1);
      expect(schema['~standard']).toHaveProperty('vendor', 'zod');
      expect(typeof schema['~standard'].validate).toBe('function');
    }
  });

  test('~standard.validate returns success result for valid data', async () => {
    const validConversation = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      id: 'conv-1',
      status: 'active',
      metadata: {},
      ids: [],
      messages: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const result = await conversationSchema['~standard'].validate(validConversation);
    expect(result).not.toHaveProperty('issues');
    expect(result).toHaveProperty('value');
  });

  test('~standard.validate returns failure result for invalid data', async () => {
    const invalidData = { invalid: true };
    const result = await conversationSchema['~standard'].validate(invalidData);
    expect(result).toHaveProperty('issues');
    expect(Array.isArray(result.issues)).toBe(true);
  });
});
