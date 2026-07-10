import { describe, expect, it } from 'bun:test';

import { chunkHtml } from '../src/html-chunking';

describe('chunkHtml', () => {
  it('returns an empty array for empty HTML', async () => {
    expect(await chunkHtml('')).toEqual([]);
  });

  it('returns an empty array for whitespace-only HTML', async () => {
    expect(await chunkHtml('   \n  ')).toEqual([]);
  });

  it('strips tags and extracts plain text', async () => {
    const html = '<html><body><p>Hello world.</p></body></html>';
    const chunks = await chunkHtml(html);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe('Hello world.');
  });

  it('drops script and style content entirely', async () => {
    const html = `
      <html>
        <head><style>body { color: red; }</style></head>
        <body>
          <script>console.log('should not appear');</script>
          <p>Visible paragraph.</p>
        </body>
      </html>
    `;

    const chunks = await chunkHtml(html);
    const combined = chunks.map((chunk) => chunk.text).join('\n');

    expect(combined).toContain('Visible paragraph.');
    expect(combined).not.toContain('color: red');
    expect(combined).not.toContain('should not appear');
  });

  it('inserts line breaks between block-level elements', async () => {
    const html = '<div><p>First paragraph.</p><p>Second paragraph.</p></div>';
    const chunks = await chunkHtml(html);

    expect(chunks[0]!.text.split('\n')).toEqual(['First paragraph.', 'Second paragraph.']);
  });

  it('tags chunks with the nearest preceding heading text', async () => {
    const html = [
      '<h1>Introduction</h1>',
      '<p>Intro body text.</p>',
      '<h2>Details</h2>',
      '<p>Details body text.</p>',
    ].join('');

    const chunks = await chunkHtml(html, { maximumTokens: 5, overlapTokens: 0 });

    const introChunk = chunks.find((chunk) => chunk.text.includes('Intro body'));
    const detailsChunk = chunks.find((chunk) => chunk.text.includes('Details body'));

    expect(introChunk?.heading).toBe('Introduction');
    expect(detailsChunk?.heading).toBe('Details');
  });

  it('matches the chunk(document) -> chunks loader contract', async () => {
    const html = '<p>Loader contract check.</p>';
    const chunks = await chunkHtml(html, { maximumTokens: 400 });

    for (const chunk of chunks) {
      expect(typeof chunk.text).toBe('string');
      expect(typeof chunk.index).toBe('number');
      expect(typeof chunk.startLine).toBe('number');
      expect(typeof chunk.endLine).toBe('number');
    }
  });
});
