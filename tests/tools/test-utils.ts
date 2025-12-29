// ABOUTME: Test utilities and mock factories for tool handler tests
// ABOUTME: Provides reusable mocks for TiddlyWiki client, embeddings, and Ollama

import { vi } from 'vitest';
import type { Tiddler } from '../../src/tiddlywiki-http.js';
import type { ToolDependencies } from '../../src/tools/types.js';

/**
 * Create a mock tiddler for testing
 */
export function createMockTiddler(overrides: Partial<Tiddler> = {}): Tiddler {
  return {
    title: 'Test Tiddler',
    text: 'Test content',
    tags: 'TestTag',
    type: 'text/markdown',
    created: '20250101120000000',
    modified: '20250101120000000',
    creator: 'test-user',
    modifier: 'test-user',
    ...overrides,
  };
}

/**
 * Create mock tool dependencies with embeddings disabled
 */
export function createMockDepsWithoutEmbeddings(): ToolDependencies {
  return {
    embeddingsDB: null,
    ollamaClient: null,
    syncWorker: null,
  };
}

/**
 * Create mock tool dependencies with embeddings enabled
 */
export function createMockDepsWithEmbeddings(
  overrides: Partial<{
    indexedCount: number;
    searchResults: Array<{
      tiddler_title: string;
      chunk_id: number;
      distance: number;
      created: string;
      modified: string;
      tags: string;
    }>;
    queryEmbedding: number[];
  }> = {}
): ToolDependencies {
  const {
    indexedCount = 10,
    searchResults = [],
    queryEmbedding = new Array(768).fill(0.1),
  } = overrides;

  const mockEmbeddingsDB = {
    getIndexedTiddlersCount: vi.fn().mockReturnValue(indexedCount),
    searchSimilar: vi.fn().mockReturnValue(searchResults),
    insertEmbedding: vi.fn(),
    deleteEmbeddingsForTiddler: vi.fn(),
    updateSyncStatus: vi.fn(),
    getSyncStatus: vi.fn(),
    close: vi.fn(),
  };

  const mockOllamaClient = {
    generateQueryEmbedding: vi.fn().mockResolvedValue(queryEmbedding),
    generateDocumentEmbedding: vi.fn().mockResolvedValue(queryEmbedding),
    generateEmbeddings: vi.fn().mockResolvedValue([queryEmbedding]),
    healthCheck: vi.fn().mockResolvedValue(true),
    splitTextIntoChunks: vi.fn().mockImplementation((text: string) => [text]),
    countTokens: vi.fn().mockReturnValue(100),
  };

  const mockSyncWorker = {
    getStatus: vi.fn().mockReturnValue({
      isRunning: true,
      lastSyncTime: new Date().toISOString(),
      indexedTiddlers: indexedCount,
      totalEmbeddings: indexedCount,
    }),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    syncNow: vi.fn().mockResolvedValue(undefined),
  };

  return {
    embeddingsDB: mockEmbeddingsDB as unknown as ToolDependencies['embeddingsDB'],
    ollamaClient: mockOllamaClient as unknown as ToolDependencies['ollamaClient'],
    syncWorker: mockSyncWorker as unknown as ToolDependencies['syncWorker'],
  };
}

/**
 * Mock the tiddlywiki-http module
 */
export function mockTiddlyWikiHttp() {
  return {
    queryTiddlers: vi.fn(),
    getTiddler: vi.fn(),
    putTiddler: vi.fn(),
    deleteTiddler: vi.fn(),
    createTiddlerObject: vi.fn().mockImplementation(
      (title: string, text: string, tags: string, type: string, creator: string) => ({
        title,
        text,
        tags,
        type,
        creator,
        modifier: creator,
        created: '20250101120000000',
        modified: '20250101120000000',
      })
    ),
    updateTiddlerObject: vi.fn().mockImplementation(
      (current: Tiddler, updates: Partial<Tiddler>, modifier: string) => ({
        ...current,
        ...updates,
        modifier,
        modified: '20250101130000000',
      })
    ),
    getAuthUser: vi.fn().mockReturnValue('test-user'),
    initTiddlyWiki: vi.fn(),
  };
}

/**
 * Parse JSON from a tool result
 */
export function parseToolResultJson<T>(result: { content: Array<{ text: string }> }): T {
  return JSON.parse(result.content[0].text);
}
