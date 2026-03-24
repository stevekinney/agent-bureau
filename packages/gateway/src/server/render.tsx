import type { ReactNode } from 'react';
import { renderToReadableStream } from 'react-dom/server';

interface RenderPageOptions {
  title: string;
  data: unknown;
  content: ReactNode;
}

export async function renderPage({
  title,
  data,
  content,
}: RenderPageOptions): Promise<ReadableStream> {
  const serializedData = JSON.stringify(data);

  const stream = await renderToReadableStream(
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        <link rel="stylesheet" href="/public/styles.css" />
      </head>
      <body>
        <div id="root">{content}</div>
        <script
          dangerouslySetInnerHTML={{
            __html: `window.__INITIAL_DATA__ = ${serializedData}`,
          }}
        />
        <script type="module" src="/public/client.js" />
      </body>
    </html>,
  );

  return stream;
}
