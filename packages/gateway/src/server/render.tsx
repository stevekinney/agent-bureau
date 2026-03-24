import type { ReactNode } from 'react';
import { renderToReadableStream } from 'react-dom/server';

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
  clientScript = '/public/entry.js',
  stylesheet = '/public/styles.css',
}: RenderPageOptions): Promise<ReadableStream> {
  const serializedData = JSON.stringify(data).replace(/</g, '\\u003c');

  const stream = await renderToReadableStream(
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        <link rel="stylesheet" href={stylesheet} />
      </head>
      <body>
        <div id="root">{content}</div>
        <script
          dangerouslySetInnerHTML={{
            __html: `window.__INITIAL_DATA__ = ${serializedData}`,
          }}
        />
        <script type="module" src={clientScript} />
      </body>
    </html>,
  );

  return stream;
}
