import type { MessageUpdate } from './conversation';

const allowedUpdate = { content: 'Allowed' } satisfies MessageUpdate;

// @ts-expect-error Message identity cannot be changed by an update.
const invalidIdentifier: MessageUpdate = { id: 'other' };

// @ts-expect-error Message order cannot be changed by an update.
const invalidPosition: MessageUpdate = { position: 42 };

void allowedUpdate;
void invalidIdentifier;
void invalidPosition;
