import { describe, expect, it } from 'bun:test';

import {
  createConditionalInstructionComposer,
  whenAnyToolAvailable,
  whenMetadata,
  whenMetadataPresent,
  whenStep,
  whenToolsAvailable,
} from '../src/composition/conditional-section';
import { createTestInstructionContext } from '../src/test/index';

describe('createConditionalInstructionComposer', () => {
  it('static sections always render', () => {
    const composer = createConditionalInstructionComposer({
      name: 'role',
      content: 'You are helpful.',
    });
    expect(composer.render()).toBe('You are helpful.');
  });

  it('conditional section included when predicate returns true', () => {
    const composer = createConditionalInstructionComposer(
      { name: 'role', content: 'You are helpful.' },
      { name: 'tools', content: 'Use tools wisely.', when: () => true },
    );
    expect(composer.render()).toBe('You are helpful.\n\nUse tools wisely.');
  });

  it('conditional section excluded when predicate returns false', () => {
    const composer = createConditionalInstructionComposer(
      { name: 'role', content: 'You are helpful.' },
      { name: 'tools', content: 'Use tools wisely.', when: () => false },
    );
    expect(composer.render()).toBe('You are helpful.');
  });

  it('resolve returns a plain InstructionComposer', () => {
    const composer = createConditionalInstructionComposer(
      { name: 'role', content: 'You are helpful.' },
      { name: 'tools', content: 'Use tools.', when: () => true },
    );
    const resolved = composer.resolve();
    expect(resolved.render()).toBe('You are helpful.\n\nUse tools.');
    expect(resolved.sectionNames()).toEqual(['role', 'tools']);
  });

  it('sectionNames with context filters conditional sections', () => {
    const composer = createConditionalInstructionComposer(
      { name: 'always', content: 'Always.' },
      { name: 'sometimes', content: 'Sometimes.', when: (ctx) => ctx.step === 0 },
    );
    expect(composer.sectionNames({ step: 0 })).toEqual(['always', 'sometimes']);
    expect(composer.sectionNames({ step: 5 })).toEqual(['always']);
  });

  it('sectionNames without context returns all section names', () => {
    const composer = createConditionalInstructionComposer(
      { name: 'a', content: 'A' },
      { name: 'b', content: 'B', when: () => false },
    );
    expect(composer.sectionNames()).toEqual(['a', 'b']);
  });

  it('removeSection removes named section', () => {
    const composer = createConditionalInstructionComposer(
      { name: 'a', content: 'A' },
      { name: 'b', content: 'B' },
    );
    const updated = composer.removeSection('a');
    expect(updated.render()).toBe('B');
    // Original unchanged
    expect(composer.hasSection('a')).toBe(true);
  });

  it('same-name replacement via section()', () => {
    const composer = createConditionalInstructionComposer({ name: 'a', content: 'Old' });
    const updated = composer.section({ name: 'a', content: 'New' });
    expect(updated.render()).toBe('New');
  });

  it('same-name replacement via conditionalSection()', () => {
    const composer = createConditionalInstructionComposer({
      name: 'a',
      content: 'Old',
      when: () => true,
    });
    const updated = composer.conditionalSection({
      name: 'a',
      content: 'New',
      when: () => true,
    });
    expect(updated.render()).toBe('New');
  });

  it('priority ordering with mixed static and conditional sections', () => {
    const composer = createConditionalInstructionComposer(
      { name: 'low', content: 'Low', priority: 2 },
      { name: 'high', content: 'High', priority: 0, when: () => true },
      { name: 'mid', content: 'Mid', priority: 1 },
    );
    expect(composer.render()).toBe('High\n\nMid\n\nLow');
  });

  it('template variables in conditional sections', () => {
    const composer = createConditionalInstructionComposer({
      name: 'role',
      content: 'You are a {{role}}.',
      when: () => true,
    });
    expect(composer.render({ variables: { role: 'teacher' } })).toBe('You are a teacher.');
  });

  it('empty context excludes tool-dependent predicates', () => {
    const composer = createConditionalInstructionComposer(
      { name: 'a', content: 'A' },
      { name: 'b', content: 'B', when: whenToolsAvailable('search') },
    );
    expect(composer.render()).toBe('A');
  });

  it('works with createTestInstructionContext helper', () => {
    const composer = createConditionalInstructionComposer({
      name: 'tools',
      content: 'Use search.',
      when: whenToolsAvailable('search'),
    });
    const context = createTestInstructionContext({ toolNames: ['search'], step: 0 });
    expect(composer.render({ context })).toBe('Use search.');

    const emptyContext = createTestInstructionContext();
    expect(composer.render({ context: emptyContext })).toBe('');
  });

  it('createTestInstructionContext supports metadata', () => {
    const context = createTestInstructionContext({ metadata: { env: 'test' } });
    expect(context.metadata).toEqual({ env: 'test' });
  });

  it('empty context excludes step-dependent predicates', () => {
    const composer = createConditionalInstructionComposer(
      { name: 'a', content: 'A' },
      { name: 'b', content: 'B', when: whenStep((step) => step > 0) },
    );
    expect(composer.render()).toBe('A');
  });

  it('hasSection checks existence regardless of condition', () => {
    const composer = createConditionalInstructionComposer({
      name: 'cond',
      content: 'X',
      when: () => false,
    });
    expect(composer.hasSection('cond')).toBe(true);
    expect(composer.hasSection('missing')).toBe(false);
  });

  it('sections() returns all sections including conditional', () => {
    const when = () => true;
    const composer = createConditionalInstructionComposer(
      { name: 'a', content: 'A' },
      { name: 'b', content: 'B', when },
    );
    const all = composer.sections();
    expect(all).toHaveLength(2);
    expect(all[0]!.name).toBe('a');
    expect(all[1]!.name).toBe('b');
  });
});

describe('predicate factories', () => {
  describe('whenToolsAvailable', () => {
    it('returns true when all tools are present', () => {
      const predicate = whenToolsAvailable('search', 'fetch');
      expect(predicate({ toolNames: ['search', 'fetch', 'save'] })).toBe(true);
    });

    it('returns false when some tools are missing', () => {
      const predicate = whenToolsAvailable('search', 'fetch');
      expect(predicate({ toolNames: ['search'] })).toBe(false);
    });

    it('returns false when toolNames is undefined', () => {
      const predicate = whenToolsAvailable('search');
      expect(predicate({})).toBe(false);
    });
  });

  describe('whenAnyToolAvailable', () => {
    it('returns true when at least one tool is present', () => {
      const predicate = whenAnyToolAvailable('search', 'fetch');
      expect(predicate({ toolNames: ['fetch'] })).toBe(true);
    });

    it('returns false when no tools match', () => {
      const predicate = whenAnyToolAvailable('search', 'fetch');
      expect(predicate({ toolNames: ['save'] })).toBe(false);
    });

    it('returns false when toolNames is undefined', () => {
      const predicate = whenAnyToolAvailable('search');
      expect(predicate({})).toBe(false);
    });
  });

  describe('whenStep', () => {
    it('returns true when predicate matches step', () => {
      const predicate = whenStep((step) => step > 5);
      expect(predicate({ step: 10 })).toBe(true);
    });

    it('returns false when predicate does not match', () => {
      const predicate = whenStep((step) => step > 5);
      expect(predicate({ step: 3 })).toBe(false);
    });

    it('returns false when step is undefined', () => {
      const predicate = whenStep((step) => step > 0);
      expect(predicate({})).toBe(false);
    });
  });

  describe('whenMetadata', () => {
    it('returns true for exact match', () => {
      const predicate = whenMetadata('env', 'production');
      expect(predicate({ metadata: { env: 'production' } })).toBe(true);
    });

    it('returns false for mismatch', () => {
      const predicate = whenMetadata('env', 'production');
      expect(predicate({ metadata: { env: 'staging' } })).toBe(false);
    });

    it('returns false when metadata is undefined', () => {
      const predicate = whenMetadata('env', 'production');
      expect(predicate({})).toBe(false);
    });
  });

  describe('whenMetadataPresent', () => {
    it('returns true when key exists', () => {
      const predicate = whenMetadataPresent('debug');
      expect(predicate({ metadata: { debug: true } })).toBe(true);
    });

    it('returns true when key exists with falsy value', () => {
      const predicate = whenMetadataPresent('debug');
      expect(predicate({ metadata: { debug: false } })).toBe(true);
    });

    it('returns false when key is missing', () => {
      const predicate = whenMetadataPresent('debug');
      expect(predicate({ metadata: { other: true } })).toBe(false);
    });

    it('returns false when metadata is undefined', () => {
      const predicate = whenMetadataPresent('debug');
      expect(predicate({})).toBe(false);
    });
  });
});
