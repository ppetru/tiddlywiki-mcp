import { EmbeddingsDB } from './database.js';
import { OllamaClient } from './ollama-client.js';
import { queryTiddlers, Tiddler } from '../tiddlywiki-http.js';
import * as logger from '../logger.js';

// Sentinel value for tiddlers without modified timestamp
// Prevents infinite re-indexing loop for tiddlers that don't track modifications
const MISSING_TIMESTAMP = '00000000000000000';

export interface SyncWorkerConfig {
  syncIntervalMs: number; // How often to check for updates (default: 5 min)
  batchSize: number; // Number of tiddlers to process in parallel (default: 5)
  enabled: boolean; // Whether sync worker is enabled
}

export class SyncWorker {
  private db: EmbeddingsDB;
  private ollama: OllamaClient;
  private config: SyncWorkerConfig;
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;
  private isSyncing: boolean = false;

  constructor(
    db: EmbeddingsDB,
    ollama: OllamaClient,
    config: Partial<SyncWorkerConfig> = {}
  ) {
    this.db = db;
    this.ollama = ollama;
    this.config = {
      syncIntervalMs: config.syncIntervalMs || 5 * 60 * 1000, // 5 minutes
      batchSize: config.batchSize || 5,
      enabled: config.enabled ?? true
    };
  }

  /**
   * Start the sync worker
   */
  async start(): Promise<void> {
    if (!this.config.enabled) {
      logger.log('[SyncWorker] Disabled, not starting');
      return;
    }

    if (this.isRunning) {
      logger.log('[SyncWorker] Already running');
      return;
    }

    logger.log('[SyncWorker] Starting...');
    this.isRunning = true;

    // Check Ollama health
    const healthy = await this.ollama.healthCheck();
    if (!healthy) {
      logger.error('[SyncWorker] Ollama is not healthy, will retry on next sync');
    }

    // Run initial sync (non-blocking)
    this.runSync().catch(error => {
      logger.error('[SyncWorker] Initial sync error:', error);
    });

    // Schedule periodic syncs
    this.intervalId = setInterval(() => {
      this.runSync().catch(error => {
        logger.error('[SyncWorker] Periodic sync error:', error);
      });
    }, this.config.syncIntervalMs);

    logger.log(`[SyncWorker] Started with ${this.config.syncIntervalMs / 1000}s interval`);
  }

  /**
   * Stop the sync worker
   */
  stop(): void {
    if (!this.isRunning) {
      return;
    }

    logger.log('[SyncWorker] Stopping...');
    this.isRunning = false;

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    logger.log('[SyncWorker] Stopped');
  }

  /**
   * Get sync worker status
   */
  getStatus() {
    return {
      running: this.isRunning,
      syncing: this.isSyncing,
      indexedTiddlers: this.db.getIndexedTiddlersCount(),
      totalEmbeddings: this.db.getEmbeddingsCount(),
      syncInterval: this.config.syncIntervalMs / 1000,
      enabled: this.config.enabled
    };
  }

  /**
   * Run a sync cycle
   */
  private async runSync(): Promise<void> {
    if (this.isSyncing) {
      logger.log('[SyncWorker] Sync already in progress, skipping');
      return;
    }

    this.isSyncing = true;
    const startTime = Date.now();

    try {
      logger.log('[SyncWorker] Starting sync cycle...');

      // Check Ollama health
      const healthy = await this.ollama.healthCheck();
      if (!healthy) {
        logger.error('[SyncWorker] Ollama is not available, skipping sync');
        return;
      }

      // Get all tiddlers (excluding system tiddlers)
      const allTiddlers = await queryTiddlers(
        '[!is[system]sort[title]]',
        false // Only need metadata for comparison
      );

      // Filter out filesystem paths (un-imported .tid files)
      // Real tiddler titles don't contain full filesystem paths
      const validTiddlers = allTiddlers.filter(t =>
        !t.title.startsWith('/') && !t.title.includes('.tid')
      );

      logger.log(`[SyncWorker] Found ${validTiddlers.length} total tiddlers (${allTiddlers.length - validTiddlers.length} filesystem paths filtered)`);

      // Determine which tiddlers need indexing
      const tiddlersToIndex: Tiddler[] = [];

      for (const tiddler of validTiddlers) {
        const syncStatus = this.db.getSyncStatus(tiddler.title);

        // Normalize undefined modified to sentinel value for consistent comparison
        const tiddlerModified = tiddler.modified || MISSING_TIMESTAMP;

        // Index if never indexed OR if modified timestamp changed
        if (!syncStatus || syncStatus.last_modified !== tiddlerModified) {
          // Debug logging
          if (syncStatus) {
            logger.log(`[SyncWorker] Re-indexing ${tiddler.title}: stored="${syncStatus.last_modified}" vs current="${tiddlerModified}"`);
          } else {
            logger.log(`[SyncWorker] Indexing NEW tiddler: ${tiddler.title} (modified: ${tiddlerModified})`);
          }
          tiddlersToIndex.push(tiddler);
        }
      }

      if (tiddlersToIndex.length === 0) {
        logger.log('[SyncWorker] No tiddlers need indexing');
        return;
      }

      logger.log(`[SyncWorker] Indexing ${tiddlersToIndex.length} tiddlers...`);

      // Process tiddlers in batches
      let indexed = 0;
      for (let i = 0; i < tiddlersToIndex.length; i += this.config.batchSize) {
        const batch = tiddlersToIndex.slice(i, i + this.config.batchSize);

        await Promise.all(
          batch.map(tiddler => this.indexTiddler(tiddler))
        );

        indexed += batch.length;
        logger.log(`[SyncWorker] Progress: ${indexed}/${tiddlersToIndex.length} tiddlers indexed`);
      }

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      logger.log(`[SyncWorker] Sync cycle completed in ${duration}s. Indexed ${tiddlersToIndex.length} tiddlers.`);
    } catch (error) {
      logger.error('[SyncWorker] Sync cycle error:', error);
      throw error;
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Index a single tiddler
   */
  private async indexTiddler(tiddlerMetadata: Tiddler): Promise<void> {
    try {
      // Fetch full tiddler content
      const [fullTiddler] = await queryTiddlers(
        `[title[${tiddlerMetadata.title}]]`,
        true // Include text
      );

      if (!fullTiddler || !fullTiddler.text) {
        logger.warn(`[SyncWorker] Tiddler ${tiddlerMetadata.title} has no text, skipping`);
        return;
      }

      // Delete existing embeddings for this tiddler
      this.db.deleteEmbeddingsForTiddler(fullTiddler.title);

      // Chunk the text if needed
      const chunks = this.ollama.chunkText(fullTiddler.text);

      // Generate embeddings for all chunks with search_document prefix
      const embeddings = await this.ollama.generateDocumentEmbeddings(chunks);

      // Store embeddings
      for (let i = 0; i < chunks.length; i++) {
        this.db.insertEmbedding(
          fullTiddler.title,
          i, // chunk_id
          embeddings[i],
          chunks[i],
          {
            created: fullTiddler.created || '',
            modified: fullTiddler.modified || '',
            tags: fullTiddler.tags || ''
          }
        );
      }

      // Update sync status
      this.db.updateSyncStatus(
        fullTiddler.title,
        fullTiddler.modified || MISSING_TIMESTAMP,
        chunks.length
      );

      const tokenCount = this.ollama.countTokens(fullTiddler.text);
      logger.log(`[SyncWorker] Indexed ${fullTiddler.title} (${tokenCount} tokens, ${chunks.length} chunks)`);
    } catch (error) {
      logger.error(`[SyncWorker] Error indexing tiddler ${tiddlerMetadata.title}:`, error);
      throw error;
    }
  }

  /**
   * Force a sync cycle (for manual triggering)
   */
  async forceSync(): Promise<void> {
    await this.runSync();
  }
}
