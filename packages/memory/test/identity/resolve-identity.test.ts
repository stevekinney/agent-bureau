import { describe, expect, it } from 'bun:test';

import { resolveIdentity } from '../../src/identity/resolve-identity';
import type { AgentIdentity, SoulBudget, SoulItem } from '../../src/identity/types';

function makeSoulItem(overrides: Partial<SoulItem> & { id: string; content: string }): SoulItem {
  return {
    source: 'seed',
    pinned: false,
    updatedAt: '2026-01-01T00:00:00Z',
    reinforcementCount: 0,
    ...overrides,
  };
}

const simpleEstimator = (text: string) => Math.ceil(text.length / 4);

describe('resolveIdentity', () => {
  it('renders soul items in priority order (pinned first, then by reinforcement count)', () => {
    const identity: AgentIdentity = {
      soul: [
        makeSoulItem({ id: '1', content: 'Low priority', reinforcementCount: 1 }),
        makeSoulItem({ id: '2', content: 'High priority', reinforcementCount: 10 }),
        makeSoulItem({ id: '3', content: 'Pinned item', pinned: true, reinforcementCount: 0 }),
      ],
    };

    const result = resolveIdentity(identity);
    const lines = result.split('\n');

    expect(lines[0]).toBe('Pinned item');
    expect(lines[1]).toBe('High priority');
    expect(lines[2]).toBe('Low priority');
  });

  it('enforces token budget by dropping lowest-priority non-pinned items', () => {
    const identity: AgentIdentity = {
      soul: [
        makeSoulItem({ id: '1', content: 'AAAA', reinforcementCount: 1 }), // 1 token
        makeSoulItem({ id: '2', content: 'BBBBBBBB', reinforcementCount: 5 }), // 2 tokens
        makeSoulItem({ id: '3', content: 'CCCCCCCCCCCC', reinforcementCount: 3 }), // 3 tokens
      ],
    };

    const budget: SoulBudget = {
      maxTokens: 3,
      estimateTokens: simpleEstimator,
      maxItemsPerTopic: 5,
    };

    const result = resolveIdentity(identity, budget);

    // Budget is 3 tokens. Items sorted by reinforcement: BBBBBBBB (2t, r=5), CCCCCCCCCCCC (3t, r=3), AAAA (1t, r=1)
    // BBBBBBBB fits (2 <= 3), CCCCCCCCCCCC doesn't (2+3 = 5 > 3), AAAA fits (2+1 = 3 <= 3)
    expect(result).toContain('BBBBBBBB');
    expect(result).toContain('AAAA');
    expect(result).not.toContain('CCCCCCCCCCCC');
  });

  it('never drops pinned items even when over budget', () => {
    const identity: AgentIdentity = {
      soul: [
        makeSoulItem({
          id: '1',
          content: 'A very long pinned item that takes many tokens',
          pinned: true,
          reinforcementCount: 0,
        }),
        makeSoulItem({ id: '2', content: 'Short', reinforcementCount: 10 }),
      ],
    };

    const budget: SoulBudget = {
      maxTokens: 2,
      estimateTokens: simpleEstimator,
      maxItemsPerTopic: 5,
    };

    const result = resolveIdentity(identity, budget);

    // Pinned item is kept even though it exceeds the budget on its own
    expect(result).toContain('A very long pinned item');
  });

  it('appends personaText under ## Role heading', () => {
    const identity: AgentIdentity = {
      soul: [makeSoulItem({ id: '1', content: 'Be helpful.' })],
      personaText: 'Always cite your sources when providing information.',
    };

    const result = resolveIdentity(identity);

    expect(result).toContain('## Role');
    expect(result).toContain('Always cite your sources when providing information.');
  });

  it('renders PersonaDescriptor as structured text when no personaText provided', () => {
    const identity: AgentIdentity = {
      soul: [makeSoulItem({ id: '1', content: 'Be helpful.' })],
      persona: {
        name: 'Atlas',
        role: 'research agent',
        expertise: 'web search',
        domain: 'information retrieval',
        taskContext: 'answering user questions',
      },
    };

    const result = resolveIdentity(identity);

    expect(result).toContain('## Role');
    expect(result).toContain('You are Atlas, a research agent');
    expect(result).toContain('with expertise in web search');
    expect(result).toContain('operating in the information retrieval domain');
    expect(result).toContain('focused on answering user questions');
  });

  it('appends userContext under ## User Context heading', () => {
    const identity: AgentIdentity = {
      soul: [makeSoulItem({ id: '1', content: 'Be helpful.' })],
      userContext: 'User is in UTC timezone and prefers concise answers.',
    };

    const result = resolveIdentity(identity);

    expect(result).toContain('## User Context');
    expect(result).toContain('User is in UTC timezone and prefers concise answers.');
  });

  it('omits missing sections (no empty headings)', () => {
    const identity: AgentIdentity = {
      soul: [makeSoulItem({ id: '1', content: 'Be helpful.' })],
    };

    const result = resolveIdentity(identity);

    expect(result).not.toContain('## Role');
    expect(result).not.toContain('## User Context');
    expect(result).toBe('Be helpful.');
  });

  it('produces minimal output for empty soul', () => {
    const identity: AgentIdentity = { soul: [] };
    const result = resolveIdentity(identity);
    expect(result).toBe('');
  });

  it('produces empty string when all sections are missing', () => {
    const identity: AgentIdentity = { soul: [] };
    const result = resolveIdentity(identity);
    expect(result).toBe('');
  });

  it('personaText takes precedence over persona descriptor', () => {
    const identity: AgentIdentity = {
      soul: [],
      persona: { name: 'Atlas', role: 'research agent' },
      personaText: 'Custom persona text overrides descriptor.',
    };

    const result = resolveIdentity(identity);

    expect(result).toContain('Custom persona text overrides descriptor.');
    expect(result).not.toContain('You are Atlas');
  });

  it('renders persona descriptor with minimal fields', () => {
    const identity: AgentIdentity = {
      soul: [],
      persona: { name: 'Bot', role: 'helper' },
    };

    const result = resolveIdentity(identity);

    expect(result).toContain('You are Bot, a helper.');
    expect(result).not.toContain('expertise');
    expect(result).not.toContain('domain');
  });

  it('combines all sections correctly', () => {
    const identity: AgentIdentity = {
      soul: [
        makeSoulItem({ id: '1', content: 'Be helpful.', pinned: true }),
        makeSoulItem({ id: '2', content: 'Be concise.', reinforcementCount: 5 }),
      ],
      personaText: 'You are a coding assistant.',
      userContext: 'User: Steve, timezone: UTC.',
    };

    const result = resolveIdentity(identity);

    // Verify section order: soul first, then role, then user context
    const soulEnd = result.indexOf('Be concise.');
    const roleStart = result.indexOf('## Role');
    const userStart = result.indexOf('## User Context');

    expect(soulEnd).toBeLessThan(roleStart);
    expect(roleStart).toBeLessThan(userStart);
  });
});
