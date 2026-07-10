import { generateKeyPairSync, sign as signEd25519 } from 'node:crypto';

import { describe, expect, it } from 'bun:test';
import { sha256HexSync } from 'interoperability';

import { fetchFromRegistry } from '../../src/ingestion/fetch-from-registry';
import { createMockSkillProvider } from '../../src/test/index';

const VALID_SKILL_MD = `---
name: test-skill
description: A test skill from the registry
---

## Instructions

Do something useful.
`;

function makeSkillMarkdown(name: string, description = `Description for ${name}`): string {
  return `---
name: ${name}
description: ${description}
---

## Instructions for ${name}

Do something useful.
`;
}

interface RecordedRequest {
  url: string;
  authorization: string | null;
}

function createMockFetch(
  responses: Record<string, { status: number; body: string } | 'network-error'>,
  requests: RecordedRequest[] = [],
): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    const headers = new Headers(init?.headers);
    requests.push({ url, authorization: headers.get('Authorization') });

    const response = responses[url];

    if (response === 'network-error') {
      throw new Error('Network error: connection refused');
    }

    if (response) {
      return new Response(response.body, {
        status: response.status,
        statusText: response.status === 200 ? 'OK' : 'Not Found',
      });
    }

    return new Response('Not Found', { status: 404, statusText: 'Not Found' });
  };
}

/** Generates an Ed25519 key pair as SPKI/PKCS8 PEM strings, for signature tests. */
function generateEd25519KeyPair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

/** Signs `content` with an Ed25519 private key (PKCS8 PEM), returning a base64 detached signature. */
function signContent(content: string, privateKeyPem: string): string {
  return signEd25519(null, Buffer.from(content), privateKeyPem).toString('base64');
}

describe('fetchFromRegistry', () => {
  const baseUrl = 'https://registry.example.com/skills';

  it('fetches a skill and writes it to the provider', async () => {
    const provider = createMockSkillProvider();
    const fetchFunction = createMockFetch({
      [`${baseUrl}/test-skill/SKILL.md`]: { status: 200, body: VALID_SKILL_MD },
    });

    const result = await fetchFromRegistry({
      baseUrl,
      names: ['test-skill'],
      provider,
      fetchFunction,
      allowUnverified: true,
    });

    expect(result.loaded).toEqual(['test-skill']);
    expect(result.errors).toHaveLength(0);

    const saved = provider.calls.filter((call) => call.method === 'saveSkill');
    expect(saved).toHaveLength(1);
    expect(saved[0]?.args[0]).toBe('test-skill');
  });

  it('handles network errors gracefully', async () => {
    const provider = createMockSkillProvider();
    const fetchFunction = createMockFetch({
      [`${baseUrl}/broken-skill/SKILL.md`]: 'network-error',
    });

    const result = await fetchFromRegistry({
      baseUrl,
      names: ['broken-skill'],
      provider,
      fetchFunction,
      allowUnverified: true,
    });

    expect(result.loaded).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.name).toBe('broken-skill');
    expect(result.errors[0]?.error).toContain('Network error');
  });

  it('returns a clear error for 404 responses', async () => {
    const provider = createMockSkillProvider();
    const fetchFunction = createMockFetch({
      [`${baseUrl}/missing-skill/SKILL.md`]: { status: 404, body: 'Not Found' },
    });

    const result = await fetchFromRegistry({
      baseUrl,
      names: ['missing-skill'],
      provider,
      fetchFunction,
      allowUnverified: true,
    });

    expect(result.loaded).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.name).toBe('missing-skill');
    expect(result.errors[0]?.error).toContain('404');
  });

  it('fetches multiple skills in one call', async () => {
    const provider = createMockSkillProvider();
    const fetchFunction = createMockFetch({
      [`${baseUrl}/alpha/SKILL.md`]: { status: 200, body: makeSkillMarkdown('alpha') },
      [`${baseUrl}/beta/SKILL.md`]: { status: 200, body: makeSkillMarkdown('beta') },
      [`${baseUrl}/gamma/SKILL.md`]: { status: 200, body: makeSkillMarkdown('gamma') },
    });

    const result = await fetchFromRegistry({
      baseUrl,
      names: ['alpha', 'beta', 'gamma'],
      provider,
      fetchFunction,
      allowUnverified: true,
    });

    expect(result.loaded.sort()).toEqual(['alpha', 'beta', 'gamma']);
    expect(result.errors).toHaveLength(0);

    const saved = provider.calls.filter((call) => call.method === 'saveSkill');
    expect(saved).toHaveLength(3);
  });

  it('handles partial failure with both loaded and errors', async () => {
    const provider = createMockSkillProvider();
    const fetchFunction = createMockFetch({
      [`${baseUrl}/good-skill/SKILL.md`]: { status: 200, body: makeSkillMarkdown('good-skill') },
      [`${baseUrl}/bad-skill/SKILL.md`]: { status: 404, body: 'Not Found' },
      [`${baseUrl}/error-skill/SKILL.md`]: 'network-error',
    });

    const result = await fetchFromRegistry({
      baseUrl,
      names: ['good-skill', 'bad-skill', 'error-skill'],
      provider,
      fetchFunction,
      allowUnverified: true,
    });

    expect(result.loaded).toEqual(['good-skill']);
    expect(result.errors).toHaveLength(2);

    const errorNames = result.errors.map((error) => error.name).sort();
    expect(errorNames).toEqual(['bad-skill', 'error-skill']);
  });

  it('adds malformed response to errors', async () => {
    const provider = createMockSkillProvider();
    const fetchFunction = createMockFetch({
      [`${baseUrl}/malformed/SKILL.md`]: {
        status: 200,
        body: '---\nnot-valid: true\n---\n\nNo name or description.',
      },
    });

    const result = await fetchFromRegistry({
      baseUrl,
      names: ['malformed'],
      provider,
      fetchFunction,
      allowUnverified: true,
    });

    expect(result.loaded).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.name).toBe('malformed');
    expect(result.errors[0]?.error).toBeTruthy();
  });
});

describe('fetchFromRegistry integrity', () => {
  const baseUrl = 'https://registry.example.com/skills';

  it('sends the bearer token as an Authorization header on both the skill and signature requests', async () => {
    const provider = createMockSkillProvider();
    const requests: RecordedRequest[] = [];
    const { publicKey, privateKey } = generateEd25519KeyPair();
    const signature = signContent(VALID_SKILL_MD, privateKey);
    const fetchFunction = createMockFetch(
      {
        [`${baseUrl}/test-skill/SKILL.md`]: { status: 200, body: VALID_SKILL_MD },
        [`${baseUrl}/test-skill/SKILL.md.sig`]: { status: 200, body: signature },
      },
      requests,
    );

    await fetchFromRegistry({
      baseUrl,
      names: ['test-skill'],
      provider,
      fetchFunction,
      authToken: 'super-secret-token',
      publicKey,
    });

    const skillRequest = requests.find(
      (request) => request.url === `${baseUrl}/test-skill/SKILL.md`,
    );
    const signatureRequest = requests.find(
      (request) => request.url === `${baseUrl}/test-skill/SKILL.md.sig`,
    );
    expect(skillRequest?.authorization).toBe('Bearer super-secret-token');
    expect(signatureRequest?.authorization).toBe('Bearer super-secret-token');
  });

  it('rejects unsigned, unpinned content by default', async () => {
    const provider = createMockSkillProvider();
    const fetchFunction = createMockFetch({
      [`${baseUrl}/test-skill/SKILL.md`]: { status: 200, body: VALID_SKILL_MD },
    });

    const result = await fetchFromRegistry({
      baseUrl,
      names: ['test-skill'],
      provider,
      fetchFunction,
    });

    expect(result.loaded).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.error).toContain('unverified');

    const saved = provider.calls.filter((call) => call.method === 'saveSkill');
    expect(saved).toHaveLength(0);
  });

  it('allows unsigned, unpinned content when allowUnverified is set', async () => {
    const provider = createMockSkillProvider();
    const fetchFunction = createMockFetch({
      [`${baseUrl}/test-skill/SKILL.md`]: { status: 200, body: VALID_SKILL_MD },
    });

    const result = await fetchFromRegistry({
      baseUrl,
      names: ['test-skill'],
      provider,
      fetchFunction,
      allowUnverified: true,
    });

    expect(result.loaded).toEqual(['test-skill']);
    expect(result.errors).toHaveLength(0);
  });

  it('accepts content whose hash matches the pinned expectedHash', async () => {
    const provider = createMockSkillProvider();
    const fetchFunction = createMockFetch({
      [`${baseUrl}/test-skill/SKILL.md`]: { status: 200, body: VALID_SKILL_MD },
    });

    const result = await fetchFromRegistry({
      baseUrl,
      names: ['test-skill'],
      provider,
      fetchFunction,
      expectedHashes: { 'test-skill': sha256HexSync(VALID_SKILL_MD) },
    });

    expect(result.loaded).toEqual(['test-skill']);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects tampered content that does not match the pinned hash (neuter-verified)', async () => {
    const provider = createMockSkillProvider();
    const tamperedBody = VALID_SKILL_MD.replace('Do something useful.', 'Do something malicious.');
    const fetchFunction = createMockFetch({
      [`${baseUrl}/test-skill/SKILL.md`]: { status: 200, body: tamperedBody },
    });

    const result = await fetchFromRegistry({
      baseUrl,
      names: ['test-skill'],
      provider,
      fetchFunction,
      // Pinned to the hash of the ORIGINAL content — the registry served something else.
      expectedHashes: { 'test-skill': sha256HexSync(VALID_SKILL_MD) },
      // Even with the opt-out set, a hash mismatch must still be rejected.
      allowUnverified: true,
    });

    expect(result.loaded).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.error).toContain('hash mismatch');

    const saved = provider.calls.filter((call) => call.method === 'saveSkill');
    expect(saved).toHaveLength(0);

    // Neuter check: if the hash-mismatch guard were removed, this same tampered
    // content would be accepted instead — proving the assertions above actually
    // exercise the guard rather than something incidental.
    const unguardedResult = await fetchFromRegistry({
      baseUrl,
      names: ['test-skill'],
      provider,
      fetchFunction,
      allowUnverified: true,
    });
    expect(unguardedResult.loaded).toEqual(['test-skill']);
  });

  it('accepts content with a valid detached signature', async () => {
    const provider = createMockSkillProvider();
    const { publicKey, privateKey } = generateEd25519KeyPair();
    const signature = signContent(VALID_SKILL_MD, privateKey);

    const fetchFunction = createMockFetch({
      [`${baseUrl}/test-skill/SKILL.md`]: { status: 200, body: VALID_SKILL_MD },
      [`${baseUrl}/test-skill/SKILL.md.sig`]: { status: 200, body: signature },
    });

    const result = await fetchFromRegistry({
      baseUrl,
      names: ['test-skill'],
      provider,
      fetchFunction,
      publicKey,
    });

    expect(result.loaded).toEqual(['test-skill']);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects content with an invalid detached signature, even with allowUnverified set', async () => {
    const provider = createMockSkillProvider();
    const { publicKey } = generateEd25519KeyPair();
    const { privateKey: wrongPrivateKey } = generateEd25519KeyPair();
    const signature = signContent(VALID_SKILL_MD, wrongPrivateKey);

    const fetchFunction = createMockFetch({
      [`${baseUrl}/test-skill/SKILL.md`]: { status: 200, body: VALID_SKILL_MD },
      [`${baseUrl}/test-skill/SKILL.md.sig`]: { status: 200, body: signature },
    });

    const result = await fetchFromRegistry({
      baseUrl,
      names: ['test-skill'],
      provider,
      fetchFunction,
      publicKey,
      allowUnverified: true,
    });

    expect(result.loaded).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.error).toContain('Signature verification failed');
  });

  it('rejects when publicKey is configured but no signature is served', async () => {
    const provider = createMockSkillProvider();
    const { publicKey } = generateEd25519KeyPair();

    const fetchFunction = createMockFetch({
      [`${baseUrl}/test-skill/SKILL.md`]: { status: 200, body: VALID_SKILL_MD },
    });

    const result = await fetchFromRegistry({
      baseUrl,
      names: ['test-skill'],
      provider,
      fetchFunction,
      publicKey,
    });

    expect(result.loaded).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.error).toContain('unverified');
  });

  it('allows a missing signature when opted out, even with publicKey configured', async () => {
    const provider = createMockSkillProvider();
    const { publicKey } = generateEd25519KeyPair();

    const fetchFunction = createMockFetch({
      [`${baseUrl}/test-skill/SKILL.md`]: { status: 200, body: VALID_SKILL_MD },
    });

    const result = await fetchFromRegistry({
      baseUrl,
      names: ['test-skill'],
      provider,
      fetchFunction,
      publicKey,
      allowUnverified: true,
    });

    expect(result.loaded).toEqual(['test-skill']);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects content whose metadata name does not match the requested skill name', async () => {
    const provider = createMockSkillProvider();
    const mismatchedBody = makeSkillMarkdown('a-different-skill');
    const fetchFunction = createMockFetch({
      [`${baseUrl}/test-skill/SKILL.md`]: { status: 200, body: mismatchedBody },
    });

    const result = await fetchFromRegistry({
      baseUrl,
      names: ['test-skill'],
      provider,
      fetchFunction,
      allowUnverified: true,
    });

    expect(result.loaded).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.error).toContain('mismatched');

    const saved = provider.calls.filter((call) => call.method === 'saveSkill');
    expect(saved).toHaveLength(0);
  });
});
