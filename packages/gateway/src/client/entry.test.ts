import { beforeAll, describe, expect, it } from 'bun:test';

import type { PublishedComponentStylesheet } from '../../scripts/style-contract';
import {
  assertComponentStylesBundled,
  buildPublishedStylesheet,
  collectPublishedComponentStyles,
  extractComponentLayerBlocks,
  measureComponentLayer,
} from '../../scripts/style-contract';

const entryPath = `${import.meta.dir}/entry.ts`;

describe('Gateway client styles', () => {
  it('does not maintain a separate Cinder component stylesheet list', async () => {
    const entry = await Bun.file(entryPath).text();

    expect(entry).not.toMatch(/@lostgradient\/cinder\/.+\/styles/);
    expect(entry).not.toContain('@lostgradient/cinder/styles/all');
  });
});

describe('extractComponentLayerBlocks', () => {
  it('finds nothing in a stylesheet with no Cinder component layer', () => {
    expect(extractComponentLayerBlocks('.app-shell{display:grid}')).toEqual([]);
  });

  it('returns the body of every cinder.components block and ignores other layers', () => {
    const css =
      '@layer cinder.components{a}@layer cinder.utilities{ignored}@layer cinder.components{bc}';

    expect(extractComponentLayerBlocks(css)).toEqual(['a', 'bc']);
  });

  it('keeps nested at-rules inside a block rather than stopping at the first brace', () => {
    const nested = '@media (width>=40rem){.x{color:red}}';
    const css = `@layer cinder.components{${nested}}@layer cinder.components{y}`;

    expect(extractComponentLayerBlocks(css)).toEqual([nested, 'y']);
  });

  it('does not let braces inside quoted content unbalance the scan', () => {
    const css = '@layer cinder.components{.x::after{content:"}"}}@layer cinder.components{y}';

    expect(extractComponentLayerBlocks(css)).toEqual(['.x::after{content:"}"}', 'y']);
  });

  it('measures the blocks it finds', () => {
    expect(measureComponentLayer('@layer cinder.components{abc}')).toEqual({
      blocks: 1,
      size: 3,
    });
  });
});

/**
 * These exercise the contract against real CSS built from Cinder's supported
 * package entrypoints, so the assertion sees the same shape of output the
 * production build measures — without naming a single Cinder class or data
 * attribute.
 */
describe('assertComponentStylesBundled against published Cinder stylesheets', () => {
  // Card and Textarea are the two surfaces the previous private-selector check
  // covered; here they are reached through their public entrypoints instead.
  const componentSpecifiers = ['@lostgradient/cinder/card', '@lostgradient/cinder/textarea'];

  let published: PublishedComponentStylesheet[] = [];
  let baseOnlyCss = '';
  let styledBundleCss = '';

  beforeAll(async () => {
    published = await collectPublishedComponentStyles({
      specifiers: ['@lostgradient/cinder/styles', ...componentSpecifiers],
      resolveFrom: import.meta.dir,
    });

    baseOnlyCss = await buildPublishedStylesheet({
      specifier: '@lostgradient/cinder/styles',
      resolveFrom: import.meta.dir,
    });

    styledBundleCss = baseOnlyCss;
    for (const specifier of componentSpecifiers) {
      styledBundleCss += await buildPublishedStylesheet({
        specifier: `${specifier}/styles`,
        resolveFrom: import.meta.dir,
      });
    }
  });

  it('derives its expectation from the published component stylesheets', () => {
    expect(published.map((stylesheet) => stylesheet.specifier)).toEqual([
      '@lostgradient/cinder/card/styles',
      '@lostgradient/cinder/styles',
      '@lostgradient/cinder/textarea/styles',
    ]);
  });

  it('accepts a bundle that carries the published component CSS', () => {
    const audit = assertComponentStylesBundled({ bundleCss: styledBundleCss, published });

    expect(audit.missing).toEqual([]);
    expect(audit.present).toHaveLength(published.length);
  });

  it('rejects a bundle that ships the base stylesheet without component CSS', () => {
    expect(() => assertComponentStylesBundled({ bundleCss: baseOnlyCss, published })).toThrow(
      /missing Cinder component CSS/,
    );
  });

  it('names the single component whose CSS was dropped', () => {
    const withoutTextarea = styledBundleCss.replace(
      published.find((sheet) => sheet.specifier.includes('textarea'))?.blocks[0] ?? '',
      '',
    );

    expect(() => assertComponentStylesBundled({ bundleCss: withoutTextarea, published })).toThrow(
      /@lostgradient\/cinder\/textarea\/styles/,
    );
  });

  it('rejects a bundle that ships app CSS but no Cinder component CSS', () => {
    expect(() =>
      assertComponentStylesBundled({
        bundleCss: `${baseOnlyCss}\n.gateway-layout{display:grid}\n`,
        published,
      }),
    ).toThrow(/missing Cinder component CSS/);
  });

  it('rejects a bundle with no Cinder cascade layers at all', () => {
    expect(() =>
      assertComponentStylesBundled({ bundleCss: '.gateway-layout{display:grid}', published }),
    ).toThrow(/missing Cinder component CSS/);
  });

  it('refuses to pass when no published component stylesheets were found', () => {
    expect(() =>
      assertComponentStylesBundled({ bundleCss: styledBundleCss, published: [] }),
    ).toThrow(/No Cinder component stylesheets were found/);
  });
});
