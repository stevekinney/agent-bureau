import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'bun:test';

import * as root from '../src';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  exports?: Record<string, unknown>;
};

describe('public API export map', () => {
  const exportsMap = pkg.exports ?? {};

  it('includes the canonical subpaths', () => {
    expect(exportsMap['./conversation']).toBeDefined();
    expect(exportsMap['./context']).toBeDefined();
    expect(exportsMap['./streaming']).toBeDefined();
    expect(exportsMap['./projection']).toBeDefined();
    expect(exportsMap['./history']).toBeDefined();
    expect(exportsMap['./message']).toBeDefined();
    expect(exportsMap['./utilities']).toBeDefined();
    expect(exportsMap['./test']).toBeDefined();
    expect(exportsMap['./adapters/openai']).toBeDefined();
    expect(exportsMap['./adapters/anthropic']).toBeDefined();
    expect(exportsMap['./adapters/gemini']).toBeDefined();
    expect(exportsMap['./redaction']).toBeDefined();
  });

  it('includes the composition subpath', () => {
    expect(exportsMap['./composition']).toBeDefined();
  });

  it('does not expose removed alias subpaths', () => {
    expect(exportsMap['./openai']).toBeUndefined();
    expect(exportsMap['./anthropic']).toBeUndefined();
    expect(exportsMap['./gemini']).toBeUndefined();
    expect(exportsMap['./plugins']).toBeUndefined();
  });

  it('exposes the renamed canonical root runtime API', () => {
    expect(root.Conversation).toBeDefined();
    expect(root.createConversationHistory).toBeDefined();
    expect(root.createConversationHistoryUnsafe).toBeDefined();
    expect(root.deserializeConversationHistory).toBeDefined();
    expect(root.materializeToolCall).toBeDefined();
    expect(root.materializeToolCalls).toBeDefined();
    expect(root.materializeToolResult).toBeDefined();
    expect(root.materializeToolResultsAsync).toBeDefined();
    expect(root.withConversationHistory).toBeDefined();
    expect(root.pipeConversationHistory).toBeDefined();
    expect(root.createProjection).toBeDefined();
    expect(root.isProjectionPrefixExtension).toBeDefined();

    expect('ConversationHistory' in root).toBeFalse();
    expect('createConversation' in root).toBeFalse();
    expect('createConversationUnsafe' in root).toBeFalse();
    expect('deserializeConversation' in root).toBeFalse();
    expect('withConversation' in root).toBeFalse();
    expect('pipeConversation' in root).toBeFalse();
  });

  it('exposes generic provider helpers on the Conversation class surface', () => {
    expect(root.Conversation.fromProvider).toBeDefined();
    const conversation = new root.Conversation(root.createConversationHistory());
    expect(conversation.toProvider).toBeDefined();
    expect(conversation.appendProvider).toBeDefined();
  });

  it('exposes composition API on root module', () => {
    expect(root.createInstructionTemplate).toBeDefined();
    expect(root.renderTemplate).toBeDefined();
    expect(root.extractTemplateVariables).toBeDefined();
    expect(root.createInstructionComposer).toBeDefined();
    expect(root.createConditionalInstructionComposer).toBeDefined();
    expect(root.whenToolsAvailable).toBeDefined();
    expect(root.whenAnyToolAvailable).toBeDefined();
    expect(root.whenStep).toBeDefined();
    expect(root.whenMetadata).toBeDefined();
    expect(root.whenMetadataPresent).toBeDefined();
  });

  it('uses dynamic imports for provider adapters in the Conversation class', () => {
    const historySource = readFileSync(new URL('../src/history.ts', import.meta.url), 'utf8');

    expect(historySource).toContain("await import('./adapters/openai')");
    expect(historySource).toContain("await import('./adapters/anthropic')");
    expect(historySource).toContain("await import('./adapters/gemini')");
    expect(historySource).not.toMatch(
      /import\s+\{[^}]+\}\s+from\s+['"]\.\/adapters\/(?:openai|anthropic|gemini)['"]/,
    );
    expect(historySource).not.toMatch(
      /import\s+\*\s+as\s+\w+\s+from\s+['"]\.\/adapters\/(?:openai|anthropic|gemini)['"]/,
    );
  });
});
