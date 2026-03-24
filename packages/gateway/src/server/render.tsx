import { resolve } from 'node:path';

import type { ReactNode } from 'react';
import { renderToReadableStream } from 'react-dom/server';

type AssetManifest = Record<string, string>;

let cachedManifest: AssetManifest | undefined;

async function loadManifest(): Promise<AssetManifest> {
  if (cachedManifest) return cachedManifest;
  try {
    const manifestPath = resolve(import.meta.dir, 'manifest.json');
    const file = Bun.file(manifestPath);
    cachedManifest = (await file.json()) as AssetManifest;
  } catch {
    cachedManifest = {};
  }
  return cachedManifest;
}

interface RenderPageOptions {
  title: string;
  data: unknown;
  content: ReactNode;
  clientScript?: string;
  stylesheet?: string;
}

export async function renderPage({
  title,
  data,
  content,
  clientScript,
  stylesheet,
}: RenderPageOptions): Promise<ReadableStream> {
  const manifest = await loadManifest();
  const resolvedScript = clientScript ?? manifest['entry.js'] ?? '/public/entry.js';
  const resolvedStylesheet = stylesheet ?? '/public/styles.css';
  const serializedData = JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

  const stream = await renderToReadableStream(
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        <link rel="stylesheet" href={resolvedStylesheet} />
      </head>
      <body>
        <div id="root">{content}</div>
        <script
          dangerouslySetInnerHTML={{
            __html: `window.__INITIAL_DATA__ = ${serializedData}`,
          }}
        />
        <script type="module" src={resolvedScript} />
      </body>
    </html>,
  );

  return stream;
}
