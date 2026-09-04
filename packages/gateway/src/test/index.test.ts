import { describe, expect, it } from 'bun:test';

import { createGatewayAuthorityTestApiKey, createTestGateway } from './index';

describe('createGatewayAuthorityTestApiKey', () => {
  it('throws when the gateway bureau has no KV-backed store configured', async () => {
    const gateway = await createTestGateway();

    let rejection: unknown;
    try {
      await createGatewayAuthorityTestApiKey(gateway);
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toBe(
      'Authority regression tests require a gateway with a KV-backed bureau',
    );
  });
});
