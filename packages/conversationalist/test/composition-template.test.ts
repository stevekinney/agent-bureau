import { describe, expect, it } from 'bun:test';

import {
  createInstructionTemplate,
  extractTemplateVariables,
  renderTemplate,
} from '../src/composition/template';

describe('renderTemplate', () => {
  it('replaces all provided variables', () => {
    const result = renderTemplate('Hello, {{name}}! Welcome to {{place}}.', {
      name: 'Alice',
      place: 'Wonderland',
    });
    expect(result).toBe('Hello, Alice! Welcome to Wonderland.');
  });

  it('throws on missing variable by default', () => {
    expect(() => renderTemplate('Hello, {{name}}!', {})).toThrow(
      'Missing template variable: "name"',
    );
  });

  it('preserves missing variable with preserve strategy', () => {
    const result = renderTemplate('Hello, {{name}}!', {}, { missingVariableStrategy: 'preserve' });
    expect(result).toBe('Hello, {{name}}!');
  });

  it('replaces missing variable with empty string using empty strategy', () => {
    const result = renderTemplate('Hello, {{name}}!', {}, { missingVariableStrategy: 'empty' });
    expect(result).toBe('Hello, !');
  });

  it('returns source unchanged when no variables are present', () => {
    const result = renderTemplate('No variables here.', {});
    expect(result).toBe('No variables here.');
  });

  it('replaces repeated variable with same value', () => {
    const result = renderTemplate('{{x}} and {{x}}', { x: 'yes' });
    expect(result).toBe('yes and yes');
  });

  it('trims whitespace inside braces', () => {
    const result = renderTemplate('{{ name }} and {{  place  }}', {
      name: 'Alice',
      place: 'home',
    });
    expect(result).toBe('Alice and home');
  });

  it('leaves malformed braces alone', () => {
    const result = renderTemplate('{name} and {{ }} and {{}}', { name: 'x' });
    expect(result).toBe('{name} and {{ }} and {{}}');
  });

  it('handles empty template', () => {
    const result = renderTemplate('', {});
    expect(result).toBe('');
  });

  it('ignores extra keys in the variables map', () => {
    const result = renderTemplate('Hello, {{name}}!', { name: 'Bob', extra: 'ignored' });
    expect(result).toBe('Hello, Bob!');
  });
});

describe('extractTemplateVariables', () => {
  it('returns all unique variable names', () => {
    const vars = extractTemplateVariables('{{a}} {{b}} {{a}}');
    expect(vars).toEqual(new Set(['a', 'b']));
  });

  it('trims whitespace from variable names', () => {
    const vars = extractTemplateVariables('{{ name }} {{ place }}');
    expect(vars).toEqual(new Set(['name', 'place']));
  });

  it('returns empty set for template without variables', () => {
    const vars = extractTemplateVariables('No variables here.');
    expect(vars.size).toBe(0);
  });

  it('supports dotted variable names', () => {
    const vars = extractTemplateVariables('{{user.name}} and {{user.role}}');
    expect(vars).toEqual(new Set(['user.name', 'user.role']));
  });
});

describe('createInstructionTemplate', () => {
  it('renders with provided variables', () => {
    const template = createInstructionTemplate('Hello, {{name}}!');
    expect(template.render({ name: 'World' })).toBe('Hello, World!');
  });

  it('exposes the source', () => {
    const template = createInstructionTemplate('Hello, {{name}}!');
    expect(template.source).toBe('Hello, {{name}}!');
  });

  it('extracts variables', () => {
    const template = createInstructionTemplate('{{a}} and {{b}}');
    expect(template.variables()).toEqual(new Set(['a', 'b']));
  });

  it('respects options passed at creation time', () => {
    const template = createInstructionTemplate('Hello, {{name}}!', {
      missingVariableStrategy: 'empty',
    });
    expect(template.render({})).toBe('Hello, !');
  });

  it('throws by default on missing variable', () => {
    const template = createInstructionTemplate('Hello, {{name}}!');
    expect(() => template.render({})).toThrow('Missing template variable: "name"');
  });
});
