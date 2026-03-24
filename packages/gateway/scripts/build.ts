import { $ } from 'bun';

await $`rm -rf dist`;

// Server build
const serverResult = await Bun.build({
  entrypoints: ['./src/index.ts'],
  outdir: './dist',
  root: './src',
  target: 'bun',
  format: 'esm',
  naming: '[dir]/[name].js',
  sourcemap: 'external',
  minify: true,
  external: [
    'hono',
    'hono/*',
    'react',
    'react-dom',
    'react-dom/*',
    'operative',
    'sentinel',
    'herald',
    'armorer',
    'conversationalist',
  ],
});

if (!serverResult.success) {
  console.error('Server build failed:', serverResult.logs);
  process.exit(1);
}

// Client build
const clientResult = await Bun.build({
  entrypoints: ['./src/client/entry.tsx'],
  outdir: './dist/public',
  target: 'browser',
  format: 'esm',
  splitting: true,
  naming: '[name]-[hash].[ext]',
  sourcemap: 'external',
  minify: true,
});

if (!clientResult.success) {
  console.error('Client build failed:', clientResult.logs);
  process.exit(1);
}

// Write manifest mapping logical names to hashed filenames
const manifest: Record<string, string> = {};
for (const output of clientResult.outputs) {
  const filename = output.path.split('/').pop()!;
  const logical = filename.replace(/-[a-f0-9]+\./, '.');
  manifest[logical] = `/public/${filename}`;
}

await Bun.write('./dist/manifest.json', JSON.stringify(manifest, null, 2));

// Copy CSS files to public directory (sorted for deterministic output)
const cssGlob = new Bun.Glob('src/ui/styles/*.css');
const cssPaths: string[] = [];
for await (const path of cssGlob.scan('.')) {
  cssPaths.push(path);
}
cssPaths.sort();
let cssBundle = '';
for (const path of cssPaths) {
  cssBundle += await Bun.file(path).text();
  cssBundle += '\n';
}
await Bun.write('./dist/public/styles.css', cssBundle);

console.log('Build complete!');
console.log('  Server:', serverResult.outputs.length, 'files');
console.log('  Client:', clientResult.outputs.length, 'files');
console.log('  Manifest:', Object.keys(manifest).length, 'entries');
