import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';

import { createSecurityHeaders } from './security-headers';

function buildApp(options?: Parameters<typeof createSecurityHeaders>[0]) {
  const app = new Hono();
  app.use('*', createSecurityHeaders(options));
  app.get('/ping', (c) => c.text('pong'));
  app.get('/ws', (c) => c.text('upgraded'));
  return app;
}

describe('createSecurityHeaders', () => {
  describe('response headers', () => {
    it('sets x-content-type-options nosniff', async () => {
      const app = buildApp();
      const res = await app.request('/ping');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    });

    it('sets x-frame-options DENY', async () => {
      const app = buildApp();
      const res = await app.request('/ping');
      expect(res.headers.get('x-frame-options')).toBe('DENY');
    });

    it('sets referrer-policy', async () => {
      const app = buildApp();
      const res = await app.request('/ping');
      expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    });

    it('emits CSP by default', async () => {
      const app = buildApp();
      const res = await app.request('/ping');
      expect(res.headers.get('content-security-policy')).toBeTruthy();
    });

    it('suppresses CSP when enableCsp is false', async () => {
      const app = buildApp({ enableCsp: false });
      const res = await app.request('/ping');
      expect(res.headers.get('content-security-policy')).toBeNull();
    });
  });

  describe('WebSocket origin check', () => {
    it('allows any origin when allowedOrigins is empty', async () => {
      const app = buildApp({ allowedOrigins: [] });
      const res = await app.request('/ws', {
        headers: { upgrade: 'websocket', origin: 'http://evil.example' },
      });
      expect(res.status).not.toBe(403);
    });

    it('allows a matching origin', async () => {
      const app = buildApp({ allowedOrigins: ['http://app.example'] });
      const res = await app.request('/ws', {
        headers: { upgrade: 'websocket', connection: 'Upgrade', origin: 'http://app.example' },
      });
      expect(res.status).not.toBe(403);
    });

    it('rejects an unknown origin on upgrade', async () => {
      const app = buildApp({ allowedOrigins: ['http://app.example'] });
      const res = await app.request('/ws', {
        headers: { upgrade: 'websocket', connection: 'Upgrade', origin: 'http://evil.example' },
      });
      expect(res.status).toBe(403);
    });

    it('rejects a missing origin on upgrade when origins are configured', async () => {
      const app = buildApp({ allowedOrigins: ['http://app.example'] });
      const res = await app.request('/ws', {
        headers: { upgrade: 'websocket', connection: 'Upgrade' },
      });
      expect(res.status).toBe(403);
    });

    it('does not check origin on non-upgrade requests', async () => {
      const app = buildApp({ allowedOrigins: ['http://app.example'] });
      const res = await app.request('/ping', {
        headers: { origin: 'http://evil.example' },
      });
      expect(res.status).not.toBe(403);
    });
  });

  describe('SSRF guard', () => {
    it('blocks localhost targets', async () => {
      const app = buildApp();
      const res = await app.request('/ping', {
        headers: { 'x-agent-target-url': 'http://localhost/secret' },
      });
      expect(res.status).toBe(403);
    });

    it('blocks 127.x loopback targets', async () => {
      const app = buildApp();
      const res = await app.request('/ping', {
        headers: { 'x-agent-target-url': 'http://127.0.0.1/secret' },
      });
      expect(res.status).toBe(403);
    });

    it('blocks RFC-1918 10.x targets', async () => {
      const app = buildApp();
      const res = await app.request('/ping', {
        headers: { 'x-agent-target-url': 'http://10.0.0.1/internal' },
      });
      expect(res.status).toBe(403);
    });

    it('blocks RFC-1918 192.168.x targets', async () => {
      const app = buildApp();
      const res = await app.request('/ping', {
        headers: { 'x-agent-target-url': 'http://192.168.1.1/router' },
      });
      expect(res.status).toBe(403);
    });

    it('blocks RFC-1918 172.16–31 targets', async () => {
      const app = buildApp();
      const res = await app.request('/ping', {
        headers: { 'x-agent-target-url': 'http://172.16.0.1/internal' },
      });
      expect(res.status).toBe(403);
    });

    it('allows public internet targets', async () => {
      const app = buildApp();
      const res = await app.request('/ping', {
        headers: { 'x-agent-target-url': 'https://api.example.com/data' },
      });
      expect(res.status).not.toBe(403);
    });

    it('blocks unparsable target URLs', async () => {
      const app = buildApp();
      const res = await app.request('/ping', {
        headers: { 'x-agent-target-url': 'not-a-url' },
      });
      expect(res.status).toBe(403);
    });

    it('passes through when no x-agent-target-url is present', async () => {
      const app = buildApp();
      const res = await app.request('/ping');
      expect(res.status).not.toBe(403);
    });

    // Regression: prefix string matching wrongly blocked public hostnames whose
    // names start with private-range octets (e.g. "10.example.com"). The guard
    // must check actual IPv4 octets, not hostname string prefixes.
    it('allows a public hostname that starts with 10.', async () => {
      const app = buildApp();
      const res = await app.request('/ping', {
        headers: { 'x-agent-target-url': 'https://10.example.com/api' },
      });
      expect(res.status).not.toBe(403);
    });

    it('allows a public hostname that starts with 127.', async () => {
      const app = buildApp();
      const res = await app.request('/ping', {
        headers: { 'x-agent-target-url': 'https://127.example.com/api' },
      });
      expect(res.status).not.toBe(403);
    });

    it('allows a public hostname that starts with 192.168.', async () => {
      const app = buildApp();
      const res = await app.request('/ping', {
        headers: { 'x-agent-target-url': 'https://192.168.example.com/api' },
      });
      expect(res.status).not.toBe(403);
    });

    it('allows a public hostname that starts with 172.16.', async () => {
      const app = buildApp();
      const res = await app.request('/ping', {
        headers: { 'x-agent-target-url': 'https://172.16.example.com/api' },
      });
      expect(res.status).not.toBe(403);
    });

    it('still blocks the actual 10.0.0.1 private IP', async () => {
      const app = buildApp();
      const res = await app.request('/ping', {
        headers: { 'x-agent-target-url': 'http://10.0.0.1/internal' },
      });
      expect(res.status).toBe(403);
    });

    it('still blocks the actual 127.0.0.1 loopback IP', async () => {
      const app = buildApp();
      const res = await app.request('/ping', {
        headers: { 'x-agent-target-url': 'http://127.0.0.1/secret' },
      });
      expect(res.status).toBe(403);
    });

    it('still blocks the cloud IMDS address 169.254.169.254', async () => {
      const app = buildApp();
      const res = await app.request('/ping', {
        headers: { 'x-agent-target-url': 'http://169.254.169.254/latest/meta-data' },
      });
      expect(res.status).toBe(403);
    });
  });
});
