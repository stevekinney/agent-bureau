import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

const pageDirectory = import.meta.dir;

const pages = {
  chat: 'Chat',
  configuration: 'Configuration',
  dashboard: 'Dashboard',
  evaluations: 'Evaluations',
  reviews: 'Review Queue',
  'run-detail': 'Run',
  usage: 'Usage & Cost',
} as const;

describe('Gateway page heading contract', () => {
  it('inventories all seven production pages and gives each one PageHeader', () => {
    expect(Object.keys(pages)).toHaveLength(7);

    for (const [page, title] of Object.entries(pages)) {
      const source = readFileSync(join(pageDirectory, `${page}.svelte`), 'utf8');

      expect(source).toContain("import { PageHeader } from '@lostgradient/cinder/page-header';");
      expect(source.match(/<PageHeader\b/g)).toHaveLength(1);
      expect(source).not.toContain(`<SectionHeading level={2} title="${title}"`);
      if (page === 'run-detail') {
        expect(source).not.toContain('<SectionHeading level={2} title={`Run ${run.id}`} />');
      }
    }
  });

  it('keeps every remaining page section heading at level 2', () => {
    for (const page of Object.keys(pages)) {
      const source = readFileSync(join(pageDirectory, `${page}.svelte`), 'utf8');
      const sectionHeadings = source.match(/<SectionHeading\b[^>]*\/>/g) ?? [];
      const sectionHeadingInstances = source.match(/<SectionHeading\b/g) ?? [];

      expect(sectionHeadings).toHaveLength(sectionHeadingInstances.length);
      expect(sectionHeadings.every((heading) => heading.includes('level={2}'))).toBe(true);
    }
  });
});
