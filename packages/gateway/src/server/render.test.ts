import { describe, expect, it } from 'bun:test';

import { renderPage } from './render';
import Fixture from './test-fixtures/render-fixture.svelte';

const baseProps = { initialData: { label: 'hello' }, pathname: '/dashboard' };

describe('renderPage', () => {
  it('returns a complete HTML document string', async () => {
    const html = await renderPage({ title: 'Test Page', component: Fixture, props: baseProps });

    expect(typeof html).toBe('string');
    expect(html).toStartWith('<!doctype html>');
    expect(html).toContain('<html lang="en">');
  });

  it('includes the title in the HTML output', async () => {
    const html = await renderPage({ title: 'My Dashboard', component: Fixture, props: baseProps });

    expect(html).toContain('<title>My Dashboard</title>');
  });

  it('renders the Svelte component markup inside the root div', async () => {
    const html = await renderPage({ title: 'Test', component: Fixture, props: baseProps });

    expect(html).toContain('id="root"');
    expect(html).toContain('<h1>Fixture</h1>');
    expect(html).toContain('hello');
  });

  it('passes props through to the rendered component', async () => {
    const html = await renderPage({
      title: 'Test',
      component: Fixture,
      props: { initialData: { label: 'projected' }, pathname: '/runs/abc' },
    });

    expect(html).toContain('projected');
    expect(html).toContain('data-pathname="/runs/abc"');
  });

  it('serializes the props into window.__INITIAL_DATA__ by default', async () => {
    const html = await renderPage({ title: 'Test', component: Fixture, props: baseProps });

    expect(html).toContain('window.__INITIAL_DATA__ =');
    expect(html).toContain(JSON.stringify(baseProps));
  });

  it('serializes an explicit data payload over the props when provided', async () => {
    const data = { runs: [{ id: 'run-1', status: 'completed' }] };
    const html = await renderPage({
      title: 'Test',
      component: Fixture,
      props: baseProps,
      data,
    });

    expect(html).toContain('window.__INITIAL_DATA__ =');
    expect(html).toContain(JSON.stringify(data));
  });

  it('escapes < to prevent breaking out of the script tag (XSS)', async () => {
    const data = { value: '</script><script>alert(1)</script>' };
    const html = await renderPage({
      title: 'Test',
      component: Fixture,
      props: baseProps,
      data,
    });

    // The raw closing tag must not survive into the inline data script.
    expect(html).not.toContain('</script><script>alert(1)');
    expect(html).toContain('\\u003c/script');
  });

  it('escapes U+2028 and U+2029 line terminators', async () => {
    const lineSeparator = String.fromCharCode(0x2028);
    const paragraphSeparator = String.fromCharCode(0x2029);
    const data = { value: `line${lineSeparator}sep${paragraphSeparator}para` };
    const html = await renderPage({
      title: 'Test',
      component: Fixture,
      props: baseProps,
      data,
    });

    expect(html).not.toContain(lineSeparator);
    expect(html).not.toContain(paragraphSeparator);
    expect(html).toContain('\\u2028');
    expect(html).toContain('\\u2029');
  });

  it('includes the stylesheet link for a styled first paint', async () => {
    const html = await renderPage({ title: 'Test', component: Fixture, props: baseProps });

    expect(html).toContain('rel="stylesheet"');
    expect(html).toContain('/public/styles.css');
  });

  it('includes the hydration client module script', async () => {
    const html = await renderPage({ title: 'Test', component: Fixture, props: baseProps });

    expect(html).toContain('type="module"');
    expect(html).toContain('/public/entry.js');
  });
});
