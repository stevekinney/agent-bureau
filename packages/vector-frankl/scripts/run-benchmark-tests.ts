import { $ } from 'bun';

const benchmarkGlob = new Bun.Glob('**/*.benchmark.test.ts');
const benchmarkPaths: string[] = [];

for await (const path of benchmarkGlob.scan('.')) {
  benchmarkPaths.push(`./${path}`);
}

benchmarkPaths.sort();

if (benchmarkPaths.length === 0) {
  console.error('No benchmark tests found.');
  process.exit(1);
}

await $`bun test --timeout 120000 ${benchmarkPaths}`;
