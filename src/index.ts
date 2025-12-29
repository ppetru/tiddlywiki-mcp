#!/usr/bin/env node
// ABOUTME: TiddlyWiki MCP Server - main entry point
// ABOUTME: Handles stdio and HTTP transports, server lifecycle, and tool routing

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import express from 'express';
import type { Request, Response } from 'express';
import { initTiddlyWiki } from './tiddlywiki-http.js';
import { getFilterReference } from './filter-reference.js';
import { EmbeddingsDB } from './embeddings/database.js';
import { OllamaClient } from './embeddings/ollama-client.js';
import { SyncWorker } from './embeddings/sync-worker.js';
import * as logger from './logger.js';
import {
  handleSearchTiddlers,
  handleUpdateTiddler,
  handleCreateTiddler,
  handleDeleteTiddler,
} from './tools/index.js';
import type { ToolDependencies } from './tools/index.js';

// Global embeddings infrastructure (singletons - shared across requests)
let embeddingsDB: EmbeddingsDB | null = null;
let ollamaClient: OllamaClient | null = null;
let syncWorker: SyncWorker | null = null;

// Server for stdio transport (created once, used for the lifetime of the process)
let stdioServer: Server | null = null;

/**
 * Get the current tool dependencies for handlers that need embeddings.
 */
function getToolDependencies(): ToolDependencies {
  return {
    embeddingsDB,
    ollamaClient,
    syncWorker,
  };
}

/**
 * Create a new MCP server instance with all handlers registered.
 * Used for stateless mode where each request gets its own server.
 */
function createServer(): Server {
  const server = new Server(
    {
      name: 'tiddlywiki-http-mcp-server',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    }
  );

  registerHandlers(server);
  return server;
}

/**
 * Register all MCP handlers on a server instance.
 * Separated from server creation to allow reuse with different transports.
 */
function registerHandlers(server: Server): void {
  // List available resources
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return {
      resources: [
        {
          uri: 'filter-reference://syntax',
          name: 'TiddlyWiki Filter Syntax Reference',
          description:
            'Complete reference documentation for TiddlyWiki filter operators and syntax',
          mimeType: 'text/markdown',
        },
      ],
    };
  });

  // Read resource content
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;

    if (uri === 'filter-reference://syntax') {
      const reference = getFilterReference();
      return {
        contents: [
          {
            uri,
            mimeType: 'text/markdown',
            text: reference.content,
          },
        ],
      };
    }

    throw new Error(`Unknown resource: ${uri}`);
  });

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'search_tiddlers',
          description:
            'Search tiddlers using filter syntax, semantic similarity, or both. Supports filter-based queries (e.g., by tag, date, title), semantic/conceptual search, and hybrid combinations. Returns matching tiddlers with metadata and optionally text content.',
          inputSchema: {
            type: 'object',
            properties: {
              semantic: {
                type: 'string',
                description:
                  'Natural language semantic search query (e.g., "times I felt anxious about parenting", "entries about work stress"). Finds conceptually related entries even without exact keyword matches.',
              },
              filter: {
                type: 'string',
                description:
                  'TiddlyWiki filter expression (e.g., "[tag[Journal]prefix[2025-11]]" for November 2025 journal entries, "[title[2025-11-12]]" for specific entry). Can be used alone for filter-based search, or combined with semantic for hybrid search.',
              },
              includeText: {
                type: 'boolean',
                description:
                  'Include text content in results (default: false). Set to true to get full tiddler content.',
                default: false,
              },
              offset: {
                type: 'number',
                description:
                  'Number of results to skip for pagination (default: 0). Only applies to filter-based search.',
                default: 0,
              },
              limit: {
                type: 'number',
                description:
                  'Maximum number of results to return (default: 10 for semantic search, unlimited for filter-only, max: 100). Use for pagination to avoid response size limits.',
              },
            },
          },
        },
        {
          name: 'update_tiddler',
          description:
            'Update an existing tiddler. Shows a diff of changes and requests approval before applying. Preserves metadata like created timestamp. Supports arbitrary custom fields beyond the standard ones (e.g., caption, summary, author, or any TiddlyWiki field).',
          inputSchema: {
            type: 'object',
            properties: {
              title: {
                type: 'string',
                description: 'Title of the tiddler to update',
              },
              text: {
                type: 'string',
                description: 'New text content (optional)',
              },
              tags: {
                type: 'string',
                description: 'New tags as space-separated string (optional)',
              },
              type: {
                type: 'string',
                description:
                  'Content type like "text/markdown" or "text/vnd.tiddlywiki" (optional)',
              },
            },
            additionalProperties: {
              type: 'string',
              description: 'Any additional TiddlyWiki field (e.g., caption, summary, author)',
            },
            required: ['title'],
          },
        },
        {
          name: 'create_tiddler',
          description:
            'Create a new tiddler. Shows a preview and requests approval before creating. Supports arbitrary custom fields beyond the standard ones (e.g., caption, summary, author, or any TiddlyWiki field).',
          inputSchema: {
            type: 'object',
            properties: {
              title: {
                type: 'string',
                description: 'Title of the new tiddler',
              },
              text: {
                type: 'string',
                description: 'Text content',
              },
              tags: {
                type: 'string',
                description:
                  'Tags as space-separated string (optional, e.g., "Journal" or "Journal OYS")',
                default: '',
              },
              type: {
                type: 'string',
                description: 'Content type (default: text/markdown)',
                default: 'text/markdown',
              },
            },
            additionalProperties: {
              type: 'string',
              description: 'Any additional TiddlyWiki field (e.g., caption, summary, author)',
            },
            required: ['title', 'text'],
          },
        },
        {
          name: 'delete_tiddler',
          description:
            'Delete a tiddler. Shows current content and requests approval before deleting.',
          inputSchema: {
            type: 'object',
            properties: {
              title: {
                type: 'string',
                description: 'Title of the tiddler to delete',
              },
            },
            required: ['title'],
          },
        },
      ],
    };
  });

  // Tool implementation handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case 'search_tiddlers':
          return await handleSearchTiddlers(args, getToolDependencies());

        case 'update_tiddler':
          return await handleUpdateTiddler(args);

        case 'create_tiddler':
          return await handleCreateTiddler(args);

        case 'delete_tiddler':
          return await handleDeleteTiddler(args);

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error) {
      const err = error as Error;
      logger.error(`[MCP Server] Error executing tool ${name}:`, err.message);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                error: err.message,
                tool: name,
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
  });
}

/**
 * Start MCP server with stdio transport
 */
async function startStdioTransport() {
  stdioServer = createServer();
  const transport = new StdioServerTransport();
  await stdioServer.connect(transport);
  logger.log(`[MCP Server] Server running on stdio`);
}

/**
 * Start MCP server with HTTP transport using stateless mode.
 *
 * In stateless mode, each request gets its own Server and Transport instance.
 * This prevents request ID collisions when multiple clients connect concurrently.
 * The MCP specification notes: "A single instance would cause request ID collisions
 * when multiple clients connect concurrently."
 *
 * Note: Stateless mode does not support server-initiated messages (SSE streams).
 * This is acceptable for our use case since we only respond to client requests.
 */
async function startHttpTransport() {
  const app = express();
  const port = parseInt(process.env.MCP_PORT || process.env.PORT || '3000', 10);

  app.use(express.json());

  // Health check endpoint for Nomad
  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'healthy', service: 'tiddlywiki-mcp-server' });
  });

  // Request timeout (90 seconds) as safety net against any blocking operations
  const REQUEST_TIMEOUT_MS = 90000;

  // MCP POST endpoint - handles JSON-RPC requests in stateless mode
  app.post('/mcp', async (req: Request, res: Response) => {
    const requestId = randomUUID().slice(0, 8);
    logger.log(`[MCP Server] [${requestId}] Handling request (stateless mode)`);

    // Create timeout promise
    let timeoutId: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`Request timed out after ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);
    });

    try {
      // Create fresh server and transport for this request
      const server = createServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });

      // Connect and handle the request with timeout
      const handlePromise = (async () => {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      })();

      await Promise.race([handlePromise, timeoutPromise]);

      logger.log(`[MCP Server] [${requestId}] Request completed`);
    } catch (error) {
      const err = error as Error;
      const isTimeout = err.message.includes('timed out');
      logger.error(
        `[MCP Server] [${requestId}] ${isTimeout ? 'Request timeout' : 'Error handling request'}:`,
        err.message
      );
      if (!res.headersSent) {
        res.status(isTimeout ? 504 : 500).json({
          jsonrpc: '2.0',
          error: {
            code: isTimeout ? -32001 : -32603,
            message: isTimeout ? 'Request timeout' : 'Internal server error',
          },
          id: null,
        });
      }
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  });

  // SSE streams not supported in stateless mode - return helpful error
  app.get('/mcp', async (_req: Request, res: Response) => {
    res.status(400).json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'SSE streams not supported in stateless mode. Use POST for all requests.',
      },
      id: null,
    });
  });

  // DELETE not needed in stateless mode - return helpful error
  app.delete('/mcp', async (_req: Request, res: Response) => {
    res.status(400).json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Session termination not needed in stateless mode.',
      },
      id: null,
    });
  });

  // Start HTTP server
  app.listen(port, () => {
    logger.log(`[MCP Server] HTTP server listening on port ${port} (stateless mode)`);
    logger.log(`[MCP Server] Health check: http://localhost:${port}/health`);
    logger.log(`[MCP Server] MCP endpoint: http://localhost:${port}/mcp`);
  });
}

// Main startup function
async function main() {
  const tiddlywikiUrl = process.env.TIDDLYWIKI_URL;
  if (!tiddlywikiUrl) {
    logger.error('[MCP Server] TIDDLYWIKI_URL environment variable is required');
    logger.error('[MCP Server] Example: TIDDLYWIKI_URL=http://localhost:8080');
    process.exit(1);
  }

  const authHeader = process.env.AUTH_HEADER || 'X-Oidc-Username';
  const authUser = process.env.AUTH_USER || 'mcp-user';
  const transport = process.env.MCP_TRANSPORT || 'stdio';
  const ollamaUrl = process.env.OLLAMA_URL || 'http://localhost:11434';
  const embeddingsEnabled = process.env.EMBEDDINGS_ENABLED !== 'false'; // Enabled by default
  const embeddingsDbPath = process.env.EMBEDDINGS_DB_PATH || './embeddings.db';

  logger.log(`[MCP Server] Starting TiddlyWiki MCP Server...`);
  logger.log(`[MCP Server] Transport: ${transport}`);
  logger.log(`[MCP Server] TiddlyWiki URL: ${tiddlywikiUrl}`);
  logger.log(`[MCP Server] Auth header: ${authHeader}`);
  logger.log(`[MCP Server] Auth user: ${authUser}`);
  logger.log(`[MCP Server] Embeddings enabled: ${embeddingsEnabled}`);
  if (embeddingsEnabled) {
    logger.log(`[MCP Server] Embeddings database: ${embeddingsDbPath}`);
  }

  try {
    // Initialize TiddlyWiki HTTP client
    initTiddlyWiki({
      tiddlywikiUrl,
      authHeader,
      authUser,
    });

    logger.log(`[MCP Server] TiddlyWiki client initialized`);

    // Initialize embeddings infrastructure (if enabled)
    if (embeddingsEnabled) {
      try {
        logger.log(`[MCP Server] Initializing embeddings infrastructure...`);
        logger.log(`[MCP Server] Ollama URL: ${ollamaUrl}`);

        // Initialize database
        embeddingsDB = new EmbeddingsDB(embeddingsDbPath);
        logger.log(`[MCP Server] Embeddings database initialized`);

        // Initialize Ollama client
        ollamaClient = new OllamaClient(ollamaUrl);

        // Check Ollama health
        const healthy = await ollamaClient.healthCheck();
        if (healthy) {
          logger.log(`[MCP Server] Ollama is healthy`);
        } else {
          logger.warn(`[MCP Server] WARNING: Ollama is not responding at ${ollamaUrl}`);
          logger.warn(`[MCP Server] Semantic search will not be available until Ollama is running`);
        }

        // Initialize and start sync worker
        syncWorker = new SyncWorker(embeddingsDB, ollamaClient, {
          syncIntervalMs: 5 * 60 * 1000, // 5 minutes
          batchSize: 5,
          enabled: true,
        });

        await syncWorker.start();
        logger.log(`[MCP Server] Sync worker started`);

        const status = syncWorker.getStatus();
        logger.log(`[MCP Server] Indexed tiddlers: ${status.indexedTiddlers}`);
        logger.log(`[MCP Server] Total embeddings: ${status.totalEmbeddings}`);
      } catch (error) {
        const err = error as Error;
        logger.warn(`[MCP Server] WARNING: Failed to initialize embeddings: ${err.message}`);
        logger.warn(`[MCP Server] Semantic search will not be available`);
        // Don't fail startup, just disable embeddings
        embeddingsDB = null;
        ollamaClient = null;
        syncWorker = null;
      }
    }

    // Start appropriate transport
    if (transport === 'http') {
      await startHttpTransport();
    } else if (transport === 'stdio') {
      await startStdioTransport();
    } else {
      throw new Error(`Invalid transport: ${transport}. Use 'stdio' or 'http'`);
    }
  } catch (error) {
    const err = error as Error;
    logger.error(`[MCP Server] Failed to start: ${err.message}`);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGINT', () => {
  logger.log(`[MCP Server] Shutting down...`);
  if (syncWorker) {
    syncWorker.stop();
  }
  if (embeddingsDB) {
    embeddingsDB.close();
  }
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.log(`[MCP Server] Shutting down...`);
  if (syncWorker) {
    syncWorker.stop();
  }
  if (embeddingsDB) {
    embeddingsDB.close();
  }
  process.exit(0);
});

// Start the server
main().catch((error) => {
  logger.error(`[MCP Server] Fatal error:`, error);
  process.exit(1);
});
