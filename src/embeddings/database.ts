// ABOUTME: SQLite database for storing and querying vector embeddings
// ABOUTME: Uses sqlite-vec for efficient similarity search operations

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

export interface EmbeddingMetadata {
  created: string;
  modified: string;
  tags: string;
}

export interface SearchResult {
  tiddler_title: string;
  chunk_id: number;
  chunk_text: string;
  created: string;
  modified: string;
  tags: string;
  distance: number;
}

export interface SyncStatus {
  tiddler_title: string;
  last_modified: string;
  last_indexed: string;
  total_chunks: number;
  status: string;
  error_message: string | null;
}

export class EmbeddingsDB {
  private db: Database.Database;
  private dbPath: string;

  constructor(dbPath: string = process.env.EMBEDDINGS_DB_PATH || './embeddings.db') {
    this.dbPath = dbPath;
    this.db = new Database(dbPath);

    // Load sqlite-vec extension
    sqliteVec.load(this.db);

    // Initialize schema
    this.initSchema();

    // Migrate any existing empty timestamps to sentinel value
    this.migrateEmptyTimestamps();

    // Add status tracking columns if they don't exist
    this.migrateAddStatusColumns();
  }

  private initSchema() {
    // Create vec0 virtual table for embeddings (vectors only)
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS entry_embeddings USING vec0(
        embedding float[768]
      );

      CREATE TABLE IF NOT EXISTS embedding_metadata (
        id INTEGER PRIMARY KEY,
        tiddler_title TEXT NOT NULL,
        chunk_id NOT NULL,
        chunk_text TEXT NOT NULL,
        created TEXT,
        modified TEXT,
        tags TEXT
      );

      CREATE TABLE IF NOT EXISTS sync_status (
        tiddler_title TEXT PRIMARY KEY,
        last_modified TEXT NOT NULL,
        last_indexed TEXT NOT NULL,
        total_chunks INTEGER NOT NULL DEFAULT 1,
        indexed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_sync_status_modified
        ON sync_status(last_modified);

      CREATE INDEX IF NOT EXISTS idx_embedding_metadata_tiddler
        ON embedding_metadata(tiddler_title);
    `);
  }

  /**
   * Migrate existing empty timestamps to sentinel value
   * Fixes infinite re-indexing bug for tiddlers without modified timestamps
   */
  private migrateEmptyTimestamps(): void {
    const MISSING_TIMESTAMP = '00000000000000000';

    const stmt = this.db.prepare(`
      UPDATE sync_status
      SET last_modified = ?
      WHERE last_modified = ''
    `);

    const result = stmt.run(MISSING_TIMESTAMP);

    if (result.changes > 0) {
      console.log(`[DB Migration] Updated ${result.changes} entries with missing timestamps`);
    }
  }

  /**
   * Add status and error_message columns to sync_status table
   * Enables tracking of empty/error tiddlers to prevent infinite re-indexing
   */
  private migrateAddStatusColumns(): void {
    // Check if status column exists
    const tableInfo = this.db.prepare('PRAGMA table_info(sync_status)').all() as Array<{
      name: string;
    }>;
    const hasStatus = tableInfo.some((col) => col.name === 'status');

    if (!hasStatus) {
      console.log('[DB Migration] Adding status and error_message columns to sync_status table');

      this.db.exec(`
        ALTER TABLE sync_status ADD COLUMN status TEXT NOT NULL DEFAULT 'indexed';
        ALTER TABLE sync_status ADD COLUMN error_message TEXT;
      `);

      console.log('[DB Migration] Status columns added successfully');
    }
  }

  insertEmbedding(
    tiddlerTitle: string,
    chunkId: number,
    embedding: number[],
    chunkText: string,
    metadata: EmbeddingMetadata
  ): void {
    const embeddingArray = new Float32Array(embedding);

    // Insert embedding into vec0 table
    const embStmt = this.db.prepare(`
      INSERT INTO entry_embeddings(rowid, embedding)
      VALUES (NULL, ?)
    `);
    const embResult = embStmt.run(Buffer.from(embeddingArray.buffer));
    const rowid = embResult.lastInsertRowid;

    // Insert metadata into regular table with same rowid
    const metaStmt = this.db.prepare(`
      INSERT INTO embedding_metadata(id, tiddler_title, chunk_id, chunk_text, created, modified, tags)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    metaStmt.run(
      rowid,
      tiddlerTitle,
      chunkId,
      chunkText,
      metadata.created,
      metadata.modified,
      metadata.tags
    );
  }

  searchSimilar(queryEmbedding: number[], limit: number = 10): SearchResult[] {
    const embeddingArray = new Float32Array(queryEmbedding);

    const stmt = this.db.prepare(`
      SELECT
        m.tiddler_title,
        m.chunk_id,
        m.chunk_text,
        m.created,
        m.modified,
        m.tags,
        e.distance
      FROM entry_embeddings e
      JOIN embedding_metadata m ON e.rowid = m.id
      WHERE e.embedding MATCH ?
        AND k = ?
    `);

    return stmt.all(Buffer.from(embeddingArray.buffer), limit) as SearchResult[];
  }

  updateSyncStatus(
    tiddlerTitle: string,
    lastModified: string,
    totalChunks: number,
    status: string = 'indexed',
    errorMessage: string | null = null
  ): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO sync_status(tiddler_title, last_modified, last_indexed, total_chunks, status, error_message)
      VALUES (?, ?, datetime('now'), ?, ?, ?)
    `);

    stmt.run(tiddlerTitle, lastModified, totalChunks, status, errorMessage);
  }

  getSyncStatus(tiddlerTitle: string): SyncStatus | null {
    const stmt = this.db.prepare(`
      SELECT tiddler_title, last_modified, last_indexed, total_chunks, status, error_message
      FROM sync_status
      WHERE tiddler_title = ?
    `);

    return stmt.get(tiddlerTitle) as SyncStatus | null;
  }

  getAllSyncStatuses(): SyncStatus[] {
    const stmt = this.db.prepare(`
      SELECT tiddler_title, last_modified, last_indexed, total_chunks, status, error_message
      FROM sync_status
      ORDER BY tiddler_title
    `);

    return stmt.all() as SyncStatus[];
  }

  getUnindexedTiddlers(tiddlerTitles: string[]): string[] {
    if (tiddlerTitles.length === 0) {
      return [];
    }

    const _placeholders = tiddlerTitles.map(() => '?').join(',');
    const stmt = this.db.prepare(`
      SELECT ? as title
      FROM (SELECT ? as title ${tiddlerTitles
        .slice(1)
        .map(() => 'UNION ALL SELECT ?')
        .join(' ')})
      WHERE title NOT IN (SELECT tiddler_title FROM sync_status)
    `);

    const results = stmt.all(...tiddlerTitles) as Array<{ title: string }>;
    return results.map((r) => r.title);
  }

  getOutdatedTiddlers(tiddlersWithModified: Array<{ title: string; modified: string }>): string[] {
    const outdated: string[] = [];

    for (const tiddler of tiddlersWithModified) {
      const syncStatus = this.getSyncStatus(tiddler.title);

      if (!syncStatus || syncStatus.last_modified !== tiddler.modified) {
        outdated.push(tiddler.title);
      }
    }

    return outdated;
  }

  deleteEmbeddingsForTiddler(tiddlerTitle: string): void {
    // Get all rowids for this tiddler from metadata table
    const getRowids = this.db.prepare(`
      SELECT id FROM embedding_metadata WHERE tiddler_title = ?
    `);
    const rows = getRowids.all(tiddlerTitle) as Array<{ id: number }>;

    // Delete from embedding_metadata
    const deleteMetadata = this.db.prepare(`
      DELETE FROM embedding_metadata WHERE tiddler_title = ?
    `);
    deleteMetadata.run(tiddlerTitle);

    // Delete from entry_embeddings using rowids
    if (rows.length > 0) {
      const deleteEmbeddings = this.db.prepare(`
        DELETE FROM entry_embeddings WHERE rowid = ?
      `);
      for (const row of rows) {
        deleteEmbeddings.run(row.id);
      }
    }

    // Delete sync status
    const deleteSyncStatus = this.db.prepare(`
      DELETE FROM sync_status WHERE tiddler_title = ?
    `);
    deleteSyncStatus.run(tiddlerTitle);
  }

  getEmbeddingsCount(): number {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM entry_embeddings
    `);
    const result = stmt.get() as { count: number };
    return result.count;
  }

  getIndexedTiddlersCount(): number {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM sync_status
    `);
    const result = stmt.get() as { count: number };
    return result.count;
  }

  close(): void {
    this.db.close();
  }
}
