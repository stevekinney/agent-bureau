import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_ROOT = path.join(ROOT, 'src');

const FORBIDDEN_CORE_PACKAGES = [
  '@modelcontextprotocol/sdk',
  '@anthropic-ai/claude-agent-sdk',
  '@openai/agents',
  'openai',
  '@anthropic-ai/sdk',
  '@google/generative-ai',
  '@google/genai',
];

const FORBIDDEN_CORE_PATHS = ['adapters', 'integrations', 'mcp'];
const FORBIDDEN_ADAPTER_PATHS = ['utilities'];

const IMPORT_RE = /(?:import|export)\s+(?:[^'"()]*?from\s+)?['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT_RE = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
const REQUIRE_RE = /require\(\s*['"]([^'"]+)['"]\s*\)/g;

const violations: string[] = [];

for (const file of listFiles(SRC_ROOT)) {
  if (!file.endsWith('.ts')) continue;
  if (file.endsWith('.d.ts')) continue;
  if (file.endsWith('.test.ts') || file.endsWith('.spec.ts')) continue;

  const relPath = path.relative(ROOT, file);
  const text = readFileSync(file, 'utf8');
  const specs = collectImports(text);

  if (isUnder(relPath, 'src/core')) {
    for (const spec of specs) {
      const reason = checkCoreImport(file, spec);
      if (reason) {
        violations.push(`${relPath}:${reason}`);
      }
    }
  }

  if (isUnder(relPath, 'src/adapters')) {
    for (const spec of specs) {
      const reason = checkAdapterImport(file, spec);
      if (reason) {
        violations.push(`${relPath}:${reason}`);
      }
    }
  }
}

if (violations.length) {
  console.error('Boundary check failed:');
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log('Boundary check passed.');

function listFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      files.push(...listFiles(full));
    } else {
      files.push(full);
    }
  }
  return files;
}

function collectImports(text: string): string[] {
  return [
    ...collect(text, IMPORT_RE),
    ...collect(text, DYNAMIC_IMPORT_RE),
    ...collect(text, REQUIRE_RE),
  ];
}

function collect(text: string, re: RegExp): string[] {
  const result: string[] = [];
  for (const match of text.matchAll(re)) {
    const spec = match[1];
    if (spec) result.push(spec);
  }
  return result;
}

function checkCoreImport(file: string, spec: string): string | null {
  if (isRelative(spec)) {
    const resolved = resolveImport(file, spec);
    for (const forbidden of FORBIDDEN_CORE_PATHS) {
      const needle = `${path.sep}src${path.sep}${forbidden}${path.sep}`;
      if (resolved.includes(needle)) {
        return ` forbidden import from ${spec}`;
      }
    }
    return null;
  }

  for (const forbidden of FORBIDDEN_CORE_PACKAGES) {
    if (spec === forbidden || spec.startsWith(`${forbidden}/`)) {
      return ` forbidden package import ${spec}`;
    }
  }

  return null;
}

function checkAdapterImport(file: string, spec: string): string | null {
  if (spec === 'armorer/utilities' || spec.startsWith('armorer/utilities/')) {
    return ` forbidden import from ${spec}`;
  }
  if (!isRelative(spec)) return null;

  const resolved = resolveImport(file, spec);
  for (const forbidden of FORBIDDEN_ADAPTER_PATHS) {
    const needle = `${path.sep}src${path.sep}${forbidden}${path.sep}`;
    if (resolved.includes(needle)) {
      return ` forbidden import from ${spec}`;
    }
  }
  return null;
}

function isRelative(spec: string): boolean {
  return spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('..');
}

function resolveImport(file: string, spec: string): string {
  const base = path.dirname(file);
  const resolved = path.resolve(base, spec);
  return resolved;
}

function isUnder(value: string, prefix: string): boolean {
  const normalized = value.split(path.sep).join('/');
  return normalized.startsWith(prefix.replace(/\\/g, '/'));
}
