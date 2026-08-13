import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import type { ComponentStylesheetCensus } from '../../scripts/style-contract';
import {
  assertComponentStylesBundled,
  buildPublishedStylesheet,
  collectPublishedComponentStyles,
  extractComponentLayerBlocks,
  measureComponentLayer,
  toCinderComponentName,
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

describe('toCinderComponentName', () => {
  it('reduces a component entrypoint to its component', () => {
    expect(toCinderComponentName('@lostgradient/cinder/card')).toBe('card');
  });

  it('reduces a component subpath to the same component', () => {
    expect(toCinderComponentName('@lostgradient/cinder/card/schema')).toBe('card');
  });

  it('excludes the base cascade entrypoint, which ships no component of its own', () => {
    expect(toCinderComponentName('@lostgradient/cinder/styles')).toBeUndefined();
    expect(toCinderComponentName('@lostgradient/cinder/styles/all')).toBeUndefined();
  });

  it('ignores the bare package root, which names no component subpath', () => {
    expect(toCinderComponentName('@lostgradient/cinder')).toBeUndefined();
  });

  it('ignores specifiers from other packages', () => {
    expect(toCinderComponentName('@lostgradient/weft/engine')).toBeUndefined();
  });
});

/**
 * Discovery is driven by Cinder's published `exports` map, so these use a
 * throwaway package whose map states each case exactly. Nothing here depends on
 * which components the real Cinder happens to ship today.
 */
describe('collectPublishedComponentStyles discovery outcomes', () => {
  let resolveFrom = '';
  let packageManifest = '';

  beforeAll(async () => {
    resolveFrom = await mkdtemp(join(tmpdir(), 'gateway-style-contract-'));
    const packageDirectory = join(resolveFrom, 'node_modules', '@lostgradient', 'cinder');

    packageManifest = JSON.stringify({
      name: '@lostgradient/cinder',
      version: '0.0.0-fixture',
      exports: {
        './package.json': './package.json',
        './styles': './styles.css',
        './paint': './paint/paint.js',
        './paint/styles': './paint/paint.css',
        './table': './table/table.js',
        './table/styles': './table/table.css',
        // Empty, and NOT on the known-empty list — must be rejected.
        './hollow/styles': './hollow/hollow.css',
        // Empty, but a real Table subcomponent, so the exemption applies.
        './table-row/styles': './table-row/table-row.css',
        // Declared, but the file it points at does not exist.
        './phantom/styles': './phantom/phantom.css',
      },
    });
    await Bun.write(join(packageDirectory, 'package.json'), packageManifest);
    await Bun.write(join(packageDirectory, 'styles.css'), '@layer cinder.components{.base{gap:0}}');
    await Bun.write(
      join(packageDirectory, 'paint', 'paint.css'),
      '@layer cinder.components{.paint{color:red}}',
    );
    await Bun.write(join(packageDirectory, 'paint', 'paint.js'), 'export const paint = true;');
    await Bun.write(join(packageDirectory, 'table', 'table.js'), 'export const table = true;');
    await Bun.write(
      join(packageDirectory, 'table', 'table.css'),
      '@layer cinder.components{.table{display:grid}}',
    );
    await Bun.write(
      join(packageDirectory, 'hollow', 'hollow.css'),
      '@layer cinder.components{/* visual treatment lives elsewhere */}',
    );
    await Bun.write(
      join(packageDirectory, 'table-row', 'table-row.css'),
      '@layer cinder.components{/* styled by the parent table stylesheet */}',
    );
  });

  afterAll(async () => {
    await rm(resolveFrom, { recursive: true, force: true });
  });

  it('never counts the base stylesheet as a component stylesheet', async () => {
    const census = await collectPublishedComponentStyles({
      specifiers: ['@lostgradient/cinder/styles'],
      resolveFrom,
    });

    expect(census).toEqual({ published: [], withoutStylesheet: [], withoutComponentLayer: [] });
  });

  it('collects a component whose published stylesheet carries component-layer CSS', async () => {
    const census = await collectPublishedComponentStyles({
      specifiers: ['@lostgradient/cinder/styles', '@lostgradient/cinder/paint'],
      resolveFrom,
    });

    expect(census.published.map((stylesheet) => stylesheet.specifier)).toEqual([
      '@lostgradient/cinder/paint/styles',
    ]);
    expect(census.published[0]?.blocks).toEqual(['.paint{color:red}']);
  });

  it('reports a component with no published stylesheet instead of failing', async () => {
    const census = await collectPublishedComponentStyles({
      specifiers: ['@lostgradient/cinder/plain'],
      resolveFrom,
    });

    expect(census.withoutStylesheet).toEqual(['plain']);
    expect(census.published).toEqual([]);
  });

  it('fails when a Table sidecar is observed without the parent Table stylesheet', async () => {
    const failure: unknown = await collectPublishedComponentStyles({
      specifiers: ['@lostgradient/cinder/table-row'],
      resolveFrom,
    }).then(
      (census) => census,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toMatch(
      /table-row\/styles.*requires @lostgradient\/cinder\/table to be present/,
    );
  });

  it('accepts a Table sidecar only when the parent stylesheet enters the published census', async () => {
    const census = await collectPublishedComponentStyles({
      specifiers: ['@lostgradient/cinder/table', '@lostgradient/cinder/table-row'],
      resolveFrom,
    });

    expect(census.withoutComponentLayer).toEqual(['table-row']);
    expect(census.published).toEqual([
      {
        specifier: '@lostgradient/cinder/table/styles',
        blocks: ['.table{display:grid}'],
      },
    ]);
  });

  it('fails when the parent Table stylesheet is unavailable', async () => {
    const packageDirectory = join(resolveFrom, 'node_modules', '@lostgradient', 'cinder');
    await Bun.write(
      join(packageDirectory, 'package.json'),
      JSON.stringify({
        name: '@lostgradient/cinder',
        version: '0.0.0-fixture',
        exports: {
          './package.json': './package.json',
          './table': './table/table.js',
          './table-row/styles': './table-row/table-row.css',
        },
      }),
    );

    const failure: unknown = await collectPublishedComponentStyles({
      specifiers: ['@lostgradient/cinder/table', '@lostgradient/cinder/table-row'],
      resolveFrom,
    }).then(
      (census) => census,
      (error: unknown) => error,
    );
    await Bun.write(join(packageDirectory, 'package.json'), packageManifest);

    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toMatch(/table\/styles did not produce component-layer CSS/);
  });

  it('fails loudly when an unexpected component stylesheet builds to nothing', async () => {
    // `paint` still resolves, so dropping `hollow` would leave a nonempty
    // expected set and let the audit pass while `hollow` ships unstyled.
    const failure: unknown = await collectPublishedComponentStyles({
      specifiers: ['@lostgradient/cinder/paint', '@lostgradient/cinder/hollow'],
      resolveFrom,
    }).then(
      (census) => census,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toMatch(
      /publishes @lostgradient\/cinder\/hollow\/styles, but it builds to no/,
    );
  });

  it('fails loudly when a declared component stylesheet cannot be built', async () => {
    // `paint` still resolves, so a silent skip would leave a nonempty expected
    // set and let the audit pass. The rejection is the point.
    const failure: unknown = await collectPublishedComponentStyles({
      specifiers: ['@lostgradient/cinder/paint', '@lostgradient/cinder/phantom'],
      resolveFrom,
    }).then(
      (census) => census,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toMatch(
      /publishes @lostgradient\/cinder\/phantom\/styles in its exports map/,
    );
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

  let census: ComponentStylesheetCensus = {
    published: [],
    withoutStylesheet: [],
    withoutComponentLayer: [],
  };
  let baseOnlyCss = '';
  let styledBundleCss = '';

  beforeAll(async () => {
    census = await collectPublishedComponentStyles({
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

  it('derives its expectation from the published component stylesheets alone', () => {
    expect(census.published.map((stylesheet) => stylesheet.specifier)).toEqual([
      '@lostgradient/cinder/card/styles',
      '@lostgradient/cinder/textarea/styles',
    ]);
  });

  it('accepts a bundle that carries the published component CSS', () => {
    const audit = assertComponentStylesBundled({
      bundleCss: styledBundleCss,
      published: census.published,
    });

    expect(audit.missing).toEqual([]);
    expect(audit.present).toHaveLength(census.published.length);
  });

  it('rejects a bundle that ships the base stylesheet without component CSS', () => {
    expect(() =>
      assertComponentStylesBundled({ bundleCss: baseOnlyCss, published: census.published }),
    ).toThrow(/missing Cinder component CSS/);
  });

  it('names the single component whose CSS was dropped', () => {
    const withoutTextarea = styledBundleCss.replace(
      census.published.find((sheet) => sheet.specifier.includes('textarea'))?.blocks[0] ?? '',
      '',
    );

    expect(() =>
      assertComponentStylesBundled({ bundleCss: withoutTextarea, published: census.published }),
    ).toThrow(/@lostgradient\/cinder\/textarea\/styles/);
  });

  it('rejects a bundle that ships app CSS but no Cinder component CSS', () => {
    expect(() =>
      assertComponentStylesBundled({
        bundleCss: `${baseOnlyCss}\n.gateway-layout{display:grid}\n`,
        published: census.published,
      }),
    ).toThrow(/missing Cinder component CSS/);
  });

  it('rejects a bundle with no Cinder cascade layers at all', () => {
    expect(() =>
      assertComponentStylesBundled({
        bundleCss: '.gateway-layout{display:grid}',
        published: census.published,
      }),
    ).toThrow(/missing Cinder component CSS/);
  });

  it('refuses to pass when no published component stylesheets were found', () => {
    expect(() =>
      assertComponentStylesBundled({ bundleCss: styledBundleCss, published: [] }),
    ).toThrow(/No Cinder component stylesheets were found/);
  });

  /**
   * The regression the whole check exists for: a client graph that resolves only
   * Cinder's base entrypoint must fail, even though the base stylesheet's own
   * `cinder.components` blocks are present in the bundle.
   */
  it('fails when the client graph resolves the base stylesheet and nothing else', async () => {
    const baseOnlyCensus = await collectPublishedComponentStyles({
      specifiers: ['@lostgradient/cinder/styles'],
      resolveFrom: import.meta.dir,
    });

    expect(baseOnlyCensus.published).toEqual([]);
    expect(() =>
      assertComponentStylesBundled({
        bundleCss: styledBundleCss,
        published: baseOnlyCensus.published,
      }),
    ).toThrow(/No Cinder component stylesheets were found/);
  });
});
