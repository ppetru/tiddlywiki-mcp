// ABOUTME: Handler for the search_tiddlers MCP tool
// ABOUTME: Supports filter-based, semantic, and hybrid search modes with pagination

import { encode } from 'gpt-tokenizer';
import { queryTiddlers, getTiddler } from '../tiddlywiki-http.js';
import type { ToolResult, ToolDependencies } from './types.js';
import { SearchTiddlersInput } from './types.js';

// Token counting and response size validation
const MAX_RESPONSE_TOKENS = 23000; // Safe threshold below ~25k limit

/**
 * Count tokens in a string using gpt-tokenizer
 */
function countTokens(text: string): number {
  return encode(text).length;
}

/**
 * Validate response size and suggest pagination if needed.
 * Returns null if response is OK, or an error message if too large.
 */
function validateResponseSize(
  results: unknown[],
  filter: string,
  includeText: boolean
): string | null {
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

/**
 * Handle search_tiddlers tool requests.
 * Supports three modes:
 * - Filter-only: Pure TiddlyWiki filter expressions
 * - Semantic-only: Similarity search on indexed tiddlers
 * - Hybrid: Filter results, then re-rank by semantic similarity
 */
export async function handleSearchTiddlers(
  args: unknown,
  deps: ToolDependencies
): Promise<ToolResult> {
  const input = SearchTiddlersInput.parse(args);
  const includeText = input.includeText ?? false;
  const hasSemantic = input.semantic !== undefined;
  const hasFilter = input.filter !== undefined;

  // Filter-only mode
  if (hasFilter && !hasSemantic) {
    const offset = input.offset ?? 0;
    const limit = input.limit;
    const filter = input.filter!;
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
    const { embeddingsDB, ollamaClient, syncWorker } = deps;

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
    const semantic = input.semantic!;
    const queryEmbedding = await ollamaClient.generateQueryEmbedding(semantic);

    // Search for similar entries
    const limit = input.limit || 10;
    const results = embeddingsDB.searchSimilar(queryEmbedding, limit);

    // Apply optional TiddlyWiki filter for hybrid search
    let filteredResults = results;
    if (hasFilter) {
      const filter = input.filter!;
      const filterMatches = await queryTiddlers(filter, false);
      const filterTitles = new Set(filterMatches.map((t) => t.title));
      filteredResults = results.filter((r) => filterTitles.has(r.tiddler_title));
    }

    // Fetch full tiddlers if includeText is true
    const formattedResults = await Promise.all(
      filteredResults.map(async (r) => {
        const result: Record<string, unknown> = {
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

// Re-export the input schema for use in tool registration
export { SearchTiddlersInput };
