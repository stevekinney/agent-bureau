import { describe, expect, it } from 'bun:test';

import { resolveCommonParameters } from '../src/resolve-common-parameters.ts';

describe('resolveCommonParameters', () => {
  it('includes defined parameters in the result', () => {
    const result = resolveCommonParameters({
      maximumTokens: 1024,
      temperature: 0.7,
      topP: 0.9,
      stopSequences: ['STOP', 'END'],
    });

    expect(result).toEqual({
      maximumTokens: 1024,
      temperature: 0.7,
      topP: 0.9,
      stopSequences: ['STOP', 'END'],
    });
  });

  it('omits undefined parameters from the result', () => {
    const result = resolveCommonParameters({
      temperature: 0.5,
    });

    expect(result).toEqual({
      temperature: 0.5,
    });
    expect(result).not.toHaveProperty('maximumTokens');
    expect(result).not.toHaveProperty('topP');
    expect(result).not.toHaveProperty('stopSequences');
  });

  it('omits empty stopSequences from the result', () => {
    const result = resolveCommonParameters({
      temperature: 0.5,
      stopSequences: [],
    });

    expect(result).toEqual({
      temperature: 0.5,
    });
    expect(result).not.toHaveProperty('stopSequences');
  });

  it('returns an empty object when no parameters are defined', () => {
    const result = resolveCommonParameters({});

    expect(result).toEqual({});
  });

  it('preserves zero as a valid temperature value', () => {
    const result = resolveCommonParameters({
      temperature: 0,
    });

    expect(result).toEqual({
      temperature: 0,
    });
  });

  it('preserves zero as a valid maximumTokens value', () => {
    const result = resolveCommonParameters({
      maximumTokens: 0,
    });

    expect(result).toEqual({
      maximumTokens: 0,
    });
  });
});
