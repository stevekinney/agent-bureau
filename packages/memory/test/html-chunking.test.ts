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

  it('carries the full heading label when it spans multiple text callbacks', async () => {
    const html = ['<h1>Install <code>CLI</code></h1>', '<p>Body text.</p>'].join('');

    const chunks = await chunkHtml(html);

    expect(chunks[0]!.heading).toBe('Install CLI');
  });

  it('does not label the next chunk with a heading that has no text', async () => {
    const html = ['<h1><img src="x.png"></h1>', '<p>Not a heading.</p>'].join('');

    const chunks = await chunkHtml(html);

    expect(chunks[0]!.heading).toBeUndefined();
  });

  it('preserves whitespace separators between adjacent inline elements', async () => {
    const html = '<p><strong>Hello</strong> <em>world</em></p>';
    const chunks = await chunkHtml(html);

    expect(chunks[0]!.text).toBe('Hello world');
  });

  it('decodes common HTML entities before storing text', async () => {
    const html = '<p>AT&amp;T&nbsp;plans</p>';
    const chunks = await chunkHtml(html);

    expect(chunks[0]!.text).toBe('AT&T plans');
  });

  it('decodes numeric character references', async () => {
    const html = '<p>caf&#233; &#x2013; menu</p>';
    const chunks = await chunkHtml(html);

    expect(chunks[0]!.text).toBe('café – menu');
  });

  it('captures text nodes that are not wrapped in any element', async () => {
    const html = 'Hello <b>world</b>';
    const chunks = await chunkHtml(html);

    expect(chunks[0]!.text).toBe('Hello world');
  });

  it('ignores elements nested inside skipped tags entirely', async () => {
    const html =
      '<p>Before<template><h1>Hidden</h1><p>Also hidden</p></template>After</p><p>Next</p>';
    const chunks = await chunkHtml(html);
    const combined = chunks.map((chunk) => chunk.text).join('\n');

    expect(combined).not.toContain('Hidden');
    expect(combined).not.toContain('Also hidden');
    // Nested block/heading tags inside a skipped container must not insert
    // spurious line breaks into the surrounding text.
    expect(combined).toBe('BeforeAfter\nNext');
    expect(chunks.find((chunk) => chunk.text.includes('Next'))?.heading).toBeUndefined();
  });
});
