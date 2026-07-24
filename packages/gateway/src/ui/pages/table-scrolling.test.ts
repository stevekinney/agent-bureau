import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

const pageDirectory = import.meta.dir;
const tablePages = ['dashboard.svelte', 'evaluations.svelte', 'usage.svelte'];
const expectedCaptions = [
  'Agent runs',
  'Evaluation reports',
  'Usage by agent',
  'Usage by authenticated principal',
  'Usage by time window',
];

describe('Gateway table scrolling contract', () => {
  it('keeps every dense data table on Cinder’s scrollable public contract', () => {
    const source = tablePages
      .map((page) => readFileSync(join(pageDirectory, page), 'utf8'))
      .join('\n');
    const tables = [...source.matchAll(/<Table\b[^>]*>/g)].map((match) => match[0]);
    const captions = tables.map((table) => table.match(/caption="([^"]+)"/)?.[1]);

    expect(tables).toHaveLength(expectedCaptions.length);
    expect(tables.every((table) => /\bscrollable(?:\s|=|>)/.test(table))).toBe(true);
    expect(captions).toEqual(expectedCaptions);
    expect(source).not.toMatch(/overflow-x/);
  });
});
