import { describe, expect, it } from 'bun:test';

import { createInstructionComposer } from '../src/composition/instruction-composer';

describe('createInstructionComposer', () => {
  it('renders empty composer as empty string', () => {
    const composer = createInstructionComposer();
    expect(composer.render()).toBe('');
  });

  it('renders a single section', () => {
    const composer = createInstructionComposer({ name: 'role', content: 'You are helpful.' });
    expect(composer.render()).toBe('You are helpful.');
  });

  it('renders multiple sections in priority order', () => {
    const composer = createInstructionComposer(
      { name: 'style', content: 'Be concise.', priority: 1 },
      { name: 'role', content: 'You are helpful.', priority: 0 },
    );
    expect(composer.render()).toBe('You are helpful.\n\nBe concise.');
  });

  it('replaces section with same name (deduplication)', () => {
    const composer = createInstructionComposer(
      { name: 'role', content: 'Original.' },
      { name: 'role', content: 'Replaced.' },
    );
    expect(composer.render()).toBe('Replaced.');
  });

  it('section() replaces existing same-name section', () => {
    const composer = createInstructionComposer({ name: 'role', content: 'Old.' });
    const updated = composer.section({ name: 'role', content: 'New.' });
    expect(updated.render()).toBe('New.');
    // Original is not mutated
    expect(composer.render()).toBe('Old.');
  });

  it('removeSection removes the named section', () => {
    const composer = createInstructionComposer(
      { name: 'role', content: 'You are helpful.' },
      { name: 'style', content: 'Be concise.' },
    );
    const updated = composer.removeSection('role');
    expect(updated.render()).toBe('Be concise.');
    // Original is not mutated
    expect(composer.sectionNames()).toEqual(['role', 'style']);
  });

  it('sectionNames returns names in priority order', () => {
    const composer = createInstructionComposer(
      { name: 'c', content: '', priority: 2 },
      { name: 'a', content: '', priority: 0 },
      { name: 'b', content: '', priority: 1 },
    );
    expect(composer.sectionNames()).toEqual(['a', 'b', 'c']);
  });

  it('hasSection returns true for existing and false for missing', () => {
    const composer = createInstructionComposer({ name: 'role', content: '' });
    expect(composer.hasSection('role')).toBe(true);
    expect(composer.hasSection('missing')).toBe(false);
  });

  it('sections() returns all sections', () => {
    const sections = [
      { name: 'a', content: 'A' },
      { name: 'b', content: 'B' },
    ];
    const composer = createInstructionComposer(...sections);
    expect(composer.sections()).toEqual(sections);
  });

  it('uses custom separator', () => {
    const composer = createInstructionComposer(
      { name: 'a', content: 'A' },
      { name: 'b', content: 'B' },
    );
    expect(composer.render({ separator: ' | ' })).toBe('A | B');
  });

  it('applies template variables in sections', () => {
    const composer = createInstructionComposer(
      { name: 'role', content: 'You are a {{role}}.' },
      { name: 'style', content: 'Respond in {{language}}.' },
    );
    expect(composer.render({ variables: { role: 'teacher', language: 'English' } })).toBe(
      'You are a teacher.\n\nRespond in English.',
    );
  });

  it('respects missing variable strategy from template options', () => {
    const composer = createInstructionComposer({
      name: 'role',
      content: 'You are a {{role}}.',
    });
    expect(
      composer.render({ variables: {}, templateOptions: { missingVariableStrategy: 'preserve' } }),
    ).toBe('You are a {{role}}.');
  });

  it('priority ties preserve insertion order', () => {
    const composer = createInstructionComposer(
      { name: 'first', content: 'First', priority: 0 },
      { name: 'second', content: 'Second', priority: 0 },
      { name: 'third', content: 'Third', priority: 0 },
    );
    expect(composer.render()).toBe('First\n\nSecond\n\nThird');
  });

  it('is immutable — original not mutated by section()', () => {
    const original = createInstructionComposer({ name: 'a', content: 'A' });
    const modified = original.section({ name: 'b', content: 'B' });

    expect(original.sectionNames()).toEqual(['a']);
    expect(modified.sectionNames()).toEqual(['a', 'b']);
  });

  it('is immutable — original not mutated by removeSection()', () => {
    const original = createInstructionComposer(
      { name: 'a', content: 'A' },
      { name: 'b', content: 'B' },
    );
    const modified = original.removeSection('a');

    expect(original.hasSection('a')).toBe(true);
    expect(modified.hasSection('a')).toBe(false);
  });
});
