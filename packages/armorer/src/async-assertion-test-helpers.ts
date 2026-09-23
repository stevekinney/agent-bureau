import { expect } from 'bun:test';

export async function expectPromiseToReject(
  promise: PromiseLike<unknown>,
  assertion: (error: unknown) => void,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    assertion(error);
    return;
  }
  expect.unreachable('Expected promise to reject.');
}
