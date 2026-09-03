import { describe, expect, test } from 'bun:test';

import { decideSiblingPacking } from './verify-operative-consumer';

const armorer = { name: 'armorer', directory: '/repo/packages/armorer', version: '2.3.0' };
const conversationalist = {
  name: 'conversationalist',
  directory: '/repo/packages/conversationalist',
  version: '1.1.0',
};

describe('decideSiblingPacking', () => {
  test('resolves a sibling from the registry when its version is published and no changeset targets it', () => {
    const decisions = decideSiblingPacking(
      [armorer],
      new Map([['armorer', ['2.2.0', '2.3.0']]]),
      new Set(),
      false,
    );

    expect(decisions).toEqual([{ ...armorer, pack: false, reason: 'registry' }]);
  });

  test('packs a sibling whose workspace version is not among the published registry versions', () => {
    const decisions = decideSiblingPacking(
      [armorer],
      new Map([['armorer', ['2.2.0']]]),
      new Set(),
      false,
    );

    expect(decisions).toEqual([{ ...armorer, pack: true, reason: 'not-on-registry' }]);
  });

  test('packs a sibling with a pending changeset even when its version string is already published (AB-243/conversationalist)', () => {
    const decisions = decideSiblingPacking(
      [conversationalist],
      new Map([['conversationalist', ['1.0.0', '1.1.0']]]),
      new Set(['conversationalist']),
      false,
    );

    expect(decisions).toEqual([{ ...conversationalist, pack: true, reason: 'pending-changeset' }]);
  });

  test('treats a package with no published versions at all (E404) as not on the registry', () => {
    const decisions = decideSiblingPacking([armorer], new Map([['armorer', []]]), new Set(), false);

    expect(decisions).toEqual([{ ...armorer, pack: true, reason: 'not-on-registry' }]);
  });

  test('forces every sibling to pack when --pack-siblings overrides regardless of registry or changeset state', () => {
    const decisions = decideSiblingPacking(
      [armorer, conversationalist],
      new Map([
        ['armorer', ['2.3.0']],
        ['conversationalist', ['1.1.0']],
      ]),
      new Set(),
      true,
    );

    expect(decisions).toEqual([
      { ...armorer, pack: true, reason: 'forced' },
      { ...conversationalist, pack: true, reason: 'forced' },
    ]);
  });

  test('decides each sibling independently in a mixed list', () => {
    const decisions = decideSiblingPacking(
      [armorer, conversationalist],
      new Map([
        ['armorer', ['2.3.0']],
        ['conversationalist', ['1.1.0']],
      ]),
      new Set(['conversationalist']),
      false,
    );

    expect(decisions).toEqual([
      { ...armorer, pack: false, reason: 'registry' },
      { ...conversationalist, pack: true, reason: 'pending-changeset' },
    ]);
  });

  test('returns an empty decision list for an empty sibling list', () => {
    expect(decideSiblingPacking([], new Map(), new Set(), false)).toEqual([]);
  });
});
