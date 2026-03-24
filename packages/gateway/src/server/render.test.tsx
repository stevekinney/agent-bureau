import { describe, expect, it } from 'bun:test';

import { renderPage } from './render';

async function streamToString(stream: ReadableStream): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = '';
  let done = false;

  while (!done) {
    const chunk = await reader.read();
    done = chunk.done;
    if (chunk.value) {
      result += decoder.decode(chunk.value, { stream: !done });
    }
  }

  return result;
}

describe('renderPage', () => {
  it('returns a ReadableStream', async () => {
    const stream = await renderPage({
      title: 'Test Page',
      data: {},
      content: <p>Hello</p>,
    });

    expect(stream).toBeInstanceOf(ReadableStream);
  });

  it('includes the title in the HTML output', async () => {
    const stream = await renderPage({
      title: 'My Dashboard',
      data: {},
      content: <p>Content</p>,
    });

    const html = await streamToString(stream);
    expect(html).toContain('<title>My Dashboard</title>');
  });

  it('includes __INITIAL_DATA__ in the HTML output', async () => {
    const data = { runs: [{ id: 'run-1', status: 'completed' }] };
    const stream = await renderPage({
      title: 'Test',
      data,
      content: <p>Content</p>,
    });

    const html = await streamToString(stream);
    expect(html).toContain('window.__INITIAL_DATA__');
    expect(html).toContain(JSON.stringify(data));
  });

  it('includes the client script tag', async () => {
    const stream = await renderPage({
      title: 'Test',
      data: {},
      content: <p>Content</p>,
    });

    const html = await streamToString(stream);
    expect(html).toContain('/public/entry.js');
    expect(html).toContain('type="module"');
  });

  it('includes the stylesheet link', async () => {
    const stream = await renderPage({
      title: 'Test',
      data: {},
      content: <p>Content</p>,
    });

    const html = await streamToString(stream);
    expect(html).toContain('/public/styles.css');
  });

  it('renders the provided content inside the root div', async () => {
    const stream = await renderPage({
      title: 'Test',
      data: {},
      content: <h1>Dashboard</h1>,
    });

    const html = await streamToString(stream);
    expect(html).toContain('id="root"');
    expect(html).toContain('<h1>Dashboard</h1>');
  });
});
