import type { MessageUpdate } from './conversation';
import type { MessageUpdate as RootMessageUpdate } from './index';

const allowedUpdate = { content: 'Allowed' } satisfies MessageUpdate;
const allowedRootUpdate = { hidden: true } satisfies RootMessageUpdate;

// @ts-expect-error Message identity cannot be changed by an update.
const invalidIdentifier: MessageUpdate = { id: 'other' };

// @ts-expect-error Message order cannot be changed by an update.
const invalidPosition: MessageUpdate = { position: 42 };

void allowedUpdate;
void allowedRootUpdate;
void invalidIdentifier;
void invalidPosition;
