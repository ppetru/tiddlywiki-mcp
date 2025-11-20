import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EmbeddingsDB } from '../../../src/embeddings/database.js';

describe('EmbeddingsDB', () => {
  let db: EmbeddingsDB;

  beforeEach(() => {
    // Use in-memory database for fast, isolated tests
    db = new EmbeddingsDB(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  describe('insertEmbedding and searchSimilar', () => {
    it('should insert and retrieve embedding', () => {
      const embedding = Array(768).fill(0.1);

      db.insertEmbedding('test-tiddler', 0, embedding, 'test chunk text', {
        created: '20250101000000000',
        modified: '20250101120000000',
        tags: 'tag1 tag2'
      });

      const results = db.searchSimilar(embedding, 5);

      expect(results).toHaveLength(1);
      expect(results[0].tiddler_title).toBe('test-tiddler');
      expect(results[0].chunk_id).toBe(0);
      expect(results[0].created).toBe('20250101000000000');
      expect(results[0].modified).toBe('20250101120000000');
      expect(results[0].tags).toBe('tag1 tag2');
    });

    it('should return results sorted by similarity', () => {
      const embedding1 = Array(768).fill(0.1);
      const embedding2 = Array(768).fill(0.5);
      const embedding3 = Array(768).fill(0.9);

      db.insertEmbedding('tiddler-1', 0, embedding1, 'text 1', {
        created: '20250101000000000',
        modified: '20250101000000000',
        tags: ''
      });
      db.insertEmbedding('tiddler-2', 0, embedding2, 'text 2', {
        created: '20250101000000000',
        modified: '20250101000000000',
        tags: ''
      });
      db.insertEmbedding('tiddler-3', 0, embedding3, 'text 3', {
        created: '20250101000000000',
        modified: '20250101000000000',
        tags: ''
      });

      // Search with query similar to embedding2
      const results = db.searchSimilar(embedding2, 5);

      expect(results).toHaveLength(3);
      // Most similar should be tiddler-2
      expect(results[0].tiddler_title).toBe('tiddler-2');
    });

    it('should limit results to requested count', () => {
      for (let i = 0; i < 10; i++) {
        const embedding = Array(768).fill(i * 0.1);
        db.insertEmbedding(`tiddler-${i}`, 0, embedding, `text ${i}`, {
          created: '20250101000000000',
          modified: '20250101000000000',
          tags: ''
        });
      }

      const results = db.searchSimilar(Array(768).fill(0.5), 3);

      expect(results).toHaveLength(3);
    });

    it('should handle multiple chunks per tiddler', () => {
      const embedding = Array(768).fill(0.1);

      db.insertEmbedding('multi-chunk-tiddler', 0, embedding, 'chunk 0', {
        created: '20250101000000000',
        modified: '20250101000000000',
        tags: ''
      });
      db.insertEmbedding('multi-chunk-tiddler', 1, embedding, 'chunk 1', {
        created: '20250101000000000',
        modified: '20250101000000000',
        tags: ''
      });
      db.insertEmbedding('multi-chunk-tiddler', 2, embedding, 'chunk 2', {
        created: '20250101000000000',
        modified: '20250101000000000',
        tags: ''
      });

      const results = db.searchSimilar(embedding, 10);

      expect(results.length).toBeGreaterThanOrEqual(3);
      const multiChunkResults = results.filter(r => r.tiddler_title === 'multi-chunk-tiddler');
      expect(multiChunkResults).toHaveLength(3);
      expect(multiChunkResults.map(r => r.chunk_id).sort()).toEqual([0, 1, 2]);
    });

    it('should return empty array when no embeddings exist', () => {
      const results = db.searchSimilar(Array(768).fill(0.1), 5);

      expect(results).toHaveLength(0);
    });
  });

  describe('deleteEmbeddingsForTiddler', () => {
    it('should delete all chunks for a tiddler', () => {
      const embedding = Array(768).fill(0.1);

      db.insertEmbedding('tiddler-to-delete', 0, embedding, 'chunk 0', {
        created: '20250101000000000',
        modified: '20250101000000000',
        tags: ''
      });
      db.insertEmbedding('tiddler-to-delete', 1, embedding, 'chunk 1', {
        created: '20250101000000000',
        modified: '20250101000000000',
        tags: ''
      });
      db.insertEmbedding('tiddler-to-keep', 0, embedding, 'keep this', {
        created: '20250101000000000',
        modified: '20250101000000000',
        tags: ''
      });

      db.deleteEmbeddingsForTiddler('tiddler-to-delete');

      const results = db.searchSimilar(embedding, 10);
      const deletedResults = results.filter(r => r.tiddler_title === 'tiddler-to-delete');
      const keptResults = results.filter(r => r.tiddler_title === 'tiddler-to-keep');

      expect(deletedResults).toHaveLength(0);
      expect(keptResults).toHaveLength(1);
    });

    it('should not error when deleting non-existent tiddler', () => {
      expect(() => db.deleteEmbeddingsForTiddler('non-existent')).not.toThrow();
    });
  });

  describe('updateSyncStatus and getSyncStatus', () => {
    it('should store and retrieve sync status', () => {
      db.updateSyncStatus('test-tiddler', '20250101120000000', 3);

      const status = db.getSyncStatus('test-tiddler');

      expect(status).toBeDefined();
      expect(status?.tiddler_title).toBe('test-tiddler');
      expect(status?.last_modified).toBe('20250101120000000');
      expect(status?.total_chunks).toBe(3);
      // SQLite datetime format is 19 characters (YYYY-MM-DD HH:MM:SS)
      expect(status?.last_indexed).toBeDefined();
      expect(typeof status?.last_indexed).toBe('string');
    });

    it('should return undefined for tiddler with no sync status', () => {
      const status = db.getSyncStatus('non-existent');

      // Note: better-sqlite3 returns undefined for no results, not null
      expect(status).toBeUndefined();
    });

    it('should update existing sync status', () => {
      db.updateSyncStatus('test-tiddler', '20250101120000000', 2);
      db.updateSyncStatus('test-tiddler', '20250101130000000', 4);

      const status = db.getSyncStatus('test-tiddler');

      expect(status?.last_modified).toBe('20250101130000000');
      expect(status?.total_chunks).toBe(4);
    });

    it('should track last_indexed timestamp', () => {
      db.updateSyncStatus('test-tiddler', '20250101120000000', 1);

      const status = db.getSyncStatus('test-tiddler');
      expect(status).toBeDefined();
      expect(status?.last_indexed).toBeTruthy();

      // SQLite uses datetime('now') which produces YYYY-MM-DD HH:MM:SS format (19 chars)
      const indexed = status!.last_indexed;
      expect(indexed).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    });

    it('should prevent re-indexing bug by comparing timestamps correctly', () => {
      // This test validates the fix for the sync worker re-indexing bug
      const originalModified = '20250101120000000';

      // Index the tiddler
      db.updateSyncStatus('test-tiddler', originalModified, 1);

      // Retrieve sync status
      const status = db.getSyncStatus('test-tiddler');
      expect(status).toBeDefined();

      // The sync worker should compare: status.last_modified !== tiddler.modified
      // If modified timestamp is the same, should NOT re-index
      const shouldReindex = status!.last_modified !== originalModified;
      expect(shouldReindex).toBe(false);

      // If modified timestamp changed, SHOULD re-index
      const newModified = '20250101130000000';
      const shouldReindexAfterModification = status!.last_modified !== newModified;
      expect(shouldReindexAfterModification).toBe(true);
    });
  });

  describe('getIndexedTiddlersCount', () => {
    it('should return 0 when no tiddlers indexed', () => {
      const count = db.getIndexedTiddlersCount();

      expect(count).toBe(0);
    });

    it('should return count of indexed tiddlers', () => {
      db.updateSyncStatus('tiddler-1', '20250101000000000', 1);
      db.updateSyncStatus('tiddler-2', '20250101000000000', 1);
      db.updateSyncStatus('tiddler-3', '20250101000000000', 1);

      const count = db.getIndexedTiddlersCount();

      expect(count).toBe(3);
    });

    it('should not double-count updated tiddlers', () => {
      db.updateSyncStatus('tiddler-1', '20250101000000000', 1);
      db.updateSyncStatus('tiddler-1', '20250101120000000', 2);

      const count = db.getIndexedTiddlersCount();

      expect(count).toBe(1);
    });
  });

  describe('getEmbeddingsCount', () => {
    it('should return 0 when no embeddings exist', () => {
      const count = db.getEmbeddingsCount();

      expect(count).toBe(0);
    });

    it('should return total number of embedding chunks', () => {
      const embedding = Array(768).fill(0.1);

      db.insertEmbedding('tiddler-1', 0, embedding, 'text', {
        created: '20250101000000000',
        modified: '20250101000000000',
        tags: ''
      });
      db.insertEmbedding('tiddler-2', 0, embedding, 'text', {
        created: '20250101000000000',
        modified: '20250101000000000',
        tags: ''
      });
      db.insertEmbedding('tiddler-2', 1, embedding, 'text', {
        created: '20250101000000000',
        modified: '20250101000000000',
        tags: ''
      });

      const count = db.getEmbeddingsCount();

      expect(count).toBe(3);
    });

    it('should decrease count after deletion', () => {
      const embedding = Array(768).fill(0.1);

      db.insertEmbedding('tiddler-1', 0, embedding, 'text', {
        created: '20250101000000000',
        modified: '20250101000000000',
        tags: ''
      });
      db.insertEmbedding('tiddler-1', 1, embedding, 'text', {
        created: '20250101000000000',
        modified: '20250101000000000',
        tags: ''
      });

      expect(db.getEmbeddingsCount()).toBe(2);

      db.deleteEmbeddingsForTiddler('tiddler-1');

      expect(db.getEmbeddingsCount()).toBe(0);
    });
  });

  describe('database lifecycle', () => {
    it('should create tables on initialization', () => {
      // If tables weren't created, insertions would fail
      expect(() => {
        db.insertEmbedding('test', 0, Array(768).fill(0.1), 'text', {
          created: '20250101000000000',
          modified: '20250101000000000',
          tags: ''
        });
      }).not.toThrow();
    });

    it('should handle close gracefully', () => {
      expect(() => db.close()).not.toThrow();
    });

    it('should be able to create multiple independent databases', () => {
      const db2 = new EmbeddingsDB(':memory:');

      db.updateSyncStatus('db1-tiddler', '20250101000000000', 1);
      db2.updateSyncStatus('db2-tiddler', '20250101000000000', 1);

      expect(db.getSyncStatus('db1-tiddler')).toBeDefined();
      expect(db.getSyncStatus('db2-tiddler')).toBeUndefined();
      expect(db2.getSyncStatus('db2-tiddler')).toBeDefined();
      expect(db2.getSyncStatus('db1-tiddler')).toBeUndefined();

      db2.close();
    });
  });
});
