import type { BunPlugin } from 'bun';

/**
 * Production stylesheet contract.
 *
 * The Gateway build has to fail when Cinder's per-component CSS never reaches
 * the emitted stylesheet — a silent regression that ships an unstyled UI. It
 * must do that without asserting Cinder class names or data attributes: those
 * are Cinder implementation details, so a non-breaking Cinder refactor would
 * otherwise break our build even though every component still renders correctly
 * through its supported entrypoint.
 *
 * The contract used instead is one Cinder publishes:
 *
 *   1. A component that ships CSS of its own exposes it at the
 *      `<component>/styles` subpath of Cinder's `exports` map. The map is the
 *      published contract, so it — not a guess — decides which components are
 *      expected to contribute CSS.
 *   2. Component CSS lives in the documented `cinder.components` cascade layer
 *      (`cinder.tokens, cinder.foundation, cinder.components, cinder.utilities`).
 *
 * So the check is: record which Cinder components the client build actually
 * reached, build each one's published stylesheet through the same Bun CSS
 * pipeline, and require every one of those `cinder.components` blocks to be
 * present in the emitted bundle. Nothing here knows or cares what is *inside* a
 * block — a Cinder release that renames a class moves both sides of the
 * comparison together and changes nothing. A build that drops a component's CSS
 * side effect fails, and the error names the entrypoint that went missing.
 *
 * Two exclusions keep the check from passing vacuously:
 *
 *   - The base cascade entrypoint (`@lostgradient/cinder/styles`) is never
 *     treated as a component stylesheet. It documents that it "does NOT import
 *     per-component CSS", yet it does contribute `cinder.components` blocks for
 *     shared internal chrome. Counting it would mean a client graph that stopped
 *     resolving every component entrypoint still satisfied the audit on the
 *     strength of base CSS alone.
 *   - A `<component>/styles` subpath that Cinder declares but that fails to
 *     resolve or build is a hard error, never a silently shrunken expectation.
 *     Only components with no such subpath at all — Cinder ships several, e.g.
 *     `icons` and `focus-trap` — are skipped, because they publish no stylesheet
 *     to look for.
 */

/** Matches the opening of a `@layer cinder.components { … }` block. */
const COMPONENT_LAYER_BLOCK = /@layer\s+cinder\.components\s*\{/g;

/**
 * Matches subpath specifiers into the Cinder package (`@lostgradient/cinder/x`),
 * capturing the subpath. The bare package root is deliberately excluded: the
 * contract above is derived per component subpath, so a root-barrel import
 * yields no `<component>/styles` to check and recording it would add a specifier
 * nothing can be derived from. A graph that stopped resolving component subpaths
 * — whether by switching to the root barrel or by losing the CSS side effect
 * entirely — is caught by the empty-set guard in
 * {@link assertComponentStylesBundled}, not by widening this filter.
 */
const CINDER_SUBPATH_SPECIFIER = /^@lostgradient\/cinder\/(.+)$/;

/**
 * First subpath segment of Cinder's base cascade entrypoints (`styles`,
 * `styles/all`, `styles/tokens`, …). See the exclusion note above.
 */
const BASE_CASCADE_SEGMENT = 'styles';

/** How much CSS a stylesheet contributes to Cinder's `cinder.components` layer. */
export interface ComponentLayerMeasurement {
  /** Number of `@layer cinder.components` blocks found. */
  readonly blocks: number;
  /** Total characters of CSS inside those blocks, braces excluded. */
  readonly size: number;
}

/**
 * Returns the index just past a quoted CSS string that starts at `quoteIndex`,
 * so brace counting never trips over declarations like `content: "}"`.
 */
function skipQuoted(source: string, quoteIndex: number): number {
  const quote = source[quoteIndex];
  let index = quoteIndex + 1;

  while (index < source.length) {
    const character = source[index];

    if (character === '\\') {
      index += 2;
      continue;
    }

    if (character === quote) return index + 1;

    index += 1;
  }

  return index;
}

/**
 * Returns the body of the balanced block whose `{` sits at `openBraceIndex`, or
 * `undefined` when the stylesheet is unbalanced (truncated output).
 */
function readBlockBody(source: string, openBraceIndex: number): string | undefined {
  let depth = 0;
  let index = openBraceIndex;

  while (index < source.length) {
    const character = source[index];

    if (character === '"' || character === "'") {
      index = skipQuoted(source, index);
      continue;
    }

    if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(openBraceIndex + 1, index);
    }

    index += 1;
  }

  return undefined;
}

/**
 * Returns the body of every `@layer cinder.components` block in `css`. The
 * layer name is part of Cinder's documented public cascade contract; nothing
 * here depends on the selectors inside a block.
 */
export function extractComponentLayerBlocks(css: string): string[] {
  const pattern = new RegExp(COMPONENT_LAYER_BLOCK.source, 'g');
  const bodies: string[] = [];

  for (let match = pattern.exec(css); match !== null; match = pattern.exec(css)) {
    const openBraceIndex = match.index + match[0].length - 1;
    const body = readBlockBody(css, openBraceIndex);

    if (body === undefined) break;

    bodies.push(body);
    // Resume after the closing brace so nested blocks are not counted twice.
    pattern.lastIndex = openBraceIndex + body.length + 2;
  }

  return bodies;
}

/** Summarises a stylesheet's footprint in Cinder's component cascade layer. */
export function measureComponentLayer(css: string): ComponentLayerMeasurement {
  const bodies = extractComponentLayerBlocks(css);

  return {
    blocks: bodies.length,
    size: bodies.reduce((total, body) => total + body.length, 0),
  };
}

/** A Bun plugin plus the Cinder entrypoints it observed. */
export interface CinderSpecifierRecorder {
  /** Attach to a `Bun.build` call to observe its module graph. */
  readonly plugin: BunPlugin;
  /** Cinder subpath specifiers resolved during that build, populated as it runs. */
  readonly specifiers: ReadonlySet<string>;
}

/**
 * Records every `@lostgradient/cinder/*` subpath specifier a build resolves, so
 * the style contract is checked against the entrypoints the client bundle really
 * pulled in rather than a hand-maintained list. The plugin never resolves
 * anything itself — it returns `undefined` so Bun's default resolution runs.
 */
export function createCinderSpecifierRecorder(): CinderSpecifierRecorder {
  const specifiers = new Set<string>();

  const plugin: BunPlugin = {
    name: 'cinder-specifier-recorder',
    setup(build) {
      build.onResolve({ filter: CINDER_SUBPATH_SPECIFIER }, (arguments_) => {
        specifiers.add(arguments_.path);
        return undefined;
      });
    },
  };

  return { plugin, specifiers };
}

/**
 * Reduces an observed Cinder specifier to the component it belongs to, or
 * `undefined` when it names no component. `@lostgradient/cinder/card` and
 * `@lostgradient/cinder/card/schema` both belong to `card`; the base cascade
 * entrypoints under `styles` belong to no component and are excluded.
 */
export function toCinderComponentName(specifier: string): string | undefined {
  const subpath = CINDER_SUBPATH_SPECIFIER.exec(specifier)?.[1];
  if (subpath === undefined) return undefined;

  const segment = subpath.split('/')[0];
  if (segment === undefined || segment === '' || segment === BASE_CASCADE_SEGMENT) {
    return undefined;
  }

  return segment;
}

/** Which published stylesheet to build, and where to resolve it from. */
export interface PublishedStylesheetRequest {
  /** A package entrypoint that resolves to CSS, e.g. `@lostgradient/cinder/styles`. */
  readonly specifier: string;
  /** Directory the specifier is resolved from. */
  readonly resolveFrom: string;
}

/**
 * Builds a published CSS entrypoint through the same Bun CSS pipeline the
 * client pass uses, so its output is directly comparable to the emitted bundle.
 * Resolution goes through the package's `exports` map, so this only ever
 * touches supported entrypoints.
 */
export async function buildPublishedStylesheet({
  specifier,
  resolveFrom,
}: PublishedStylesheetRequest): Promise<string> {
  const entrypoint = Bun.resolveSync(specifier, resolveFrom);
  const result = await Bun.build({ entrypoints: [entrypoint], target: 'browser', minify: true });

  if (!result.success) {
    throw new Error(
      `Failed to build ${specifier}: ${result.logs.map((log) => String(log)).join('\n')}`,
    );
  }

  let css = '';
  for (const output of result.outputs) {
    css += await output.text();
  }

  return css;
}

/**
 * Narrows a parsed `package.json` to the set of subpaths in its `exports` map
 * (`'./card/styles'`, …). An absent or malformed map yields an empty set, which
 * makes every component look stylesheet-free and is caught downstream by the
 * empty-set guard rather than passing silently.
 */
function toExportedSubpaths(manifest: unknown): ReadonlySet<string> {
  if (typeof manifest !== 'object' || manifest === null || !('exports' in manifest)) {
    return new Set();
  }

  const { exports } = manifest;
  if (typeof exports !== 'object' || exports === null) return new Set();

  return new Set(Object.keys(exports));
}

/**
 * Reads the subpaths Cinder publishes. `./package.json` is itself an entry in
 * that map, so this stays inside the package's supported surface.
 */
export async function readCinderExportedSubpaths(
  resolveFrom: string,
): Promise<ReadonlySet<string>> {
  const manifestPath = Bun.resolveSync('@lostgradient/cinder/package.json', resolveFrom);

  return toExportedSubpaths(await Bun.file(manifestPath).json());
}

/** One published Cinder stylesheet the emitted bundle is expected to carry. */
export interface PublishedComponentStylesheet {
  /** The `<component>/styles` entrypoint the CSS came from. */
  readonly specifier: string;
  /** Bodies of its `@layer cinder.components` blocks. */
  readonly blocks: readonly string[];
}

/** What component discovery found for the observed client graph. */
export interface ComponentStylesheetCensus {
  /** Component stylesheets the emitted bundle is expected to carry. */
  readonly published: readonly PublishedComponentStylesheet[];
  /** Observed components Cinder publishes no `<component>/styles` subpath for. */
  readonly withoutStylesheet: readonly string[];
  /**
   * Observed components whose published stylesheet carries no component-layer
   * CSS *and* whose parent stylesheet was observed and published. An
   * unexpected empty stylesheet throws rather than landing here — see
   * {@link EMPTY_COMPONENT_STYLESHEET_PARENTS}.
   */
  readonly withoutComponentLayer: readonly string[];
}

/**
 * Components Cinder publishes a `<component>/styles` subpath for even though it
 * contributes no `cinder.components` CSS of its own.
 *
 * These are the Table subcomponents. Cinder styles them from the parent
 * `table` stylesheet using descendant selectors — verified against 0.21.0,
 * where the emitted bundle contains `.cinder-table` but no `.cinder-table-cell`
 * or `.cinder-table-row` rules anywhere. The subpaths exist for API symmetry,
 * not because they carry styles.
 *
 * Anything NOT on this list that builds to an empty component layer is treated
 * as a break rather than as one fewer thing to verify: a sidecar that silently
 * became empty is exactly the upstream regression this audit exists to catch.
 * Adding an entry here is a deliberate statement that the component is styled
 * by its named parent — confirm that before you add one.
 */
const EMPTY_COMPONENT_STYLESHEET_PARENTS: ReadonlyMap<string, string> = new Map([
  ['table-body', 'table'],
  ['table-cell', 'table'],
  ['table-header', 'table'],
  ['table-header-cell', 'table'],
  ['table-row', 'table'],
]);

/** Inputs for {@link collectPublishedComponentStyles}. */
export interface PublishedComponentStylesRequest {
  /** Cinder specifiers observed in the client graph. */
  readonly specifiers: Iterable<string>;
  /** Directory the specifiers are resolved from. */
  readonly resolveFrom: string;
}

/**
 * Builds the published stylesheet behind each observed Cinder component and
 * reports what it found.
 *
 * Three outcomes, and the difference between them is the point:
 *
 *   - Cinder declares no `./<component>/styles` subpath — the component ships no
 *     CSS of its own (`icons`, `focus-trap`, `skip-link` in 0.17.0). Nothing to
 *     look for, so it is reported in `withoutStylesheet`.
 *   - The subpath is declared and builds to no `cinder.components` CSS. Cinder
 *     ships a few deliberately as "empty registry entries" (the Table
 *     subcomponents, whose visual treatment lives in `table.css`). Only the
 *     components named in {@link EMPTY_COMPONENT_STYLESHEET_PARENTS} are
 *     accepted only when their parent component's stylesheet entered
 *     `published`, so the later bundle audit requires its CSS. Any other empty
 *     stylesheet throws, because silently dropping it would let the audit pass
 *     while that component ships unstyled.
 *   - The subpath is declared but cannot be resolved or built. That is a break
 *     in the published contract, so it throws instead of quietly shrinking the
 *     set the bundle is measured against.
 */
export async function collectPublishedComponentStyles({
  specifiers,
  resolveFrom,
}: PublishedComponentStylesRequest): Promise<ComponentStylesheetCensus> {
  const exportedSubpaths = await readCinderExportedSubpaths(resolveFrom);

  const components = [
    ...new Set(
      [...specifiers]
        .map((specifier) => toCinderComponentName(specifier))
        .filter((component) => component !== undefined),
    ),
  ].sort();

  const published: PublishedComponentStylesheet[] = [];
  const withoutStylesheet: string[] = [];
  const withoutComponentLayer: string[] = [];

  for (const component of components) {
    if (!exportedSubpaths.has(`./${component}/styles`)) {
      withoutStylesheet.push(component);
      continue;
    }

    const specifier = `@lostgradient/cinder/${component}/styles`;
    let css: string;

    try {
      css = await buildPublishedStylesheet({ specifier, resolveFrom });
    } catch (cause) {
      throw new Error(
        `Cinder publishes ${specifier} in its exports map, but the Gateway build could not ` +
          'build it. The production stylesheet cannot be verified against a component whose ' +
          'published stylesheet is unavailable, so this is a hard failure rather than one ' +
          'fewer thing to check.',
        { cause },
      );
    }

    // A block whose body is blank would match any bundle, so it proves nothing.
    const blocks = extractComponentLayerBlocks(css).filter((block) => block.trim() !== '');

    if (blocks.length > 0) {
      published.push({ specifier, blocks });
      continue;
    }

    const parentComponent = EMPTY_COMPONENT_STYLESHEET_PARENTS.get(component);
    if (parentComponent === undefined) {
      throw new Error(
        `Cinder publishes ${specifier}, but it builds to no \`cinder.components\` CSS. ` +
          'An empty sidecar silently drops this component from the production check, so ' +
          'the audit would keep passing while the component ships unstyled. Either the ' +
          'component moved its styles elsewhere — in which case add its required parent to ' +
          'EMPTY_COMPONENT_STYLESHEET_PARENTS with the evidence — or Cinder regressed.',
      );
    }

    const parentStylesheet = `@lostgradient/cinder/${parentComponent}/styles`;
    if (!components.includes(parentComponent)) {
      throw new Error(
        `Cinder publishes ${specifier}, but it builds to no \`cinder.components\` CSS and ` +
          `requires @lostgradient/cinder/${parentComponent} to be present in the client graph. ` +
          `Its visual treatment lives in ${parentStylesheet}, so the production audit cannot ` +
          'exempt this sidecar unless it also verifies that parent stylesheet in the bundle.',
      );
    }

    withoutComponentLayer.push(component);
  }

  for (const component of withoutComponentLayer) {
    const parentComponent = EMPTY_COMPONENT_STYLESHEET_PARENTS.get(component);
    if (parentComponent === undefined) continue;

    const parentStylesheet = `@lostgradient/cinder/${parentComponent}/styles`;
    if (!published.some((stylesheet) => stylesheet.specifier === parentStylesheet)) {
      throw new Error(
        `Cinder publishes @lostgradient/cinder/${component}/styles, but its required parent ` +
          `${parentStylesheet} did not produce component-layer CSS for the production audit. ` +
          'The sidecar cannot be exempt unless the audit can verify that parent stylesheet in ' +
          'the emitted bundle.',
      );
    }
  }

  return { published, withoutStylesheet, withoutComponentLayer };
}

/** Both sides of the production comparison. */
export interface ComponentStyleAuditInput {
  /** The stylesheet the build is about to write to `dist/public/styles.css`. */
  readonly bundleCss: string;
  /** What the observed Cinder components publish, from
   * {@link collectPublishedComponentStyles}. */
  readonly published: readonly PublishedComponentStylesheet[];
}

/** Result of comparing the emitted bundle against what Cinder publishes. */
export interface ComponentStyleAudit {
  /** What the emitted stylesheet contributes to `cinder.components`. */
  readonly bundle: ComponentLayerMeasurement;
  /** Entrypoints whose published component CSS was found in the bundle. */
  readonly present: readonly string[];
  /** Entrypoints whose published component CSS is missing from the bundle. */
  readonly missing: readonly string[];
}

/** Compares both sides without judging them. */
export function auditComponentStyles({
  bundleCss,
  published,
}: ComponentStyleAuditInput): ComponentStyleAudit {
  const present: string[] = [];
  const missing: string[] = [];

  for (const stylesheet of published) {
    const bundled = stylesheet.blocks.every((block) => bundleCss.includes(block));
    (bundled ? present : missing).push(stylesheet.specifier);
  }

  return { bundle: measureComponentLayer(bundleCss), present, missing };
}

/**
 * Throws unless every Cinder component in the client graph has its published
 * component CSS in the emitted bundle. Returns the audit so the caller can
 * report it.
 */
export function assertComponentStylesBundled(input: ComponentStyleAuditInput): ComponentStyleAudit {
  const audit = auditComponentStyles(input);
  const { bundle, present, missing } = audit;

  if (present.length === 0 && missing.length === 0) {
    throw new Error(
      'No Cinder component stylesheets were found for the client graph, so the production ' +
        "stylesheet cannot be verified. Cinder's base entrypoint " +
        "(`@lostgradient/cinder/styles`) does not count here — it ships no component's CSS. " +
        'Check that the client build still resolves `@lostgradient/cinder/<component>` ' +
        'entrypoints and that they still carry their CSS side effects.',
    );
  }

  if (missing.length > 0) {
    throw new Error(
      `Production stylesheet is missing Cinder component CSS from ${missing.length} of ` +
        `${present.length + missing.length} component entrypoint(s) in the client graph: ` +
        `${missing.join(', ')}. The emitted bundle contributes ${bundle.blocks} block(s) / ` +
        `${bundle.size} characters to the cinder.components cascade layer. Components rendered ` +
        'by the Gateway client are not contributing their CSS side effects to the client bundle.',
    );
  }

  return audit;
}
