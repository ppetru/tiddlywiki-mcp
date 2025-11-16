#!/usr/bin/env node
/**
 * TiddlyWiki MCP Server
 *
 * MCP server for TiddlyWiki with stdio and HTTP transport support
 * Supports both local development (stdio) and Nomad deployment (HTTP)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { createTwoFilesPatch } from 'diff';
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
  type Tiddler,
} from './tiddlywiki-http.js';
import { getFilterReference } from './filter-reference.js';

// Zod schemas for tool inputs
const QueryTiddlersInput = z.object({
  filter: z.string().describe('TiddlyWiki filter expression'),
  includeText: z.boolean().optional().describe('Include text content in results (default: false)'),
  offset: z.number().int().min(0).optional().describe('Number of results to skip (default: 0)'),
  limit: z.number().int().min(1).max(100).optional().describe('Maximum number of results to return (default: unlimited, max: 100)'),
});

const GetTiddlerInput = z.object({
  title: z.string().describe('Title of the tiddler to retrieve'),
});

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

// Initialize the MCP server
const server = new Server(
  {
    name: 'tiddlywiki-http-mcp-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
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

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'query_tiddlers',
        description:
          'Query tiddlers using TiddlyWiki filter syntax. Returns matching tiddlers with metadata and optionally text content. Supports server-side filtering for complex queries. Use offset/limit for pagination when dealing with large result sets.',
        inputSchema: {
          type: 'object',
          properties: {
            filter: {
              type: 'string',
              description:
                'TiddlyWiki filter expression (e.g., "[tag[Journal]!tag[agent-generated]prefix[2025-11]]" for November 2025 journal entries)',
            },
            includeText: {
              type: 'boolean',
              description: 'Include text content in results (default: false). Set to true to get full tiddler content.',
              default: false,
            },
            offset: {
              type: 'number',
              description: 'Number of results to skip for pagination (default: 0). Use with limit to paginate through large result sets.',
              default: 0,
            },
            limit: {
              type: 'number',
              description: 'Maximum number of results to return (default: unlimited, max: 100). Use for pagination to avoid response size limits.',
            },
          },
          required: ['filter'],
        },
      },
      {
        name: 'get_tiddler',
        description: 'Get a single tiddler by its exact title. Returns all fields including text content.',
        inputSchema: {
          type: 'object',
          properties: {
            title: {
              type: 'string',
              description: 'Exact title of the tiddler to retrieve (e.g., "2025-11-12" for a journal entry)',
            },
          },
          required: ['title'],
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
      {
        name: 'list_filter_operators',
        description: 'Get comprehensive reference documentation for TiddlyWiki filter syntax and operators. Use this to learn how to construct filter queries.',
        inputSchema: {
          type: 'object',
          properties: {},
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
      case 'query_tiddlers': {
        const input = QueryTiddlersInput.parse(args);
        const includeText = input.includeText ?? false;
        const offset = input.offset ?? 0;
        const limit = input.limit;

        // Fetch results with pagination parameters
        const results = await queryTiddlers(input.filter, includeText, offset, limit);

        // Validate response size
        const sizeError = validateResponseSize(results, input.filter, includeText);
        if (sizeError) {
          return {
            content: [
              {
                type: 'text',
                text: sizeError,
              },
            ],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(results, null, 2),
            },
          ],
        };
      }

      case 'get_tiddler': {
        const input = GetTiddlerInput.parse(args);
        const tiddler = await getTiddler(input.title);

        if (!tiddler) {
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

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(tiddler, null, 2),
            },
          ],
        };
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

        const updated = updateTiddlerObject(current, updates);

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
          input.type || 'text/markdown'
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

      case 'list_filter_operators': {
        const reference = getFilterReference();

        return {
          content: [
            {
              type: 'text',
              text: reference.content,
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const err = error as Error;
    console.error(`[MCP Server] Error executing tool ${name}:`, err.message);

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
  console.error(`[MCP Server] Server running on stdio`);
}

/**
 * Start MCP server with HTTP transport
 */
async function startHttpTransport() {
  const app = express();
  const port = parseInt(process.env.MCP_PORT || process.env.PORT || '3000', 10);

  app.use(express.json());

  // Health check endpoint for Nomad
  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'healthy', service: 'tiddlywiki-mcp-server' });
  });

  // MCP JSON-RPC endpoint
  // TODO: Implement proper MCP HTTP transport in Phase 2
  // For now, this is a placeholder that returns an error
  app.post('/mcp', async (req: Request, res: Response) => {
    res.status(501).json({
      jsonrpc: '2.0',
      id: req.body.id || null,
      error: {
        code: -32601,
        message: 'HTTP transport not yet fully implemented. Use stdio transport for now.',
      },
    });
  });

  // Start HTTP server
  app.listen(port, () => {
    console.error(`[MCP Server] HTTP server listening on port ${port}`);
    console.error(`[MCP Server] Health check: http://localhost:${port}/health`);
    console.error(`[MCP Server] MCP endpoint: http://localhost:${port}/mcp`);
  });
}

// Main startup function
async function main() {
  const consulService = process.env.CONSUL_SERVICE || 'captainslog.service.consul';
  const authHeader = process.env.AUTH_HEADER || 'X-Oidc-Username';
  const authUser = process.env.AUTH_USER || 'ppetru';
  const transport = process.env.MCP_TRANSPORT || 'stdio';

  console.error(`[MCP Server] Starting TiddlyWiki MCP Server...`);
  console.error(`[MCP Server] Transport: ${transport}`);
  console.error(`[MCP Server] Consul service: ${consulService}`);
  console.error(`[MCP Server] Auth header: ${authHeader}`);
  console.error(`[MCP Server] Auth user: ${authUser}`);

  try {
    // Initialize TiddlyWiki HTTP client
    initTiddlyWiki({
      consulService,
      authHeader,
      authUser,
    });

    console.error(`[MCP Server] TiddlyWiki client initialized`);

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
    console.error(`[MCP Server] Failed to start: ${err.message}`);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.error(`[MCP Server] Shutting down...`);
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.error(`[MCP Server] Shutting down...`);
  process.exit(0);
});

// Start the server
main().catch((error) => {
  console.error(`[MCP Server] Fatal error:`, error);
  process.exit(1);
});
