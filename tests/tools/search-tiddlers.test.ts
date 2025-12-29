// ABOUTME: Tests for the search_tiddlers MCP tool handler
// ABOUTME: Covers filter-only, semantic, and hybrid search modes

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleSearchTiddlers } from '../../src/tools/search-tiddlers.js';
import {
  createMockTiddler,
  createMockDepsWithoutEmbeddings,
  createMockDepsWithEmbeddings,
  parseToolResultJson,
} from './test-utils.js';

// Mock the tiddlywiki-http module
vi.mock('../../src/tiddlywiki-http.js', () => ({
  queryTiddlers: vi.fn(),
  getTiddler: vi.fn(),
}));

import { queryTiddlers, getTiddler } from '../../src/tiddlywiki-http.js';
const mockQueryTiddlers = vi.mocked(queryTiddlers);
const mockGetTiddler = vi.mocked(getTiddler);

describe('handleSearchTiddlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('input validation', () => {
    it('should reject when neither semantic nor filter is provided', async () => {
      const deps = createMockDepsWithoutEmbeddings();

      await expect(handleSearchTiddlers({}, deps)).rejects.toThrow(
        'At least one of semantic or filter must be provided'
      );
    });

    it('should accept filter-only search', async () => {
      const deps = createMockDepsWithoutEmbeddings();
      mockQueryTiddlers.mockResolvedValue([createMockTiddler()]);

      const result = await handleSearchTiddlers({ filter: '[tag[Test]]' }, deps);

      expect(result.isError).toBeUndefined();
      expect(mockQueryTiddlers).toHaveBeenCalledWith('[tag[Test]]', false, 0, undefined);
    });

    it('should accept semantic-only search', async () => {
      const deps = createMockDepsWithEmbeddings({
        searchResults: [
          {
            tiddler_title: 'Test',
            chunk_id: 0,
            distance: 0.1,
            created: '20250101',
            modified: '20250101',
            tags: 'TestTag',
          },
        ],
      });

      const result = await handleSearchTiddlers({ semantic: 'test query' }, deps);

      expect(result.isError).toBeUndefined();
    });
  });

  describe('filter-only mode', () => {
    it('should return tiddlers matching filter', async () => {
      const deps = createMockDepsWithoutEmbeddings();
      const tiddlers = [
        createMockTiddler({ title: 'Entry 1' }),
        createMockTiddler({ title: 'Entry 2' }),
      ];
      mockQueryTiddlers.mockResolvedValue(tiddlers);

      const result = await handleSearchTiddlers({ filter: '[tag[Journal]]' }, deps);
      const parsed = parseToolResultJson<typeof tiddlers>(result);

      expect(parsed).toHaveLength(2);
      expect(parsed[0].title).toBe('Entry 1');
    });

    it('should pass offset and limit to queryTiddlers', async () => {
      const deps = createMockDepsWithoutEmbeddings();
      mockQueryTiddlers.mockResolvedValue([]);

      await handleSearchTiddlers(
        { filter: '[tag[Test]]', offset: 10, limit: 5 },
        deps
      );

      expect(mockQueryTiddlers).toHaveBeenCalledWith('[tag[Test]]', false, 10, 5);
    });

    it('should include text content when includeText is true', async () => {
      const deps = createMockDepsWithoutEmbeddings();
      mockQueryTiddlers.mockResolvedValue([createMockTiddler({ text: 'Full content here' })]);

      await handleSearchTiddlers(
        { filter: '[tag[Test]]', includeText: true },
        deps
      );

      expect(mockQueryTiddlers).toHaveBeenCalledWith('[tag[Test]]', true, 0, undefined);
    });

    it('should return error when response exceeds token limit', async () => {
      const deps = createMockDepsWithoutEmbeddings();
      // Create a large response that exceeds token limit
      const largeTiddlers = Array.from({ length: 1000 }, (_, i) =>
        createMockTiddler({
          title: `Entry ${i}`,
          text: 'x'.repeat(1000), // Large text content
        })
      );
      mockQueryTiddlers.mockResolvedValue(largeTiddlers);

      const result = await handleSearchTiddlers(
        { filter: '[all[]]', includeText: true },
        deps
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('exceeds');
      expect(result.content[0].text).toContain('limit');
    });
  });

  describe('semantic mode', () => {
    it('should return error when embeddings not available', async () => {
      const deps = createMockDepsWithoutEmbeddings();

      const result = await handleSearchTiddlers({ semantic: 'test query' }, deps);
      const parsed = parseToolResultJson<{ error: string }>(result);

      expect(result.isError).toBe(true);
      expect(parsed.error).toBe('Semantic search is not available');
    });

    it('should return error when no tiddlers indexed', async () => {
      const deps = createMockDepsWithEmbeddings({ indexedCount: 0 });

      const result = await handleSearchTiddlers({ semantic: 'test query' }, deps);
      const parsed = parseToolResultJson<{ error: string }>(result);

      expect(result.isError).toBe(true);
      expect(parsed.error).toBe('No tiddlers have been indexed yet');
    });

    it('should return search results with similarity scores', async () => {
      const deps = createMockDepsWithEmbeddings({
        indexedCount: 10,
        searchResults: [
          {
            tiddler_title: 'Relevant Entry',
            chunk_id: 0,
            distance: 0.1, // Low distance = high similarity
            created: '20250101120000000',
            modified: '20250101120000000',
            tags: 'Journal',
          },
        ],
      });

      const result = await handleSearchTiddlers({ semantic: 'test query' }, deps);
      const parsed = parseToolResultJson<{
        query: string;
        results: Array<{ tiddler_title: string; similarity_score: string }>;
      }>(result);

      expect(result.isError).toBeUndefined();
      expect(parsed.query).toBe('test query');
      expect(parsed.results[0].tiddler_title).toBe('Relevant Entry');
      expect(parsed.results[0].similarity_score).toBe('0.9000'); // 1 - 0.1
    });

    it('should fetch full tiddler when includeText is true', async () => {
      const deps = createMockDepsWithEmbeddings({
        searchResults: [
          {
            tiddler_title: 'Test Entry',
            chunk_id: 0,
            distance: 0.2,
            created: '20250101',
            modified: '20250101',
            tags: '',
          },
        ],
      });
      mockGetTiddler.mockResolvedValue(
        createMockTiddler({ title: 'Test Entry', text: 'Full text content' })
      );

      const result = await handleSearchTiddlers(
        { semantic: 'query', includeText: true },
        deps
      );
      const parsed = parseToolResultJson<{
        results: Array<{ text: string }>;
      }>(result);

      expect(mockGetTiddler).toHaveBeenCalledWith('Test Entry');
      expect(parsed.results[0].text).toBe('Full text content');
    });

    it('should use default limit of 10', async () => {
      const deps = createMockDepsWithEmbeddings();

      await handleSearchTiddlers({ semantic: 'query' }, deps);

      expect(deps.embeddingsDB?.searchSimilar).toHaveBeenCalledWith(expect.any(Array), 10);
    });

    it('should respect custom limit', async () => {
      const deps = createMockDepsWithEmbeddings();

      await handleSearchTiddlers({ semantic: 'query', limit: 5 }, deps);

      expect(deps.embeddingsDB?.searchSimilar).toHaveBeenCalledWith(expect.any(Array), 5);
    });
  });

  describe('hybrid mode (semantic + filter)', () => {
    it('should filter semantic results by TiddlyWiki filter', async () => {
      const deps = createMockDepsWithEmbeddings({
        searchResults: [
          { tiddler_title: 'Journal Entry', chunk_id: 0, distance: 0.1, created: '', modified: '', tags: '' },
          { tiddler_title: 'Other Entry', chunk_id: 0, distance: 0.2, created: '', modified: '', tags: '' },
        ],
      });

      // Filter matches only Journal Entry
      mockQueryTiddlers.mockResolvedValue([createMockTiddler({ title: 'Journal Entry' })]);

      const result = await handleSearchTiddlers(
        { semantic: 'query', filter: '[tag[Journal]]' },
        deps
      );
      const parsed = parseToolResultJson<{ results: Array<{ tiddler_title: string }> }>(result);

      expect(parsed.results).toHaveLength(1);
      expect(parsed.results[0].tiddler_title).toBe('Journal Entry');
    });
  });
});
