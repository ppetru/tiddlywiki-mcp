import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
      title: '/path/to/wiki/tiddlers/$__StoryList.tid',
      created: '20251118000000000',
    };

    const filesystemPath2: Tiddler = {
      title: '/path/to/wiki/tiddlers/$__StoryList_1.tid',
      created: '20251118000000000',
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
    expect(db.getSyncStatus('/path/to/wiki/tiddlers/$__StoryList.tid')).toBeUndefined();
    expect(db.getSyncStatus('/path/to/wiki/tiddlers/$__StoryList_1.tid')).toBeUndefined();

    // Should only have indexed 1 tiddler
    expect(db.getIndexedTiddlersCount()).toBe(1);
  });

  it('should mark empty tiddlers with status="empty" and not re-process them', async () => {
    // Mock an empty tiddler (has title but no text content)
    const emptyTiddler: Tiddler = {
      title: 'Empty Tiddler',
      text: '', // Empty text
      created: '20250101000000000',
      modified: '20250101120000000'
    };

    const { queryTiddlers } = await import('../../../src/tiddlywiki-http.js');
    vi.mocked(queryTiddlers).mockResolvedValue([emptyTiddler]);

    vi.spyOn(ollama, 'healthCheck').mockResolvedValue(true);

    syncWorker = new SyncWorker(db, ollama, { enabled: false });

    // FIRST SYNC: Should mark as empty
    await syncWorker.forceSync();

    // Verify it was marked as empty
    const syncStatus = db.getSyncStatus('Empty Tiddler');
    expect(syncStatus).toBeDefined();
    expect(syncStatus!.status).toBe('empty');
    expect(syncStatus!.total_chunks).toBe(0);

    // Clear mock history
    vi.mocked(queryTiddlers).mockClear();

    // SECOND SYNC: Should NOT re-process the empty tiddler
    await syncWorker.forceSync();

    // Verify it wasn't re-indexed (no calls to fetch full content)
    const reIndexCalls = vi.mocked(queryTiddlers).mock.calls.filter(
      call => call[0].includes('[title[Empty Tiddler]]') && call[1] === true
    );
    expect(reIndexCalls.length).toBe(0);
  });

  it('should re-index empty tiddlers if modified timestamp changes', async () => {
    // Start with empty tiddler
    const emptyTiddler: Tiddler = {
      title: 'Empty Tiddler',
      text: '',
      created: '20250101000000000',
      modified: '20250101120000000'
    };

    const { queryTiddlers } = await import('../../../src/tiddlywiki-http.js');
    vi.mocked(queryTiddlers).mockResolvedValue([emptyTiddler]);

    vi.spyOn(ollama, 'healthCheck').mockResolvedValue(true);

    syncWorker = new SyncWorker(db, ollama, { enabled: false });

    // FIRST SYNC: Mark as empty
    await syncWorker.forceSync();

    const firstStatus = db.getSyncStatus('Empty Tiddler');
    expect(firstStatus!.status).toBe('empty');
    expect(firstStatus!.last_modified).toBe('20250101120000000');

    // Update tiddler with new content and modified timestamp
    const updatedTiddler: Tiddler = {
      title: 'Empty Tiddler',
      text: 'Now has content!',
      created: '20250101000000000',
      modified: '20250102120000000' // Changed timestamp
    };

    vi.mocked(queryTiddlers).mockResolvedValue([updatedTiddler]);
    vi.spyOn(ollama, 'chunkText').mockReturnValue(['Now has content!']);
    vi.spyOn(ollama, 'generateEmbeddings').mockResolvedValue([
      Array(768).fill(0.1)
    ]);

    // SECOND SYNC: Should re-index because modified changed
    await syncWorker.forceSync();

    const secondStatus = db.getSyncStatus('Empty Tiddler');
    expect(secondStatus!.status).toBe('indexed');
    expect(secondStatus!.last_modified).toBe('20250102120000000');
    expect(secondStatus!.total_chunks).toBe(1);
  });

  it('should mark tiddlers with status="error" when embedding generation fails', async () => {
    // Mock a large tiddler that will cause Ollama API error
    const largeTiddler: Tiddler = {
      title: 'Oversized Tiddler',
      text: 'Very large content that exceeds context window...',
      created: '20250101000000000',
      modified: '20250101120000000'
    };

    const { queryTiddlers } = await import('../../../src/tiddlywiki-http.js');
    vi.mocked(queryTiddlers).mockResolvedValue([largeTiddler]);

    vi.spyOn(ollama, 'healthCheck').mockResolvedValue(true);
    vi.spyOn(ollama, 'chunkText').mockReturnValue(['Very large content that exceeds context window...']);

    // Mock Ollama API error (context length exceeded)
    vi.spyOn(ollama, 'generateDocumentEmbeddings').mockRejectedValue(
      new Error('Ollama API error (400): {"error":"the input length exceeds the context length"}')
    );

    syncWorker = new SyncWorker(db, ollama, { enabled: false });

    // FIRST SYNC: Should mark as error
    await syncWorker.forceSync();

    // Verify it was marked as error
    const syncStatus = db.getSyncStatus('Oversized Tiddler');
    expect(syncStatus).toBeDefined();
    expect(syncStatus!.status).toBe('error');
    expect(syncStatus!.error_message).toContain('input length exceeds');
    expect(syncStatus!.total_chunks).toBe(0);

    // Clear mock history
    vi.mocked(queryTiddlers).mockClear();

    // SECOND SYNC (immediately after): Should NOT retry yet (24h not passed)
    await syncWorker.forceSync();

    // Verify it wasn't re-indexed
    const reIndexCalls = vi.mocked(queryTiddlers).mock.calls.filter(
      call => call[0].includes('[title[Oversized Tiddler]]') && call[1] === true
    );
    expect(reIndexCalls.length).toBe(0);
  });

  it('should retry error tiddlers after 24 hours', async () => {
    // Manually create a sync status entry with error from 25 hours ago
    const RETRY_ERROR_AFTER_MS = 24 * 60 * 60 * 1000;
    const twentyFiveHoursAgo = new Date(Date.now() - RETRY_ERROR_AFTER_MS - 3600000);

    // Insert old error status directly into DB
    db.updateSyncStatus(
      'Old Error Tiddler',
      '20250101120000000',
      0,
      'error',
      'Previous error message'
    );

    // Manually update the last_indexed timestamp to 25 hours ago
    // (normally we'd use time-travel, but for this test we'll hack the DB)
    const updateStmt = db['db'].prepare(`
      UPDATE sync_status
      SET last_indexed = datetime(?, 'unixepoch')
      WHERE tiddler_title = ?
    `);
    updateStmt.run(Math.floor(twentyFiveHoursAgo.getTime() / 1000), 'Old Error Tiddler');

    // Mock the tiddler in TiddlyWiki (now it will succeed)
    const tiddler: Tiddler = {
      title: 'Old Error Tiddler',
      text: 'Content that now works',
      created: '20250101000000000',
      modified: '20250101120000000' // Same timestamp as before
    };

    const { queryTiddlers } = await import('../../../src/tiddlywiki-http.js');
    vi.mocked(queryTiddlers).mockResolvedValue([tiddler]);

    vi.spyOn(ollama, 'healthCheck').mockResolvedValue(true);
    vi.spyOn(ollama, 'chunkText').mockReturnValue(['Content that now works']);
    vi.spyOn(ollama, 'generateDocumentEmbeddings').mockResolvedValue([
      Array(768).fill(0.1)
    ]);

    syncWorker = new SyncWorker(db, ollama, { enabled: false });

    // SYNC: Should retry because >24h since last error
    await syncWorker.forceSync();

    // Verify it was re-indexed and marked as successful
    const syncStatus = db.getSyncStatus('Old Error Tiddler');
    expect(syncStatus!.status).toBe('indexed');
    expect(syncStatus!.error_message).toBeNull();
    expect(syncStatus!.total_chunks).toBe(1);
  });
});
