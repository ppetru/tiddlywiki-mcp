// ABOUTME: Network settings and bearer token authentication for the HTTP transport
// ABOUTME: Reads MCP_HOST, MCP_ALLOWED_HOSTS and MCP_AUTH_TOKEN and builds the secured Express app

import { createHash, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import express from 'express';
import type { Express, NextFunction, Request, RequestHandler, Response } from 'express';
import { hostHeaderValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';

export const MIN_TOKEN_LENGTH = 32;

export interface HttpConfig {
  host: string;
  loopback: boolean; // every address MCP_HOST resolves to is a loopback address
  allowedHosts: string[] | null; // null = default for the host
  authToken: string | null;
}

/**
 * Read a variable; a value that is set but blank is an error, because it
 * usually means a template or secret lookup rendered empty.
 */
function readSetting(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  if (value === undefined) return undefined;
  if (value.trim() === '') {
    throw new Error(`${name} is set but empty. Unset it or give it a value.`);
  }
  return value.trim();
}

/**
 * Whether a MCP_ALLOWED_HOSTS entry can match a Host header hostname as the
 * SDK compares it (lowercase, no port, IPv6 in brackets).
 */
function isValidHostname(name: string): boolean {
  try {
    return new URL(`http://${name}/`).hostname === name;
  } catch {
    return false;
  }
}

/**
 * Build the HTTP settings from MCP_HOST, MCP_ALLOWED_HOSTS and MCP_AUTH_TOKEN.
 * Throws on values that would fail later or silently weaken protection.
 */
export async function loadHttpConfig(env: NodeJS.ProcessEnv): Promise<HttpConfig> {
  const host = readSetting(env, 'MCP_HOST') ?? '127.0.0.1';
  const authToken = readSetting(env, 'MCP_AUTH_TOKEN') ?? null;
  const allowedHosts = readSetting(env, 'MCP_ALLOWED_HOSTS')
    ?.split(',')
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name !== '');

  if (host.startsWith('[')) {
    throw new Error(`MCP_HOST must be an IPv6 address without brackets (e.g. ::1), not ${host}`);
  }
  if (authToken !== null && authToken.length < MIN_TOKEN_LENGTH) {
    throw new Error(
      `MCP_AUTH_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters (e.g. openssl rand -hex 32)`
    );
  }
  const invalid = (allowedHosts ?? []).filter((name) => !isValidHostname(name));
  if (invalid.length > 0) {
    throw new Error(
      `MCP_ALLOWED_HOSTS entries must be hostnames without port (IPv6 in brackets): ${invalid.join(', ')}`
    );
  }

  return {
    host,
    loopback: await resolvesToLoopback(host),
    allowedHosts: allowedHosts && allowedHosts.length > 0 ? allowedHosts : null,
    authToken,
  };
}

function isLoopbackAddress(address: string): boolean {
  const ipv4 = address.replace(/^::ffff:/i, '');
  if (isIP(ipv4) === 4) return ipv4.startsWith('127.');
  // The URL parser normalises IPv6, e.g. 0:0:0:0:0:0:0:1 to [::1]
  return isIP(address) === 6 && new URL(`http://[${address}]/`).hostname === '[::1]';
}

/**
 * Whether the host only accepts connections from this machine. Resolves the
 * name the same way `listen()` does, so `LOCALHOST`, `127.1` or
 * `::ffff:127.0.0.1` are recognised as well.
 */
export async function resolvesToLoopback(host: string): Promise<boolean> {
  try {
    const addresses = await lookup(host, { all: true });
    return addresses.length > 0 && addresses.every(({ address }) => isLoopbackAddress(address));
  } catch {
    return false; // listen() will report the error
  }
}

/**
 * Host header names accepted for requests, or null to accept any.
 * Loopback hosts get DNS rebinding protection by default: a website in a
 * local browser can point its own domain at 127.0.0.1, but cannot make the
 * browser send a localhost Host header.
 */
export function allowedHostnames(config: HttpConfig): string[] | null {
  if (config.allowedHosts) return config.allowedHosts;
  if (!config.loopback) return null;
  const hostname = isIP(config.host) === 6 ? `[${config.host}]` : config.host.toLowerCase();
  return [...new Set(['localhost', '127.0.0.1', '[::1]', hostname])];
}

/**
 * Startup warning for a configuration that exposes the wiki, or null.
 */
export function exposureWarning(config: HttpConfig): string | null {
  if (config.authToken || config.loopback) return null;
  return `Listening on ${config.host} without MCP_AUTH_TOKEN. Anyone who can reach this port can read and write the wiki, unless a proxy in front authenticates requests. Without MCP_ALLOWED_HOSTS, websites in a browser on a machine that can reach the port may use it too (DNS rebinding).`;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function rejectJsonRpc(res: Response, status: number, message: string): void {
  res.status(status).json({ jsonrpc: '2.0', error: { code: -32000, message }, id: null });
}

/**
 * Express middleware that requires `Authorization: Bearer <token>`.
 * Compares fixed-length digests in constant time, so neither the token
 * nor its length leaks through timing.
 */
export function bearerAuth(token: string): RequestHandler {
  const expected = digest(token);

  return (req: Request, res: Response, next: NextFunction) => {
    const match = /^Bearer +(.+)$/i.exec(req.headers.authorization ?? '');
    if (match && timingSafeEqual(digest(match[1]), expected)) {
      next();
      return;
    }
    res.set('WWW-Authenticate', 'Bearer');
    rejectJsonRpc(res, 401, 'Unauthorized');
  };
}

/**
 * Express middleware that rejects browser requests from foreign origins, as
 * the MCP spec requires. Requests without an Origin header (non-browser
 * clients) pass. An origin is accepted if its hostname is an allowed Host
 * name, or if it matches the request's own Host (same origin).
 */
export function originValidation(hostnames: string[] | null): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin === undefined) {
      next();
      return;
    }
    let originUrl: URL | null = null;
    try {
      originUrl = new URL(origin);
    } catch {
      // "null" (sandboxed iframes, file://) and malformed values are rejected
    }
    const allowed =
      originUrl !== null &&
      (hostnames ? hostnames.includes(originUrl.hostname) : originUrl.host === req.headers.host);
    if (allowed) {
      next();
      return;
    }
    rejectJsonRpc(res, 403, `Origin not allowed: ${origin}`);
  };
}

/**
 * Create the Express app with its middleware in order: Host and Origin
 * validation, token auth, then the body parser. Routes are added by the
 * caller, so they always run after these and unauthenticated requests are
 * rejected before their body is read. `/health` stays open; everything under
 * `/mcp` needs the token.
 */
export function createHttpApp(config: HttpConfig): Express {
  const app = express();
  const hostnames = allowedHostnames(config);
  if (hostnames) {
    app.use(hostHeaderValidation(hostnames));
  }
  app.use('/mcp', originValidation(hostnames));
  if (config.authToken) {
    app.use('/mcp', bearerAuth(config.authToken));
  }
  app.use(express.json());
  return app;
}
