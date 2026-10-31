// ABOUTME: Tests for HTTP transport settings and bearer token authentication
// ABOUTME: Covers env parsing, loopback detection, the middleware and the app factory wiring

import { describe, it, expect, vi, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Request, Response } from 'express';
import {
  allowedHostnames,
  bearerAuth,
  createHttpApp,
  exposureWarning,
  loadHttpConfig,
  resolvesToLoopback,
  type HttpConfig,
} from '../../src/http-auth.js';

const TOKEN = 'a'.repeat(64);

function runAuth(authorization?: string) {
  const req = { headers: authorization ? { authorization } : {} } as Request;
  const res = {
    status: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  const next = vi.fn();

  bearerAuth(TOKEN)(req, res as unknown as Response, next);

  return { res, next };
}

function config(overrides: Partial<HttpConfig>): HttpConfig {
  return { host: '127.0.0.1', loopback: true, allowedHosts: null, authToken: null, ...overrides };
}

describe('http-auth', () => {
  describe('loadHttpConfig', () => {
    it('should listen on 127.0.0.1 without auth by default', async () => {
      expect(await loadHttpConfig({})).toEqual({
        host: '127.0.0.1',
        loopback: true,
        allowedHosts: null,
        authToken: null,
      });
    });

    it('should read MCP_HOST, MCP_ALLOWED_HOSTS and MCP_AUTH_TOKEN', async () => {
      expect(
        await loadHttpConfig({
          MCP_HOST: '0.0.0.0',
          MCP_ALLOWED_HOSTS: 'Wiki.Example.com, localhost, [::1]',
          MCP_AUTH_TOKEN: TOKEN,
        })
      ).toEqual({
        host: '0.0.0.0',
        loopback: false,
        allowedHosts: ['wiki.example.com', 'localhost', '[::1]'],
        authToken: TOKEN,
      });
    });

    it.each(['MCP_AUTH_TOKEN', 'MCP_HOST', 'MCP_ALLOWED_HOSTS'])(
      'should reject %s that is set but blank',
      async (name) => {
        await expect(loadHttpConfig({ [name]: '  ' })).rejects.toThrow(/set but empty/);
      }
    );

    it('should reject tokens shorter than 32 characters', async () => {
      await expect(loadHttpConfig({ MCP_AUTH_TOKEN: 'secret' })).rejects.toThrow(/at least 32/);
    });

    it('should reject IPv6 hosts in brackets', async () => {
      await expect(loadHttpConfig({ MCP_HOST: '[::1]' })).rejects.toThrow(/without brackets/);
    });

    it.each(['wiki.example.com:443', '::1', 'http://wiki.example.com'])(
      'should reject the allowed host %s, which can never match',
      async (entry) => {
        await expect(loadHttpConfig({ MCP_ALLOWED_HOSTS: entry })).rejects.toThrow(
          /MCP_ALLOWED_HOSTS/
        );
      }
    );
  });

  describe('resolvesToLoopback', () => {
    it.each([
      '127.0.0.1',
      '127.0.0.2',
      '127.1',
      'localhost',
      'LOCALHOST',
      '::1',
      '0:0:0:0:0:0:0:1',
      '::ffff:127.0.0.1',
    ])('should treat %s as loopback', async (host) => {
      expect(await resolvesToLoopback(host)).toBe(true);
    });

    it.each(['0.0.0.0', '::', '192.168.1.10', '::ffff:192.168.1.10', 'no-such-host.invalid'])(
      'should not treat %s as loopback',
      async (host) => {
        expect(await resolvesToLoopback(host)).toBe(false);
      }
    );
  });

  describe('allowedHostnames', () => {
    it('should allow localhost names on loopback hosts', () => {
      expect(allowedHostnames(config({}))).toEqual(['localhost', '127.0.0.1', '[::1]']);
      expect(allowedHostnames(config({ host: '127.0.0.2' }))).toContain('127.0.0.2');
    });

    it('should not restrict non-loopback hosts by default', () => {
      expect(allowedHostnames(config({ host: '0.0.0.0', loopback: false }))).toBeNull();
    });

    it('should prefer MCP_ALLOWED_HOSTS', () => {
      expect(allowedHostnames(config({ allowedHosts: ['wiki.example.com'] }))).toEqual([
        'wiki.example.com',
      ]);
    });
  });

  describe('exposureWarning', () => {
    it('should warn only when listening beyond loopback without a token', () => {
      expect(exposureWarning(config({ host: '0.0.0.0', loopback: false }))).toMatch(
        /without MCP_AUTH_TOKEN/
      );
      expect(
        exposureWarning(config({ host: '0.0.0.0', loopback: false, authToken: TOKEN }))
      ).toBeNull();
      expect(exposureWarning(config({}))).toBeNull();
    });
  });

  describe('bearerAuth', () => {
    it('should pass requests with the right token', () => {
      const { res, next } = runAuth(`Bearer ${TOKEN}`);

      expect(next).toHaveBeenCalledOnce();
      expect(res.status).not.toHaveBeenCalled();
    });

    it.each([`bearer ${TOKEN}`, `Bearer  ${TOKEN}`])('should accept %s', (header) => {
      expect(runAuth(header).next).toHaveBeenCalledOnce();
    });

    it.each([
      ['no header', undefined],
      ['a wrong token', `Bearer ${'b'.repeat(64)}`],
      ['a shorter token', 'Bearer a'],
      ['another scheme', `Basic ${TOKEN}`],
    ])('should reject %s with 401', (_label, header) => {
      const { res, next } = runAuth(header);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.set).toHaveBeenCalledWith('WWW-Authenticate', 'Bearer');
    });
  });

  // The same factory the HTTP transport uses; routes are added afterwards,
  // as in startHttpTransport, so this covers the real middleware order.
  describe('createHttpApp (wiring)', () => {
    let server: http.Server | null = null;

    afterEach(async () => {
      await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
      server = null;
    });

    async function start(env: NodeJS.ProcessEnv): Promise<number> {
      const app = createHttpApp(await loadHttpConfig(env));
      app.get('/health', (_req, res) => {
        res.json({ status: 'healthy' });
      });
      app.all('/mcp', (_req, res) => {
        res.json({ ok: true });
      });
      server = app.listen(0, '127.0.0.1');
      await new Promise((resolve) => server!.once('listening', resolve));
      return (server!.address() as AddressInfo).port;
    }

    // node:http, because fetch does not allow setting the Host header
    function request(
      port: number,
      options: {
        method?: string;
        path?: string;
        host?: string;
        origin?: string;
        token?: string;
        body?: string;
      }
    ): Promise<number> {
      const method = options.method ?? 'POST';
      const body = method === 'POST' ? (options.body ?? '{}') : '';
      const headers: http.OutgoingHttpHeaders = {
        Host: options.host ?? `127.0.0.1:${port}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      };
      if (options.origin) headers.Origin = options.origin;
      if (options.token) headers.Authorization = `Bearer ${options.token}`;

      return new Promise((resolve, reject) => {
        const req = http.request(
          { port, method, path: options.path ?? '/mcp', headers, agent: false },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          }
        );
        req.on('error', reject);
        req.end(body);
      });
    }

    it('should reject foreign Host headers on loopback (DNS rebinding)', async () => {
      const port = await start({});

      expect(await request(port, {})).toBe(200);
      expect(await request(port, { host: `localhost:${port}` })).toBe(200);
      expect(await request(port, { host: `evil.example:${port}` })).toBe(403);
      expect(await request(port, { method: 'GET', path: '/health', host: 'evil.example' })).toBe(
        403
      );
    });

    it('should accept the names in MCP_ALLOWED_HOSTS (reverse proxy)', async () => {
      const port = await start({ MCP_ALLOWED_HOSTS: 'wiki.example.com' });

      expect(await request(port, { host: 'wiki.example.com' })).toBe(200);
      expect(await request(port, { host: 'evil.example' })).toBe(403);
    });

    it('should reject foreign origins (browser requests)', async () => {
      const port = await start({});

      expect(await request(port, { origin: 'http://evil.example' })).toBe(403);
      expect(await request(port, { origin: 'null' })).toBe(403);
      expect(await request(port, { origin: 'http://localhost:6274' })).toBe(200);
    });

    it('should accept same-origin requests when any Host is allowed', async () => {
      const port = await start({ MCP_HOST: '0.0.0.0', MCP_AUTH_TOKEN: TOKEN });

      expect(await request(port, { origin: `http://127.0.0.1:${port}`, token: TOKEN })).toBe(200);
      expect(await request(port, { origin: 'http://evil.example', token: TOKEN })).toBe(403);
    });

    it('should require the token on every /mcp variant but not on /health', async () => {
      const port = await start({ MCP_AUTH_TOKEN: TOKEN });

      for (const [method, path] of [
        ['POST', '/mcp'],
        ['GET', '/mcp'],
        ['DELETE', '/mcp'],
        ['POST', '/mcp/'],
        ['POST', '/MCP'],
      ]) {
        expect(await request(port, { method, path }), `${method} ${path}`).toBe(401);
      }
      expect(await request(port, { token: TOKEN })).toBe(200);
      expect(await request(port, { method: 'GET', path: '/health' })).toBe(200);
    });

    it('should reject unauthenticated requests before parsing the body', async () => {
      const port = await start({ MCP_AUTH_TOKEN: TOKEN });

      // Malformed JSON would be a 400 from the body parser if it ran first
      expect(await request(port, { body: '{not json' })).toBe(401);
    });
  });
});
