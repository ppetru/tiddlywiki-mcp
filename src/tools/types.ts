// ABOUTME: Shared types for MCP tool handlers
// ABOUTME: Defines ToolResult, ToolDependencies, and Zod schemas for tool inputs

import { z } from 'zod';
import type { EmbeddingsDB } from '../embeddings/database.js';
import type { OllamaClient } from '../embeddings/ollama-client.js';
import type { SyncWorker } from '../embeddings/sync-worker.js';

/**
 * Standard result type returned by all tool handlers.
 * Matches the MCP SDK's expected response format.
 * Uses index signature to allow additional properties the SDK may expect.
 */
export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/**
 * Dependencies injected into tool handlers that need embeddings functionality.
 * All fields are nullable since embeddings may be disabled.
 */
export interface ToolDependencies {
  embeddingsDB: EmbeddingsDB | null;
  ollamaClient: OllamaClient | null;
  syncWorker: SyncWorker | null;
}

// Zod schemas for tool inputs

export const SearchTiddlersInput = z
  .object({
    semantic: z
      .string()
      .optional()
      .describe(
        'Natural language semantic search query (e.g., "times I felt anxious about parenting")'
      ),
    filter: z
      .string()
      .optional()
      .describe(
        'TiddlyWiki filter expression (e.g., "[tag[Journal]prefix[2025-11]]"). Can be used alone for filter-based search, or combined with semantic for hybrid search.'
      ),
    includeText: z
      .boolean()
      .optional()
      .describe('Include text content in results (default: false)'),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Number of results to skip (default: 0). Only applies to filter-based search.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe(
        'Maximum number of results to return (default: 10 for semantic, unlimited for filter, max: 100)'
      ),
  })
  .refine((data) => data.semantic !== undefined || data.filter !== undefined, {
    message: 'At least one of semantic or filter must be provided',
  });

export type SearchTiddlersInputType = z.infer<typeof SearchTiddlersInput>;

export const UpdateTiddlerInput = z
  .object({
    title: z.string().describe('Title of the tiddler to update'),
    text: z.string().optional().describe('New text content'),
    tags: z.string().optional().describe('New tags (space-separated)'),
    type: z.string().optional().describe('Content type (e.g., text/markdown)'),
  })
  .passthrough(); // Allow additional custom fields

export type UpdateTiddlerInputType = z.infer<typeof UpdateTiddlerInput>;

export const CreateTiddlerInput = z
  .object({
    title: z.string().describe('Title of the new tiddler'),
    text: z.string().describe('Text content'),
    tags: z.string().optional().describe('Tags (space-separated)'),
    type: z.string().optional().describe('Content type (default: text/markdown)'),
  })
  .passthrough(); // Allow additional custom fields

export type CreateTiddlerInputType = z.infer<typeof CreateTiddlerInput>;

export const DeleteTiddlerInput = z.object({
  title: z.string().describe('Title of the tiddler to delete'),
});

export type DeleteTiddlerInputType = z.infer<typeof DeleteTiddlerInput>;
