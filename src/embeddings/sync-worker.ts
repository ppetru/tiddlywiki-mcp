import { EmbeddingsDB } from './database.js';
import { OllamaClient } from './ollama-client.js';
import { queryTiddlers, Tiddler } from '../tiddlywiki-http.js';

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
      console.log('[SyncWorker] Disabled, not starting');
      return;
    }

    if (this.isRunning) {
      console.log('[SyncWorker] Already running');
      return;
    }

    console.log('[SyncWorker] Starting...');
    this.isRunning = true;

    // Check Ollama health
    const healthy = await this.ollama.healthCheck();
    if (!healthy) {
      console.error('[SyncWorker] Ollama is not healthy, will retry on next sync');
    }

    // Run initial sync (non-blocking)
    this.runSync().catch(error => {
      console.error('[SyncWorker] Initial sync error:', error);
    });

    // Schedule periodic syncs
    this.intervalId = setInterval(() => {
      this.runSync().catch(error => {
        console.error('[SyncWorker] Periodic sync error:', error);
      });
    }, this.config.syncIntervalMs);

    console.log(`[SyncWorker] Started with ${this.config.syncIntervalMs / 1000}s interval`);
  }

  /**
   * Stop the sync worker
   */
  stop(): void {
    if (!this.isRunning) {
      return;
    }

    console.log('[SyncWorker] Stopping...');
    this.isRunning = false;

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    console.log('[SyncWorker] Stopped');
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
      console.log('[SyncWorker] Sync already in progress, skipping');
      return;
    }

    this.isSyncing = true;
    const startTime = Date.now();

    try {
      console.log('[SyncWorker] Starting sync cycle...');

      // Check Ollama health
      const healthy = await this.ollama.healthCheck();
      if (!healthy) {
        console.error('[SyncWorker] Ollama is not available, skipping sync');
        return;
      }

      // Get all tiddlers (excluding system tiddlers)
      const allTiddlers = await queryTiddlers(
        '[!is[system]sort[title]]',
        false // Metadata only for now
      );

      console.log(`[SyncWorker] Found ${allTiddlers.length} total tiddlers`);

      // Determine which tiddlers need indexing
      const tiddlersToIndex: Tiddler[] = [];

      for (const tiddler of allTiddlers) {
        const syncStatus = this.db.getSyncStatus(tiddler.title);

        // Index if never indexed OR if modified timestamp changed
        if (!syncStatus || syncStatus.last_modified !== tiddler.modified) {
          tiddlersToIndex.push(tiddler);
        }
      }

      if (tiddlersToIndex.length === 0) {
        console.log('[SyncWorker] No tiddlers need indexing');
        return;
      }

      console.log(`[SyncWorker] Indexing ${tiddlersToIndex.length} tiddlers...`);

      // Process tiddlers in batches
      let indexed = 0;
      for (let i = 0; i < tiddlersToIndex.length; i += this.config.batchSize) {
        const batch = tiddlersToIndex.slice(i, i + this.config.batchSize);

        await Promise.all(
          batch.map(tiddler => this.indexTiddler(tiddler))
        );

        indexed += batch.length;
        console.log(`[SyncWorker] Progress: ${indexed}/${tiddlersToIndex.length} tiddlers indexed`);
      }

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[SyncWorker] Sync cycle completed in ${duration}s. Indexed ${tiddlersToIndex.length} tiddlers.`);
    } catch (error) {
      console.error('[SyncWorker] Sync cycle error:', error);
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
        console.warn(`[SyncWorker] Tiddler ${tiddlerMetadata.title} has no text, skipping`);
        return;
      }

      // Delete existing embeddings for this tiddler
      this.db.deleteEmbeddingsForTiddler(fullTiddler.title);

      // Chunk the text if needed
      const chunks = this.ollama.chunkText(fullTiddler.text);

      // Generate embeddings for all chunks
      const embeddings = await this.ollama.generateEmbeddings(chunks);

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
        fullTiddler.modified || '',
        chunks.length
      );

      const tokenCount = this.ollama.countTokens(fullTiddler.text);
      console.log(`[SyncWorker] Indexed ${fullTiddler.title} (${tokenCount} tokens, ${chunks.length} chunks)`);
    } catch (error) {
      console.error(`[SyncWorker] Error indexing tiddler ${tiddlerMetadata.title}:`, error);
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
