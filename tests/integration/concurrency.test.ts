// ABOUTME: Integration tests for MCP server concurrency.
// ABOUTME: Verifies that multiple concurrent sessions don't cause hangs.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';

// Test configuration
const SERVER_URL = process.env.MCP_TEST_URL || 'http://127.0.0.1:3000';
const REQUEST_TIMEOUT = 10000; // 10 seconds per request
const CONCURRENT_SESSIONS = 3;

interface MCPRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface MCPResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
}

/**
 * Create a new MCP session and return the session ID
 */
async function createSession(): Promise<string> {
  const initRequest: MCPRequest = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'concurrency-test',
        version: '1.0.0',
      },
    },
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    const response = await fetch(`${SERVER_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(initRequest),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Init failed: ${response.status} ${response.statusText}`);
    }

    const sessionId = response.headers.get('mcp-session-id');
    if (!sessionId) {
      throw new Error('No session ID returned');
    }

    return sessionId;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Session creation timed out after ${REQUEST_TIMEOUT}ms`);
    }
    throw error;
  }
}

/**
 * Call a tool on an existing session
 */
async function callTool(
  sessionId: string,
  toolName: string,
  args: Record<string, unknown>,
  requestId: number = 2
): Promise<MCPResponse> {
  const request: MCPRequest = {
    jsonrpc: '2.0',
    id: requestId,
    method: 'tools/call',
    params: {
      name: toolName,
      arguments: args,
    },
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    const response = await fetch(`${SERVER_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'mcp-session-id': sessionId,
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Tool call failed: ${response.status} ${response.statusText}`);
    }

    return (await response.json()) as MCPResponse;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Tool call timed out after ${REQUEST_TIMEOUT}ms`);
    }
    throw error;
  }
}

/**
 * Check if the server is reachable
 */
async function isServerRunning(): Promise<boolean> {
  try {
    const response = await fetch(`${SERVER_URL}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

describe('MCP Server Concurrency', () => {
  beforeAll(async () => {
    const running = await isServerRunning();
    if (!running) {
      console.warn(`
⚠️  MCP server not running at ${SERVER_URL}
    To run these tests, start the server first:
    cd /data/services/tiddlywiki-mcp && npm run build && node dist/index.js

    Or set MCP_TEST_URL environment variable to point to a running server.
`);
    }
  });

  it('should be reachable', async () => {
    const running = await isServerRunning();
    if (!running) {
      console.log('Skipping: server not running');
      return;
    }
    expect(running).toBe(true);
  });

  it('should handle multiple sequential sessions', async () => {
    const running = await isServerRunning();
    if (!running) {
      console.log('Skipping: server not running');
      return;
    }

    // Create sessions sequentially (should always work)
    const sessions: string[] = [];
    for (let i = 0; i < CONCURRENT_SESSIONS; i++) {
      const sessionId = await createSession();
      sessions.push(sessionId);
      console.log(`Created session ${i + 1}: ${sessionId}`);
    }

    expect(sessions).toHaveLength(CONCURRENT_SESSIONS);

    // Make tool calls sequentially
    for (let i = 0; i < sessions.length; i++) {
      const result = await callTool(sessions[i], 'search_tiddlers', {
        filter: '[limit[1]]',
      });
      console.log(`Session ${i + 1} tool call: ${result.error ? 'error' : 'success'}`);
      expect(result.error).toBeUndefined();
    }
  });

  it('should handle concurrent session creation', async () => {
    const running = await isServerRunning();
    if (!running) {
      console.log('Skipping: server not running');
      return;
    }

    console.log(`Creating ${CONCURRENT_SESSIONS} sessions concurrently...`);
    const startTime = Date.now();

    // Create all sessions concurrently - this is where hangs occur
    const sessionPromises = Array.from({ length: CONCURRENT_SESSIONS }, (_, i) =>
      createSession().then((sid) => {
        console.log(`Session ${i + 1} created: ${sid} (${Date.now() - startTime}ms)`);
        return sid;
      })
    );

    const sessions = await Promise.all(sessionPromises);
    const elapsed = Date.now() - startTime;

    console.log(`All ${CONCURRENT_SESSIONS} sessions created in ${elapsed}ms`);

    expect(sessions).toHaveLength(CONCURRENT_SESSIONS);
    expect(elapsed).toBeLessThan(REQUEST_TIMEOUT * CONCURRENT_SESSIONS);
  });

  it('should handle concurrent tool calls from different sessions', async () => {
    const running = await isServerRunning();
    if (!running) {
      console.log('Skipping: server not running');
      return;
    }

    // First create sessions (sequentially to isolate the concurrent call issue)
    const sessions: string[] = [];
    for (let i = 0; i < CONCURRENT_SESSIONS; i++) {
      sessions.push(await createSession());
    }

    console.log(`Making concurrent tool calls from ${CONCURRENT_SESSIONS} sessions...`);
    const startTime = Date.now();

    // Now make concurrent tool calls - this is where request ID collisions occur
    const callPromises = sessions.map((sessionId, i) =>
      callTool(sessionId, 'search_tiddlers', { filter: '[limit[1]]' }, i + 10).then((result) => {
        console.log(
          `Session ${i + 1} call complete: ${result.error ? 'error' : 'success'} (${Date.now() - startTime}ms)`
        );
        return result;
      })
    );

    const results = await Promise.all(callPromises);
    const elapsed = Date.now() - startTime;

    console.log(`All ${CONCURRENT_SESSIONS} tool calls completed in ${elapsed}ms`);

    expect(results).toHaveLength(CONCURRENT_SESSIONS);
    results.forEach((result, i) => {
      expect(result.error).toBeUndefined();
    });
    expect(elapsed).toBeLessThan(REQUEST_TIMEOUT);
  });

  it('should handle rapid sequential requests on the same session', async () => {
    const running = await isServerRunning();
    if (!running) {
      console.log('Skipping: server not running');
      return;
    }

    const sessionId = await createSession();
    console.log(`Testing rapid requests on session ${sessionId}...`);

    const startTime = Date.now();

    // Make 5 sequential requests rapidly
    for (let i = 0; i < 5; i++) {
      const result = await callTool(sessionId, 'search_tiddlers', { filter: '[limit[1]]' }, 100 + i);
      expect(result.error).toBeUndefined();
    }

    const elapsed = Date.now() - startTime;
    console.log(`5 rapid requests completed in ${elapsed}ms`);

    // Should complete in reasonable time (not hang)
    expect(elapsed).toBeLessThan(REQUEST_TIMEOUT);
  });

  it('should not hang when mixing session creation and tool calls', async () => {
    const running = await isServerRunning();
    if (!running) {
      console.log('Skipping: server not running');
      return;
    }

    console.log('Testing interleaved session creation and tool calls...');
    const startTime = Date.now();

    // Interleave session creation and tool calls
    const session1 = await createSession();
    const result1 = await callTool(session1, 'search_tiddlers', { filter: '[limit[1]]' }, 200);

    const session2 = await createSession();

    // Now make concurrent calls from both sessions while creating a third
    const promises = [
      callTool(session1, 'search_tiddlers', { filter: '[limit[1]]' }, 201),
      callTool(session2, 'search_tiddlers', { filter: '[limit[1]]' }, 202),
      createSession(),
    ];

    const results = await Promise.all(promises);
    const elapsed = Date.now() - startTime;

    console.log(`Interleaved operations completed in ${elapsed}ms`);

    expect(results).toHaveLength(3);
    expect(elapsed).toBeLessThan(REQUEST_TIMEOUT * 2);
  });
});
