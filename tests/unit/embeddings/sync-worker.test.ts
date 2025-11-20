import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SyncWorker } from '../../../src/embeddings/sync-worker.js';
import { EmbeddingsDB } from '../../../src/embeddings/database.js';
import { OllamaClient } from '../../../src/embeddings/ollama-client.js';
import type { Tiddler } from '../../../src/tiddlywiki-http.js';

// Mock the dependencies
vi.mock('../../../src/tiddlywiki-http.js', () => ({
  queryTiddlers: vi.fn()
}));

describe('SyncWorker - Re-indexing Bug', () => {
  let db: EmbeddingsDB;
  let ollama: OllamaClient;
  let syncWorker: SyncWorker;

  beforeEach(() => {
    // Use in-memory database for tests
    db = new EmbeddingsDB(':memory:');
    ollama = new OllamaClient();
  });

  afterEach(() => {
    if (syncWorker) {
      syncWorker.stop();
    }
    db.close();
  });

  it('should not re-index tiddlers without modified timestamp on subsequent syncs', async () => {
    // Mock a tiddler WITHOUT modified field (like the 140 Index tiddlers)
    const tiddlerWithoutModified: Tiddler = {
      title: 'Index - 2015-12',
      text: 'Month index content',
      created: '20151201000000000',
      tags: 'Index',
      type: 'text/markdown'
      // NOTE: modified field is intentionally missing
    };

    // Mock queryTiddlers to return our test tiddler
    const { queryTiddlers } = await import('../../../src/tiddlywiki-http.js');
    vi.mocked(queryTiddlers).mockResolvedValue([tiddlerWithoutModified]);

    // Mock Ollama client methods
    vi.spyOn(ollama, 'healthCheck').mockResolvedValue(true);
    vi.spyOn(ollama, 'chunkText').mockReturnValue(['Month index content']);
    vi.spyOn(ollama, 'generateEmbeddings').mockResolvedValue([
      Array(768).fill(0.1)
    ]);

    // Create sync worker
    syncWorker = new SyncWorker(db, ollama, {
      syncIntervalMs: 60000,
      batchSize: 5,
      enabled: false // Don't auto-start
    });

    // FIRST SYNC: Index the tiddler
    await syncWorker.forceSync();

    // Verify it was indexed
    let syncStatus = db.getSyncStatus('Index - 2015-12');
    expect(syncStatus).toBeDefined();

    // CRITICAL: Check what timestamp was stored
    // BUG: Before fix, this stores '' (empty string)
    // FIX: After fix, this stores '00000000000000000' (sentinel)
    const storedTimestamp = syncStatus!.last_modified;

    // Clear the mock call history
    vi.mocked(queryTiddlers).mockClear();

    // SECOND SYNC: Should NOT re-index (the bug causes re-indexing here)
    await syncWorker.forceSync();

    // Check if queryTiddlers was called with includeText: true for individual tiddler
    // If it was called with [title[Index - 2015-12]], that means it tried to re-index
    const reIndexCalls = vi.mocked(queryTiddlers).mock.calls.filter(
      call => call[0].includes('[title[Index - 2015-12]]') && call[1] === true
    );

    // ASSERTION: Should NOT have tried to re-index
    // Before fix: reIndexCalls.length > 0 (BUG!)
    // After fix: reIndexCalls.length === 0 (CORRECT!)
    expect(reIndexCalls.length).toBe(0);

    // Verify sync status wasn't changed
    syncStatus = db.getSyncStatus('Index - 2015-12');
    expect(syncStatus!.last_modified).toBe(storedTimestamp);
  });

  it('should use sentinel value for tiddlers without modified field', async () => {
    const SENTINEL = '00000000000000000';

    // Mock a tiddler without modified field
    const tiddler: Tiddler = {
      title: 'Test Tiddler',
      text: 'Content',
      created: '20250101000000000'
      // modified is missing
    };

    const { queryTiddlers } = await import('../../../src/tiddlywiki-http.js');
    vi.mocked(queryTiddlers).mockResolvedValue([tiddler]);

    vi.spyOn(ollama, 'healthCheck').mockResolvedValue(true);
    vi.spyOn(ollama, 'chunkText').mockReturnValue(['Content']);
    vi.spyOn(ollama, 'generateEmbeddings').mockResolvedValue([
      Array(768).fill(0.1)
    ]);

    syncWorker = new SyncWorker(db, ollama, { enabled: false });
    await syncWorker.forceSync();

    const syncStatus = db.getSyncStatus('Test Tiddler');

    // After fix, should store sentinel value instead of empty string
    expect(syncStatus!.last_modified).toBe(SENTINEL);
    expect(syncStatus!.last_modified).not.toBe('');
  });

  it('should handle tiddlers with modified field normally', async () => {
    // Mock a tiddler WITH modified field (normal case)
    const tiddlerWithModified: Tiddler = {
      title: '2025-11-18',
      text: 'Journal entry',
      created: '20251118000000000',
      modified: '20251118120000000', // Has modified field
      tags: 'Journal'
    };

    const { queryTiddlers } = await import('../../../src/tiddlywiki-http.js');
    vi.mocked(queryTiddlers).mockResolvedValue([tiddlerWithModified]);

    vi.spyOn(ollama, 'healthCheck').mockResolvedValue(true);
    vi.spyOn(ollama, 'chunkText').mockReturnValue(['Journal entry']);
    vi.spyOn(ollama, 'generateEmbeddings').mockResolvedValue([
      Array(768).fill(0.1)
    ]);

    syncWorker = new SyncWorker(db, ollama, { enabled: false });
    await syncWorker.forceSync();

    const syncStatus = db.getSyncStatus('2025-11-18');

    // Should store actual modified timestamp
    expect(syncStatus!.last_modified).toBe('20251118120000000');
  });

  it('should filter out filesystem path tiddlers', async () => {
    // Mock tiddlers including filesystem paths (un-imported .tid files)
    const validTiddler: Tiddler = {
      title: '2025-11-18',
      text: 'Journal entry',
      created: '20251118000000000',
      modified: '20251118120000000'
    };

    const filesystemPath1: Tiddler = {
      title: '/data/services/wiki/captainslog/tiddlers/$__StoryList.tid',
      created: '20251118000000000'
    };

    const filesystemPath2: Tiddler = {
      title: '/data/services/wiki/captainslog/tiddlers/$__StoryList_1.tid',
      created: '20251118000000000'
    };

    const { queryTiddlers } = await import('../../../src/tiddlywiki-http.js');
    vi.mocked(queryTiddlers).mockResolvedValue([validTiddler, filesystemPath1, filesystemPath2]);

    vi.spyOn(ollama, 'healthCheck').mockResolvedValue(true);
    vi.spyOn(ollama, 'chunkText').mockReturnValue(['Journal entry']);
    vi.spyOn(ollama, 'generateEmbeddings').mockResolvedValue([
      Array(768).fill(0.1)
    ]);

    syncWorker = new SyncWorker(db, ollama, { enabled: false });
    await syncWorker.forceSync();

    // Only the valid tiddler should be indexed
    expect(db.getSyncStatus('2025-11-18')).toBeDefined();
    expect(db.getSyncStatus('/data/services/wiki/captainslog/tiddlers/$__StoryList.tid')).toBeUndefined();
    expect(db.getSyncStatus('/data/services/wiki/captainslog/tiddlers/$__StoryList_1.tid')).toBeUndefined();

    // Should only have indexed 1 tiddler
    expect(db.getIndexedTiddlersCount()).toBe(1);
  });
});
