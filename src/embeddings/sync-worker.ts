// ABOUTME: Background worker that syncs tiddler content to vector embeddings
// ABOUTME: Periodically checks for changes and updates the embeddings database

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

  constructor(db: EmbeddingsDB, ollama: OllamaClient, config: Partial<SyncWorkerConfig> = {}) {
    this.db = db;
    this.ollama = ollama;
    this.config = {
      syncIntervalMs: config.syncIntervalMs || 5 * 60 * 1000, // 5 minutes
      batchSize: config.batchSize || 5,
      enabled: config.enabled ?? true,
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
    this.runSync().catch((error) => {
      logger.error('[SyncWorker] Initial sync error:', error);
    });

    // Schedule periodic syncs
    this.intervalId = setInterval(() => {
      this.runSync().catch((error) => {
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
      enabled: this.config.enabled,
    };
  }

  /**
   * Run a sync cycle
   */
  private async runSync(): Promise<void> {
    if (this.isSyncing) {
      logger.debug('[SyncWorker] Sync already in progress, skipping');
      return;
    }

    this.isSyncing = true;
    const startTime = Date.now();

    try {
      logger.debug('[SyncWorker] Starting sync cycle...');

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
      const validTiddlers = allTiddlers.filter(
        (t) => !t.title.startsWith('/') && !t.title.includes('.tid')
      );

      logger.debug(
        `[SyncWorker] Found ${validTiddlers.length} total tiddlers (${allTiddlers.length - validTiddlers.length} filesystem paths filtered)`
      );

      // Determine which tiddlers need indexing
      const tiddlersToIndex: Tiddler[] = [];
      const RETRY_ERROR_AFTER_MS = 24 * 60 * 60 * 1000; // 24 hours

      for (const tiddler of validTiddlers) {
        const syncStatus = this.db.getSyncStatus(tiddler.title);

        // Normalize undefined modified to sentinel value for consistent comparison
        const tiddlerModified = tiddler.modified || MISSING_TIMESTAMP;

        // Decision logic for whether to index this tiddler
        let shouldIndex = false;
        let reason = '';

        if (!syncStatus) {
          // Never indexed before
          shouldIndex = true;
          reason = 'NEW tiddler';
        } else if (syncStatus.last_modified !== tiddlerModified) {
          // Modified timestamp changed - always re-index
          shouldIndex = true;
          reason = `modified timestamp changed (stored="${syncStatus.last_modified}" vs current="${tiddlerModified}")`;
        } else if (syncStatus.status === 'error') {
          // For error status, retry after 24 hours
          const lastIndexedTime = new Date(syncStatus.last_indexed).getTime();
          const now = Date.now();
          const timeSinceError = now - lastIndexedTime;

          if (timeSinceError > RETRY_ERROR_AFTER_MS) {
            shouldIndex = true;
            reason = `retrying after error (${(timeSinceError / (1000 * 60 * 60)).toFixed(1)}h since last attempt)`;
          }
        }
        // Note: Empty tiddlers (status='empty') are only re-indexed if modified timestamp changes (handled above)
        // Successful tiddlers (status='indexed') are only re-indexed if modified timestamp changes (handled above)

        if (shouldIndex) {
          logger.debug(`[SyncWorker] Queuing ${tiddler.title}: ${reason}`);
          tiddlersToIndex.push(tiddler);
        }
      }

      if (tiddlersToIndex.length === 0) {
        logger.debug('[SyncWorker] No tiddlers need indexing');
        return;
      }

      logger.debug(`[SyncWorker] Indexing ${tiddlersToIndex.length} tiddlers...`);

      // Process tiddlers in batches and track results
      const stats = {
        indexed: 0,
        empty: 0,
        error: 0,
      };

      for (let i = 0; i < tiddlersToIndex.length; i += this.config.batchSize) {
        const batch = tiddlersToIndex.slice(i, i + this.config.batchSize);

        const results = await Promise.all(batch.map((tiddler) => this.indexTiddler(tiddler)));

        // Count results by status
        for (const status of results) {
          if (status === 'indexed') stats.indexed++;
          else if (status === 'empty') stats.empty++;
          else if (status === 'error') stats.error++;
        }

        const processed = i + batch.length;
        logger.debug(
          `[SyncWorker] Progress: ${processed}/${tiddlersToIndex.length} tiddlers processed`
        );
      }

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      logger.log(
        `[SyncWorker] Sync cycle completed in ${duration}s. Results: ${stats.indexed} indexed, ${stats.empty} empty, ${stats.error} errors`
      );
    } catch (error) {
      logger.error('[SyncWorker] Sync cycle error:', error);
      throw error;
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Index a single tiddler
   * Returns status: 'indexed', 'empty', or 'error'
   */
  private async indexTiddler(tiddlerMetadata: Tiddler): Promise<string> {
    try {
      // Fetch full tiddler content
      const [fullTiddler] = await queryTiddlers(
        `[title[${tiddlerMetadata.title}]]`,
        true // Include text
      );

      if (!fullTiddler || !fullTiddler.text) {
        logger.warn(
          `[SyncWorker] Tiddler ${tiddlerMetadata.title} has no text, marking as empty to avoid re-processing`
        );

        // Mark as empty to prevent re-indexing on every sync cycle
        this.db.updateSyncStatus(
          tiddlerMetadata.title,
          tiddlerMetadata.modified || MISSING_TIMESTAMP,
          0, // No chunks
          'empty',
          null
        );

        return 'empty';
      }

      // Delete existing embeddings for this tiddler
      this.db.deleteEmbeddingsForTiddler(fullTiddler.title);

      // Chunk the text if needed
      const chunks = this.ollama.chunkText(fullTiddler.text);

      try {
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
              tags: fullTiddler.tags || '',
            }
          );
        }

        // Update sync status with success
        this.db.updateSyncStatus(
          fullTiddler.title,
          fullTiddler.modified || MISSING_TIMESTAMP,
          chunks.length,
          'indexed',
          null
        );

        const tokenCount = this.ollama.countTokens(fullTiddler.text);
        logger.debug(
          `[SyncWorker] Indexed ${fullTiddler.title} (${tokenCount} tokens, ${chunks.length} chunks)`
        );

        return 'indexed';
      } catch (embeddingError) {
        // Handle Ollama API errors (e.g., context length exceeded)
        const errorMessage =
          embeddingError instanceof Error ? embeddingError.message : String(embeddingError);
        logger.error(
          `[SyncWorker] Failed to generate embeddings for ${fullTiddler.title}: ${errorMessage}`
        );

        // Mark as error to prevent infinite retry loop
        this.db.updateSyncStatus(
          fullTiddler.title,
          fullTiddler.modified || MISSING_TIMESTAMP,
          0, // No chunks successfully stored
          'error',
          errorMessage
        );

        // Don't re-throw - continue processing other tiddlers
        return 'error';
      }
    } catch (error) {
      logger.error(`[SyncWorker] Error indexing tiddler ${tiddlerMetadata.title}:`, error);
      // Return error status instead of throwing to allow batch processing to continue
      return 'error';
    }
  }

  /**
   * Force a sync cycle (for manual triggering)
   */
  async forceSync(): Promise<void> {
    await this.runSync();
  }
}
