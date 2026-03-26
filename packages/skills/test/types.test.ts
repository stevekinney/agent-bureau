import { describe, expect, it } from 'bun:test';

import type {
  EnvironmentCapabilities,
  PatternAnalysis,
  PatternCluster,
  Proposal,
  SkillCatalogEntry,
  SkillContent,
  SkillMetadata,
  SkillResource,
  SweepState,
  ToolPolicy,
} from '../src/types';

describe('ToolPolicy', () => {
  it('can be constructed with only allowList', () => {
    const policy: ToolPolicy = { allowList: ['read', 'write'] };
    expect(policy.allowList).toEqual(['read', 'write']);
    expect(policy.denyList).toBeUndefined();
  });

  it('can be constructed with only denyList', () => {
    const policy: ToolPolicy = { denyList: ['dangerous-tool'] };
    expect(policy.allowList).toBeUndefined();
    expect(policy.denyList).toEqual(['dangerous-tool']);
  });

  it('can be constructed with both allowList and denyList', () => {
    const policy: ToolPolicy = {
      allowList: ['read', 'write', 'execute'],
      denyList: ['execute'],
    };
    expect(policy.allowList).toHaveLength(3);
    expect(policy.denyList).toHaveLength(1);
  });

  it('can be constructed with neither', () => {
    const policy: ToolPolicy = {};
    expect(policy.allowList).toBeUndefined();
    expect(policy.denyList).toBeUndefined();
  });
});

describe('SkillMetadata', () => {
  it('can be constructed with required fields only', () => {
    const metadata: SkillMetadata = {
      name: 'code-review',
      description: 'Review code for best practices',
    };
    expect(metadata.name).toBe('code-review');
    expect(metadata.description).toBe('Review code for best practices');
    expect(metadata.license).toBeUndefined();
    expect(metadata.compatibility).toBeUndefined();
    expect(metadata.toolPolicy).toBeUndefined();
    expect(metadata.metadata).toBeUndefined();
  });

  it('can be constructed with all fields', () => {
    const metadata: SkillMetadata = {
      name: 'code-review',
      description: 'Review code for best practices',
      license: 'MIT',
      compatibility: 'Requires filesystem access',
      toolPolicy: { allowList: ['read', 'grep'] },
      metadata: { author: 'test', version: '1.0' },
    };
    expect(metadata.license).toBe('MIT');
    expect(metadata.toolPolicy?.allowList).toEqual(['read', 'grep']);
    expect(metadata.metadata?.['author']).toBe('test');
  });
});

describe('SkillCatalogEntry', () => {
  it('can be constructed with required fields', () => {
    const entry: SkillCatalogEntry = {
      name: 'code-review',
      description: 'Review code for best practices',
    };
    expect(entry.active).toBeUndefined();
  });

  it('can track active state', () => {
    const entry: SkillCatalogEntry = {
      name: 'code-review',
      description: 'Review code',
      active: true,
    };
    expect(entry.active).toBe(true);
  });
});

describe('SkillContent', () => {
  it('can be constructed with metadata and body', () => {
    const content: SkillContent = {
      metadata: {
        name: 'test-skill',
        description: 'A test skill',
      },
      body: '## Instructions\n\nDo something useful.',
    };
    expect(content.metadata.name).toBe('test-skill');
    expect(content.body).toContain('Instructions');
  });

  it('supports empty body', () => {
    const content: SkillContent = {
      metadata: { name: 'empty', description: 'No body' },
      body: '',
    };
    expect(content.body).toBe('');
  });
});

describe('SkillResource', () => {
  it('can be constructed with path and content', () => {
    const resource: SkillResource = {
      path: 'scripts/extract.py',
      content: 'print("hello")',
    };
    expect(resource.path).toBe('scripts/extract.py');
    expect(resource.content).toContain('print');
  });
});

describe('EnvironmentCapabilities', () => {
  it('can describe a server environment', () => {
    const capabilities: EnvironmentCapabilities = {
      canExecuteScripts: true,
      canAccessFilesystem: true,
      canAccessNetwork: true,
      availableTools: ['read', 'write', 'bash'],
      platform: 'server',
    };
    expect(capabilities.platform).toBe('server');
    expect(capabilities.canExecuteScripts).toBe(true);
  });

  it('can describe a browser environment', () => {
    const capabilities: EnvironmentCapabilities = {
      canExecuteScripts: false,
      canAccessFilesystem: false,
      canAccessNetwork: true,
      availableTools: ['fetch'],
      platform: 'browser',
    };
    expect(capabilities.canExecuteScripts).toBe(false);
    expect(capabilities.canAccessFilesystem).toBe(false);
  });
});

describe('Proposal', () => {
  const baseProposal: Proposal = {
    id: 'prop-001',
    type: 'skill',
    summary: 'New code review skill based on recurring patterns',
    content: '---\nname: code-review\n---\n\n## Instructions',
    sourceEntryIds: ['entry-1', 'entry-2'],
    createdAt: '2026-03-26T00:00:00Z',
    status: 'pending',
  };

  it('can be constructed as pending', () => {
    expect(baseProposal.status).toBe('pending');
    expect(baseProposal.rejectionReason).toBeUndefined();
    expect(baseProposal.agentId).toBeUndefined();
  });

  it('tracks accepted status', () => {
    const accepted: Proposal = { ...baseProposal, status: 'accepted' };
    expect(accepted.status).toBe('accepted');
  });

  it('tracks rejected status with reason', () => {
    const rejected: Proposal = {
      ...baseProposal,
      status: 'rejected',
      rejectionReason: 'Too similar to existing skill',
    };
    expect(rejected.status).toBe('rejected');
    expect(rejected.rejectionReason).toBe('Too similar to existing skill');
  });

  it('can be scoped to a specific agent', () => {
    const agentProposal: Proposal = {
      ...baseProposal,
      type: 'persona',
      agentId: 'research-agent',
    };
    expect(agentProposal.agentId).toBe('research-agent');
    expect(agentProposal.type).toBe('persona');
  });

  it('supports all proposal types', () => {
    const types: Proposal['type'][] = ['skill', 'soul', 'persona'];
    for (const type of types) {
      const proposal: Proposal = { ...baseProposal, type };
      expect(proposal.type).toBe(type);
    }
  });
});

describe('PatternCluster', () => {
  it('can be constructed with entries', () => {
    const cluster: PatternCluster = {
      name: 'Error Recovery',
      entries: [
        { content: 'retry after timeout', metadata: { confidence: 0.9 }, entryId: 'e1' },
        { content: 'fallback to cache', metadata: { confidence: 0.85 }, entryId: 'e2' },
      ],
      type: 'recovery',
      suggestedSkillName: 'error-recovery',
    };
    expect(cluster.entries).toHaveLength(2);
    expect(cluster.type).toBe('recovery');
  });

  it('supports all cluster types', () => {
    const types: PatternCluster['type'][] = ['strategy', 'recovery', 'optimization'];
    for (const type of types) {
      const cluster: PatternCluster = {
        name: 'test',
        entries: [],
        type,
        suggestedSkillName: 'test',
      };
      expect(cluster.type).toBe(type);
    }
  });
});

describe('PatternAnalysis', () => {
  it('can be constructed with all fields', () => {
    const analysis: PatternAnalysis = {
      clusters: [],
      soulCandidates: [{ content: 'be thorough', confidence: 0.95, entryId: 'e1' }],
      personaCandidates: {
        'research-agent': [{ content: 'cite sources', confidence: 0.9, entryId: 'e2' }],
      },
    };
    expect(analysis.soulCandidates).toHaveLength(1);
    expect(analysis.personaCandidates['research-agent']).toHaveLength(1);
  });
});

describe('SweepState', () => {
  it('can be constructed with initial state', () => {
    const state: SweepState = {
      collected: 0,
      clusters: 0,
      proposals: [],
      stage: 'collect',
    };
    expect(state.stage).toBe('collect');
  });

  it('supports all stages', () => {
    const stages: SweepState['stage'][] = ['collect', 'analyze', 'draft', 'filter', 'complete'];
    for (const stage of stages) {
      const state: SweepState = { collected: 10, clusters: 3, proposals: ['p1'], stage };
      expect(state.stage).toBe(stage);
    }
  });
});
