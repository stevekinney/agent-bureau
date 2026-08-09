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
 *   1. Every Cinder component exposes a `<component>/styles` CSS subpath in its
 *      `exports` map, and that subpath is the component's own stylesheet.
 *   2. Component CSS lives in the documented `cinder.components` cascade layer
 *      (`cinder.tokens, cinder.foundation, cinder.components, cinder.utilities`).
 *
 * So the check is: record which Cinder entrypoints the client build actually
 * reached, build each one's published stylesheet through the same Bun CSS
 * pipeline, and require every one of those `cinder.components` blocks to be
 * present in the emitted bundle. Nothing here knows or cares what is *inside* a
 * block — a Cinder release that renames a class moves both sides of the
 * comparison together and changes nothing. A build that drops a component's CSS
 * side effect fails, and the error names the entrypoint that went missing.
 */

/** Matches the opening of a `@layer cinder.components { … }` block. */
const COMPONENT_LAYER_BLOCK = /@layer\s+cinder\.components\s*\{/g;

/** Matches any bare specifier into the Cinder package. */
const CINDER_SPECIFIER = /^@lostgradient\/cinder\/.+$/;

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
  /** Cinder specifiers resolved during that build, populated as it runs. */
  readonly specifiers: ReadonlySet<string>;
}

/**
 * Records every `@lostgradient/cinder/*` specifier a build resolves, so the
 * style contract is checked against the entrypoints the client bundle really
 * pulled in rather than a hand-maintained list. The plugin never resolves
 * anything itself — it returns `undefined` so Bun's default resolution runs.
 */
export function createCinderSpecifierRecorder(): CinderSpecifierRecorder {
  const specifiers = new Set<string>();

  const plugin: BunPlugin = {
    name: 'cinder-specifier-recorder',
    setup(build) {
      build.onResolve({ filter: CINDER_SPECIFIER }, (arguments_) => {
        specifiers.add(arguments_.path);
        return undefined;
      });
    },
  };

  return { plugin, specifiers };
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

/** One published Cinder stylesheet the emitted bundle is expected to carry. */
export interface PublishedComponentStylesheet {
  /** The `<component>/styles` entrypoint the CSS came from. */
  readonly specifier: string;
  /** Bodies of its `@layer cinder.components` blocks. */
  readonly blocks: readonly string[];
}

/**
 * Maps a Cinder specifier onto the published CSS subpath that carries its
 * styles: CSS entrypoints stand for themselves, component entrypoints delegate
 * to their `<component>/styles` sibling.
 */
function toStylesheetSpecifier(specifier: string): string {
  return specifier.endsWith('/styles') || specifier.endsWith('.css')
    ? specifier
    : `${specifier}/styles`;
}

/** Inputs for {@link collectPublishedComponentStyles}. */
export interface PublishedComponentStylesRequest {
  /** Cinder specifiers observed in the client graph. */
  readonly specifiers: Iterable<string>;
  /** Directory the specifiers are resolved from. */
  readonly resolveFrom: string;
}

/**
 * Builds the published stylesheet behind each observed Cinder specifier and
 * keeps the ones that contribute component-layer CSS. Specifiers with no
 * published stylesheet, or whose stylesheet declares no component layer, ship
 * no component CSS of their own and are skipped rather than treated as errors.
 */
export async function collectPublishedComponentStyles({
  specifiers,
  resolveFrom,
}: PublishedComponentStylesRequest): Promise<PublishedComponentStylesheet[]> {
  const stylesheetSpecifiers = [...new Set([...specifiers].map(toStylesheetSpecifier))].sort();
  const published: PublishedComponentStylesheet[] = [];

  for (const specifier of stylesheetSpecifiers) {
    try {
      Bun.resolveSync(specifier, resolveFrom);
    } catch {
      continue;
    }

    const blocks = extractComponentLayerBlocks(
      await buildPublishedStylesheet({ specifier, resolveFrom }),
    );

    if (blocks.length > 0) published.push({ specifier, blocks });
  }

  return published;
}

/** Both sides of the production comparison. */
export interface ComponentStyleAuditInput {
  /** The stylesheet the build is about to write to `dist/public/styles.css`. */
  readonly bundleCss: string;
  /** What the observed Cinder entrypoints publish, from
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
 * Throws unless every Cinder entrypoint in the client graph has its published
 * component CSS in the emitted bundle. Returns the audit so the caller can
 * report it.
 */
export function assertComponentStylesBundled(input: ComponentStyleAuditInput): ComponentStyleAudit {
  const audit = auditComponentStyles(input);
  const { bundle, present, missing } = audit;

  if (present.length === 0 && missing.length === 0) {
    throw new Error(
      'No Cinder component stylesheets were found for the client graph, so the production ' +
        'stylesheet cannot be verified. Check that the client build still resolves ' +
        '@lostgradient/cinder component entrypoints.',
    );
  }

  if (missing.length > 0) {
    throw new Error(
      `Production stylesheet is missing Cinder component CSS from ${missing.length} of ` +
        `${present.length + missing.length} entrypoint(s) in the client graph: ` +
        `${missing.join(', ')}. The emitted bundle contributes ${bundle.blocks} block(s) / ` +
        `${bundle.size} characters to the cinder.components cascade layer. Components rendered ` +
        'by the Gateway client are not contributing their CSS side effects to the client bundle.',
    );
  }

  return audit;
}
