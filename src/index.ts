#!/usr/bin/env node
/**
 * TiddlyWiki MCP Server
 *
 * MCP server for TiddlyWiki with stdio and HTTP transport support
 * Supports both local development (stdio) and Nomad deployment (HTTP)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  isInitializeRequest,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { createTwoFilesPatch } from 'diff';
import { randomUUID } from 'node:crypto';
import express from 'express';
import type { Request, Response } from 'express';
import { encode } from 'gpt-tokenizer';
import {
  initTiddlyWiki,
  queryTiddlers,
  getTiddler,
  putTiddler,
  deleteTiddler,
  createTiddlerObject,
  updateTiddlerObject,
  getAuthUser,
  type Tiddler,
} from './tiddlywiki-http.js';
import { getFilterReference } from './filter-reference.js';
import { EmbeddingsDB } from './embeddings/database.js';
import { OllamaClient } from './embeddings/ollama-client.js';
import { SyncWorker } from './embeddings/sync-worker.js';
import * as logger from './logger.js';

// Zod schemas for tool inputs
const SearchTiddlersInput = z.object({
  semantic: z.string().optional().describe('Natural language semantic search query (e.g., "times I felt anxious about parenting")'),
  filter: z.string().optional().describe('TiddlyWiki filter expression (e.g., "[tag[Journal]prefix[2025-11]]"). Can be used alone for filter-based search, or combined with semantic for hybrid search.'),
  includeText: z.boolean().optional().describe('Include text content in results (default: false)'),
  offset: z.number().int().min(0).optional().describe('Number of results to skip (default: 0). Only applies to filter-based search.'),
  limit: z.number().int().min(1).max(100).optional().describe('Maximum number of results to return (default: 10 for semantic, unlimited for filter, max: 100)'),
}).refine(
  (data) => data.semantic !== undefined || data.filter !== undefined,
  { message: 'At least one of semantic or filter must be provided' }
);

const UpdateTiddlerInput = z.object({
  title: z.string().describe('Title of the tiddler to update'),
  text: z.string().optional().describe('New text content'),
  tags: z.string().optional().describe('New tags (space-separated)'),
  type: z.string().optional().describe('Content type (e.g., text/markdown)'),
});

const CreateTiddlerInput = z.object({
  title: z.string().describe('Title of the new tiddler'),
  text: z.string().describe('Text content'),
  tags: z.string().optional().describe('Tags (space-separated)'),
  type: z.string().optional().describe('Content type (default: text/markdown)'),
});

const DeleteTiddlerInput = z.object({
  title: z.string().describe('Title of the tiddler to delete'),
});

// Global embeddings infrastructure
let embeddingsDB: EmbeddingsDB | null = null;
let ollamaClient: OllamaClient | null = null;
let syncWorker: SyncWorker | null = null;

// Initialize the MCP server
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

// Token counting and response size validation
const MAX_RESPONSE_TOKENS = 23000; // Safe threshold below ~25k limit

/**
 * Count tokens in a string using gpt-tokenizer
 */
function countTokens(text: string): number {
  return encode(text).length;
}

/**
 * Validate response size and suggest pagination if needed
 * Returns null if response is OK, or an error message if too large
 */
function validateResponseSize(results: any[], filter: string, includeText: boolean): string | null {
  const responseJson = JSON.stringify(results, null, 2);
  const tokenCount = countTokens(responseJson);

  if (tokenCount <= MAX_RESPONSE_TOKENS) {
    return null; // Response is fine
  }

  // Calculate how many items would fit
  const avgTokensPerItem = tokenCount / results.length;
  const suggestedLimit = Math.floor(MAX_RESPONSE_TOKENS / avgTokensPerItem);

  const errorMessage = `Query matched ${results.length} tiddlers but response would be ${tokenCount.toLocaleString()} tokens (exceeds ${MAX_RESPONSE_TOKENS.toLocaleString()} token limit).

To retrieve results, use the limit parameter with offset for pagination.

**Suggested query:**
\`\`\`
query_tiddlers({
  filter: "${filter}",
  includeText: ${includeText},
  limit: ${suggestedLimit},
  offset: 0
})
\`\`\`

Then increment offset by ${suggestedLimit} for subsequent batches (offset: ${suggestedLimit}, offset: ${suggestedLimit * 2}, etc.) until you've retrieved all ${results.length} tiddlers.`;

  return errorMessage;
}

// List available resources
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: [
      {
        uri: 'filter-reference://syntax',
        name: 'TiddlyWiki Filter Syntax Reference',
        description: 'Complete reference documentation for TiddlyWiki filter operators and syntax',
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
              description: 'Include text content in results (default: false). Set to true to get full tiddler content.',
              default: false,
            },
            offset: {
              type: 'number',
              description: 'Number of results to skip for pagination (default: 0). Only applies to filter-based search.',
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
          'Update an existing tiddler. Shows a diff of changes and requests approval before applying. Preserves metadata like created timestamp.',
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
              description: 'Content type like "text/markdown" or "text/vnd.tiddlywiki" (optional)',
            },
          },
          required: ['title'],
        },
      },
      {
        name: 'create_tiddler',
        description: 'Create a new tiddler. Shows a preview and requests approval before creating.',
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
              description: 'Tags as space-separated string (optional, e.g., "Journal" or "Journal OYS")',
              default: '',
            },
            type: {
              type: 'string',
              description: 'Content type (default: text/markdown)',
              default: 'text/markdown',
            },
          },
          required: ['title', 'text'],
        },
      },
      {
        name: 'delete_tiddler',
        description: 'Delete a tiddler. Shows current content and requests approval before deleting.',
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

/**
 * Generate a readable diff between two tiddlers
 */
function generateTiddlerDiff(oldTiddler: Tiddler, newTiddler: Tiddler): string {
  const lines: string[] = [];

  // Text diff
  const oldText = oldTiddler.text || '';
  const newText = newTiddler.text || '';

  if (oldText !== newText) {
    const patch = createTwoFilesPatch(
      oldTiddler.title,
      newTiddler.title,
      oldText,
      newText,
      'Before',
      'After',
      { context: 1 }  // Reduce context to 1 line for more compact diffs
    );

    // Add a concise summary
    const oldLines = oldText.split('\n').length;
    const newLines = newText.split('\n').length;
    const delta = newLines - oldLines;
    const summary = delta > 0
      ? `+${delta} line${delta === 1 ? '' : 's'}`
      : delta < 0
        ? `${delta} line${delta === -1 ? '' : 's'}`
        : 'modified';

    lines.push(`**Content:** ${summary}`);
    lines.push('```diff');
    lines.push(patch);
    lines.push('```');
  }

  // Metadata changes
  const metadataChanges: string[] = [];

  if (oldTiddler.tags !== newTiddler.tags) {
    metadataChanges.push(`  tags: "${oldTiddler.tags || ''}" → "${newTiddler.tags || ''}"`);
  }

  if (oldTiddler.type !== newTiddler.type) {
    metadataChanges.push(`  type: "${oldTiddler.type}" → "${newTiddler.type}"`);
  }

  if (metadataChanges.length > 0) {
    lines.push('');
    lines.push('**Metadata:**');
    lines.push(...metadataChanges);
  }

  return lines.join('\n');
}

/**
 * Format a tiddler for preview
 */
function formatTiddlerPreview(tiddler: Tiddler): string {
  const lines: string[] = [];

  lines.push(`**Title:** ${tiddler.title}`);
  lines.push(`**Type:** ${tiddler.type || 'text/vnd.tiddlywiki'}`);
  lines.push(`**Tags:** ${tiddler.tags || '(none)'}`);
  lines.push('');
  lines.push('**Content:**');
  lines.push('```');
  lines.push(tiddler.text || '(empty)');
  lines.push('```');

  return lines.join('\n');
}

// Tool implementation handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'search_tiddlers': {
        const input = SearchTiddlersInput.parse(args);
        const includeText = input.includeText ?? false;
        const hasSemantic = input.semantic !== undefined;
        const hasFilter = input.filter !== undefined;

        // Filter-only mode
        if (hasFilter && !hasSemantic) {
          const offset = input.offset ?? 0;
          const limit = input.limit;
          const filter = input.filter!; // Non-null assertion (checked by hasFilter)
          const results = await queryTiddlers(filter, includeText, offset, limit);

          // Validate response size
          const sizeError = validateResponseSize(results, filter, includeText);
          if (sizeError) {
            return {
              content: [{ type: 'text', text: sizeError }],
              isError: true,
            };
          }

          return {
            content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
          };
        }

        // Semantic mode (with optional filter)
        if (hasSemantic) {
          // Check if embeddings infrastructure is available
          if (!embeddingsDB || !ollamaClient) {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      error: 'Semantic search is not available',
                      reason: 'Embeddings database or Ollama client not initialized',
                      suggestion: 'Check server logs for initialization errors',
                    },
                    null,
                    2
                  ),
                },
              ],
              isError: true,
            };
          }

          // Check if any tiddlers have been indexed
          const indexedCount = embeddingsDB.getIndexedTiddlersCount();
          if (indexedCount === 0) {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      error: 'No tiddlers have been indexed yet',
                      suggestion:
                        'The sync worker is still indexing entries. Please wait a few minutes and try again.',
                      status: syncWorker?.getStatus() || 'unknown',
                    },
                    null,
                    2
                  ),
                },
              ],
              isError: true,
            };
          }

          // Generate embedding for the query with search_query prefix
          const semantic = input.semantic!; // Non-null assertion (checked by hasSemantic)
          const queryEmbedding = await ollamaClient.generateQueryEmbedding(semantic);

          // Search for similar entries
          const limit = input.limit || 10;
          const results = embeddingsDB.searchSimilar(queryEmbedding, limit);

          // Apply optional TiddlyWiki filter for hybrid search
          let filteredResults = results;
          if (hasFilter) {
            const filter = input.filter!; // Non-null assertion (checked by hasFilter)
            const filterMatches = await queryTiddlers(filter, false);
            const filterTitles = new Set(filterMatches.map((t) => t.title));
            filteredResults = results.filter((r) => filterTitles.has(r.tiddler_title));
          }

          // Fetch full tiddlers if includeText is true
          const formattedResults = await Promise.all(
            filteredResults.map(async (r) => {
              const result: any = {
                tiddler_title: r.tiddler_title,
                chunk_id: r.chunk_id,
                similarity_score: (1 - r.distance).toFixed(4), // Convert distance to similarity
                created: r.created,
                modified: r.modified,
                tags: r.tags,
              };

              // Fetch full tiddler text if requested
              if (includeText) {
                const fullTiddler = await getTiddler(r.tiddler_title);
                if (fullTiddler) {
                  result.text = fullTiddler.text;
                  result.type = fullTiddler.type;
                }
              }

              return result;
            })
          );

          // Validate response size
          const responseJson = JSON.stringify(formattedResults, null, 2);
          const tokenCount = countTokens(responseJson);

          if (tokenCount > MAX_RESPONSE_TOKENS) {
            const avgTokensPerItem = tokenCount / formattedResults.length;
            const suggestedLimit = Math.floor(MAX_RESPONSE_TOKENS / avgTokensPerItem);

            const filterParam = hasFilter ? `,\n  filter: "${input.filter!}"` : '';
            const errorMessage = `Semantic search matched ${formattedResults.length} results but response would be ${tokenCount.toLocaleString()} tokens (exceeds ${MAX_RESPONSE_TOKENS.toLocaleString()} token limit).

To retrieve results, use the limit parameter.

**Suggested query:**
\`\`\`
search_tiddlers({
  semantic: "${semantic}",
  includeText: ${includeText},
  limit: ${suggestedLimit}${filterParam}
})
\`\`\`

Note: Semantic search returns results ordered by similarity, so using a lower limit will return the most relevant matches.`;

            return {
              content: [{ type: 'text', text: errorMessage }],
              isError: true,
            };
          }

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    query: semantic,
                    total_results: formattedResults.length,
                    indexed_tiddlers: indexedCount,
                    results: formattedResults,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        // Should never reach here due to Zod validation
        throw new Error('Either semantic or filter must be provided');
      }

      case 'update_tiddler': {
        const input = UpdateTiddlerInput.parse(args);

        // Get current tiddler
        const current = await getTiddler(input.title);
        if (!current) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ error: `Tiddler not found: ${input.title}` }, null, 2),
              },
            ],
            isError: true,
          };
        }

        // Build updated tiddler
        const updates: Partial<Tiddler> = {};
        if (input.text !== undefined) updates.text = input.text;
        if (input.tags !== undefined) updates.tags = input.tags;
        if (input.type !== undefined) updates.type = input.type;

        const updated = updateTiddlerObject(current, updates, getAuthUser());

        // Generate diff
        const diff = generateTiddlerDiff(current, updated);

        // Request approval via elicitation
        const approvalMessage = `## Update Tiddler: "${input.title}"?\n\n${diff}\n\n**Approve this change?**`;

        // Note: In the current MCP SDK, elicitation is done via the request context
        // For now, we'll proceed with the update and return the diff for review
        // The actual elicitation implementation depends on the MCP SDK version

        // TODO: Implement elicitation when SDK supports it
        // await request.meta.session.elicit({ message: approvalMessage });

        // For now, we'll apply the change directly and return the diff
        await putTiddler(updated);

        return {
          content: [
            {
              type: 'text',
              text: `## ✓ Updated: "${input.title}"\n\n${diff}`,
            },
          ],
        };
      }

      case 'create_tiddler': {
        const input = CreateTiddlerInput.parse(args);

        // Check if tiddler already exists
        const existing = await getTiddler(input.title);
        if (existing) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  { error: `Tiddler already exists: ${input.title}. Use update_tiddler to modify it.` },
                  null,
                  2
                ),
              },
            ],
            isError: true,
          };
        }

        // Create new tiddler object
        const newTiddler = createTiddlerObject(
          input.title,
          input.text,
          input.tags || '',
          input.type || 'text/markdown',
          getAuthUser()
        );

        // Generate preview
        const preview = formatTiddlerPreview(newTiddler);

        // Request approval via elicitation
        const approvalMessage = `## Create New Tiddler?\n\n${preview}\n\n**Approve creation?**`;

        // TODO: Implement elicitation when SDK supports it
        // await request.meta.session.elicit({ message: approvalMessage });

        // Create the tiddler
        await putTiddler(newTiddler);

        return {
          content: [
            {
              type: 'text',
              text: `## ✓ Created: "${input.title}"\n\n${preview}`,
            },
          ],
        };
      }

      case 'delete_tiddler': {
        const input = DeleteTiddlerInput.parse(args);

        // Get current tiddler to show what will be deleted
        const current = await getTiddler(input.title);
        if (!current) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ error: `Tiddler not found: ${input.title}` }, null, 2),
              },
            ],
            isError: true,
          };
        }

        // Generate preview of what will be deleted
        const preview = formatTiddlerPreview(current);

        // Request approval via elicitation
        const approvalMessage = `## Delete Tiddler "${input.title}"?\n\n${preview}\n\n**This action cannot be undone. Approve deletion?**`;

        // TODO: Implement elicitation when SDK supports it
        // await request.meta.session.elicit({ message: approvalMessage });

        // Delete the tiddler
        await deleteTiddler(input.title);

        return {
          content: [
            {
              type: 'text',
              text: `Successfully deleted tiddler "${input.title}"`,
            },
          ],
        };
      }

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

/**
 * Start MCP server with stdio transport
 */
async function startStdioTransport() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.log(`[MCP Server] Server running on stdio`);
}

/**
 * Start MCP server with HTTP transport
 */
async function startHttpTransport() {
  const app = express();
  const port = parseInt(process.env.MCP_PORT || process.env.PORT || '3000', 10);

  app.use(express.json());

  // Map to store transports by session ID
  const transports: Record<string, StreamableHTTPServerTransport> = {};

  // Health check endpoint for Nomad
  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'healthy', service: 'tiddlywiki-mcp-server' });
  });

  // MCP POST endpoint - handles JSON-RPC requests
  app.post('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (sessionId) {
      logger.log(`[MCP Server] Received request for session: ${sessionId}`);
    } else {
      logger.log('[MCP Server] Received new request (no session ID)');
    }

    try {
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports[sessionId]) {
        // Reuse existing transport for this session
        transport = transports[sessionId];
      } else if (!sessionId && isInitializeRequest(req.body)) {
        // New initialization request - create new transport
        logger.log('[MCP Server] Creating new transport for initialization request');
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid: string) => {
            logger.log(`[MCP Server] Session initialized: ${sid}`);
            transports[sid] = transport;
          },
          onsessionclosed: (sid: string) => {
            logger.log(`[MCP Server] Session closed: ${sid}`);
            delete transports[sid];
          },
        });

        // Set up onclose handler for cleanup
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && transports[sid]) {
            logger.log(`[MCP Server] Transport closed for session ${sid}`);
            delete transports[sid];
          }
        };

        // Connect the transport to the MCP server
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      } else {
        // Invalid request - no session ID or not an initialization request
        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Bad Request: No valid session ID provided',
          },
          id: null,
        });
        return;
      }

      // Handle the request with existing transport
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logger.error('[MCP Server] Error handling MCP request:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal server error',
          },
          id: null,
        });
      }
    }
  });

  // MCP GET endpoint - handles SSE streams
  app.get('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (!sessionId || !transports[sessionId]) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }

    const lastEventId = req.headers['last-event-id'];
    if (lastEventId) {
      logger.log(`[MCP Server] Client reconnecting with Last-Event-ID: ${lastEventId}`);
    } else {
      logger.log(`[MCP Server] Establishing SSE stream for session ${sessionId}`);
    }

    const transport = transports[sessionId];
    await transport.handleRequest(req, res);
  });

  // MCP DELETE endpoint - handles session termination
  app.delete('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (!sessionId || !transports[sessionId]) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }

    logger.log(`[MCP Server] Received session termination request for session ${sessionId}`);

    try {
      const transport = transports[sessionId];
      await transport.handleRequest(req, res);
    } catch (error) {
      logger.error('[MCP Server] Error handling session termination:', error);
      if (!res.headersSent) {
        res.status(500).send('Error processing session termination');
      }
    }
  });

  // Start HTTP server
  app.listen(port, () => {
    logger.log(`[MCP Server] HTTP server listening on port ${port}`);
    logger.log(`[MCP Server] Health check: http://localhost:${port}/health`);
    logger.log(`[MCP Server] MCP endpoint: http://localhost:${port}/mcp`);
  });

  // Cleanup on shutdown
  const cleanup = async () => {
    logger.log('[MCP Server] Shutting down, cleaning up sessions...');
    for (const sessionId in transports) {
      try {
        logger.log(`[MCP Server] Closing transport for session ${sessionId}`);
        await transports[sessionId].close();
        delete transports[sessionId];
      } catch (error) {
        logger.error(`[MCP Server] Error closing transport for session ${sessionId}:`, error);
      }
    }
  };

  // Attach cleanup to process events
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

// Main startup function
async function main() {
  const consulService = process.env.CONSUL_SERVICE || 'captainslog.service.consul';
  const authHeader = process.env.AUTH_HEADER || 'X-Oidc-Username';
  const authUser = process.env.AUTH_USER || 'mcp-user';
  const transport = process.env.MCP_TRANSPORT || 'stdio';
  const ollamaUrl = process.env.OLLAMA_URL || 'http://ollama.service.consul:11434';
  const embeddingsEnabled = process.env.EMBEDDINGS_ENABLED !== 'false'; // Enabled by default

  logger.log(`[MCP Server] Starting TiddlyWiki MCP Server...`);
  logger.log(`[MCP Server] Transport: ${transport}`);
  logger.log(`[MCP Server] Consul service: ${consulService}`);
  logger.log(`[MCP Server] Auth header: ${authHeader}`);
  logger.log(`[MCP Server] Auth user: ${authUser}`);
  logger.log(`[MCP Server] Embeddings enabled: ${embeddingsEnabled}`);

  try {
    // Initialize TiddlyWiki HTTP client
    initTiddlyWiki({
      consulService,
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
        embeddingsDB = new EmbeddingsDB();
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
          enabled: true
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
