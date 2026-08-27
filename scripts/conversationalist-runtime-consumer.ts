export const RUNTIME_CONSUMER_SCRIPT = `import assert from 'node:assert/strict';

import {
  Conversation,
  createConversationHistory as createControllerHistory,
  createPublicConversationProjection,
  defineMessagePlugin,
} from 'conversationalist';
import {
  appendToolCall,
  appendToolResult,
  appendUserMessage,
  createConversationHistory,
  removeMessage,
  replaceToolResult,
  setMessageHidden,
  updateMessage,
  validateConversationHistoryIntegrity,
} from 'conversationalist/conversation';

let history = createConversationHistory();
history = appendUserMessage(history, 'Hello');
history = appendToolCall(history, { id: 'external-call', name: 'external_call', arguments: {} });
history = appendToolResult(history, {
  callId: 'external-call',
  outcome: 'action_required',
  content: { pending: true },
  action: { type: 'approval', message: 'Approve?' },
});

assert.equal(history.ids.length, 3, 'expected one user, one tool-call, one tool-result message');

const snapshot = structuredClone(history);
const [userMessageId, , toolResultMessageId] = history.ids;
assert.ok(userMessageId, 'expected a user message id');
assert.ok(toolResultMessageId, 'expected a tool-result message id');

function assertBaselineUnchanged() {
  assert.deepStrictEqual(history, snapshot, 'baseline history mutated in place');
  for (const id of history.ids) {
    assert.deepStrictEqual(history.messages[id], snapshot.messages[id], \`message \${id} mutated in place\`);
  }
}

// updateMessage
const updated = updateMessage(history, userMessageId, { content: 'Updated' });
assert.equal(updated.messages[userMessageId].content, 'Updated');
assertBaselineUnchanged();
assert.deepStrictEqual(validateConversationHistoryIntegrity(updated), []);

// setMessageHidden
const hidden = setMessageHidden(history, userMessageId, true);
assert.equal(hidden.messages[userMessageId].hidden, true);
assertBaselineUnchanged();
assert.deepStrictEqual(validateConversationHistoryIntegrity(hidden), []);

// replaceToolResult
const replacedResult = { callId: 'external-call', outcome: 'success', content: { verified: true } };
const replaced = replaceToolResult(history, 'external-call', replacedResult);
const replacedMessage = Object.values(replaced.messages).find(
  (message) => message.toolResult?.callId === 'external-call',
);
assert.ok(replacedMessage, 'expected a message carrying the replaced tool result');
assert.deepStrictEqual(replacedMessage.toolResult, replacedResult);
assertBaselineUnchanged();
assert.deepStrictEqual(validateConversationHistoryIntegrity(replaced), []);

// removeMessage
const removed = removeMessage(history, toolResultMessageId);
assert.equal(removed.ids.length, 2, 'expected exactly two messages after removal');
assert.equal(removed.messages[removed.ids[0]].position, 0);
assert.equal(removed.messages[removed.ids[1]].position, 1);
assertBaselineUnchanged();
assert.deepStrictEqual(validateConversationHistoryIntegrity(removed), []);

// Unknown identifiers: every helper returns the exact input object unchanged.
assert.strictEqual(updateMessage(history, 'unknown-id', { content: 'x' }), history);
assert.strictEqual(setMessageHidden(history, 'unknown-id', true), history);
assert.strictEqual(replaceToolResult(history, 'unknown-call', replacedResult), history);
assert.strictEqual(removeMessage(history, 'unknown-id'), history);
assertBaselineUnchanged();

const controller = new Conversation(createControllerHistory({ id: 'runtime-controller' }));
const initialStoreSnapshot = controller.getServerSnapshot();
let notifications = 0;
const unsubscribe = controller.subscribe(() => notifications++);
controller.appendUserMessage('observed');
assert.equal(notifications, 1);
assert.equal(controller.getSnapshot().revision, 1);
assert.notStrictEqual(controller.getSnapshot(), initialStoreSnapshot);
unsubscribe();
controller.complete();
assert.equal(controller.lifecycle, 'closed');
assert.throws(
  () => controller.appendAssistantMessage('rejected'),
  (error) => error?.code === 'error:conversation-closed',
);
await controller.dispose();
assert.equal(controller.lifecycle, 'disposed');

async function handleTenant(tenant, secret) {
  const plugin = defineMessagePlugin({ id: 'tenant-' + tenant, revision: 1 }, (input) => ({
    ...input,
    metadata: { ...input.metadata, tenantPlugin: tenant },
  }));
  const requestController = new Conversation(
    createControllerHistory({
      id: tenant,
      metadata: { credential: secret, managedAssetGrant: 'asset-' + tenant },
    }),
    { plugins: [plugin] },
  );
  requestController.appendUserMessage('Contact ' + tenant + '@example.com with api_key=' + secret);
  requestController.appendMessages({
    role: 'assistant',
    content: 'hidden provider reasoning',
    hidden: true,
  });
  const projected = createPublicConversationProjection(requestController.current);
  await requestController.dispose();
  return projected;
}

const [tenantA, tenantB] = await Promise.all([
  handleTenant('tenant-a', 'tenant-a-credential-123456'),
  handleTenant('tenant-b', 'tenant-b-credential-123456'),
]);
assert.equal(tenantA.id, 'tenant-a');
assert.equal(tenantB.id, 'tenant-b');
assert.notDeepStrictEqual(tenantA, tenantB);
const tenantASerialized = JSON.stringify(tenantA);
const tenantBSerialized = JSON.stringify(tenantB);
for (const forbidden of ['tenant-b', 'tenant-a-credential-123456', 'tenant-b-credential-123456', 'asset-', 'hidden provider reasoning', 'tenantPlugin']) {
  assert.equal(tenantASerialized.includes(forbidden), false, 'tenant A leaked ' + forbidden);
}
for (const forbidden of ['tenant-a', 'tenant-a-credential-123456', 'tenant-b-credential-123456', 'asset-', 'hidden provider reasoning', 'tenantPlugin']) {
  assert.equal(tenantBSerialized.includes(forbidden), false, 'tenant B leaked ' + forbidden);
}
assert.match(tenantASerialized, /\[EMAIL_REDACTED\]/);
assert.match(tenantBSerialized, /\[EMAIL_REDACTED\]/);

console.log('conversationalist runtime consumer: all assertions passed');
`;
