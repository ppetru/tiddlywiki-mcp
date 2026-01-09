// ABOUTME: Client for Ollama API to generate text embeddings
// ABOUTME: Handles chunking, token counting, and health checks

import { encode } from 'gpt-tokenizer';
import * as logger from '../logger.js';
import { getServiceUrl } from '../service-discovery.js';

// Timeout configuration (in milliseconds)
const TIMEOUT_EMBEDDINGS = 120000; // 120 seconds for embeddings (can be slow)
const TIMEOUT_HEALTH = 10000; // 10 seconds for health check

interface OllamaEmbedResponse {
  model: string;
  embeddings: number[][];
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
}

/**
 * Fetch with timeout using AbortController
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number,
  operationName: string
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    logger.warn(`[Ollama] ${operationName} timed out after ${timeoutMs}ms`);
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`${operationName} timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

export class OllamaClient {
  private serviceUrl: string;
  private model: string;
  private resolvedBaseUrl: string | null = null;

  constructor(
    serviceUrl: string = process.env.OLLAMA_URL || 'http://localhost:11434',
    model: string = process.env.OLLAMA_MODEL || 'nomic-embed-text'
  ) {
    this.serviceUrl = serviceUrl;
    this.model = model;
  }

  /**
   * Get the resolved base URL, using service discovery if needed.
   * Caches the result for subsequent calls.
   */
  private async getBaseUrl(): Promise<string> {
    if (this.resolvedBaseUrl) {
      return this.resolvedBaseUrl;
    }
    this.resolvedBaseUrl = await getServiceUrl(this.serviceUrl, '');
    return this.resolvedBaseUrl;
  }

  async generateEmbeddings(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    const baseUrl = await this.getBaseUrl();
    logger.debug(`[Ollama] generateEmbeddings: ${texts.length} text(s)`);

    const response = await fetchWithTimeout(
      `${baseUrl}/api/embed`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          input: texts,
        }),
      },
      TIMEOUT_EMBEDDINGS,
      `generateEmbeddings(${texts.length} texts)`
    );

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(`[Ollama] generateEmbeddings failed: ${response.status} - ${errorText}`);
      throw new Error(`Ollama API error (${response.status}): ${errorText}`);
    }

    const data: OllamaEmbedResponse = await response.json();
    logger.debug(`[Ollama] generateEmbeddings: OK (${data.embeddings.length} embeddings)`);
    return data.embeddings;
  }

  async generateEmbedding(text: string): Promise<number[]> {
    const embeddings = await this.generateEmbeddings([text]);
    return embeddings[0];
  }

  /**
   * Generate embedding for a document with proper task prefix.
   * Uses "search_document:" prefix as required by nomic-embed-text for RAG.
   */
  async generateDocumentEmbedding(text: string): Promise<number[]> {
    const prefixedText = `search_document: ${text}`;
    return this.generateEmbedding(prefixedText);
  }

  /**
   * Generate embeddings for multiple documents with proper task prefix.
   * Uses "search_document:" prefix as required by nomic-embed-text for RAG.
   */
  async generateDocumentEmbeddings(texts: string[]): Promise<number[][]> {
    const prefixedTexts = texts.map((text) => `search_document: ${text}`);
    return this.generateEmbeddings(prefixedTexts);
  }

  /**
   * Generate embedding for a query with proper task prefix.
   * Uses "search_query:" prefix as required by nomic-embed-text for RAG.
   */
  async generateQueryEmbedding(text: string): Promise<number[]> {
    const prefixedText = `search_query: ${text}`;
    return this.generateEmbedding(prefixedText);
  }

  async healthCheck(): Promise<boolean> {
    try {
      const baseUrl = await this.getBaseUrl();
      logger.debug(`[Ollama] healthCheck: ${baseUrl}`);

      const response = await fetchWithTimeout(
        baseUrl,
        { method: 'GET' },
        TIMEOUT_HEALTH,
        'healthCheck'
      );

      logger.debug(`[Ollama] healthCheck: ${response.ok ? 'OK' : 'FAILED'} (${response.status})`);
      return response.ok;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error(`[Ollama] healthCheck failed: ${errMsg}`);
      return false;
    }
  }

  /**
   * Chunk text if it exceeds token limit.
   * Splits at paragraph boundaries to maintain semantic coherence.
   */
  chunkText(text: string, maxTokens: number = 6000): string[] {
    const tokens = encode(text);

    // If text fits in one chunk, return as-is
    if (tokens.length <= maxTokens) {
      return [text];
    }

    // Split at paragraph boundaries (double newline)
    const paragraphs = text.split(/\n\n+/);
    const chunks: string[] = [];
    let currentChunk = '';
    let _currentTokens = 0;

    for (const para of paragraphs) {
      const paraTokens = encode(para);
      const testChunk = currentChunk ? `${currentChunk}\n\n${para}` : para;
      const testTokenCount = encode(testChunk).length;

      // If adding this paragraph would exceed the limit and we have content, save current chunk
      if (testTokenCount > maxTokens && currentChunk) {
        chunks.push(currentChunk.trim());
        currentChunk = para;
        _currentTokens = paraTokens.length;
      }
      // If a single paragraph is too large, split it by sentences
      else if (paraTokens.length > maxTokens) {
        // Save any accumulated text first
        if (currentChunk) {
          chunks.push(currentChunk.trim());
          currentChunk = '';
          _currentTokens = 0;
        }

        // Split large paragraph by sentences
        const sentences = para.split(/[.!?]+\s+/);
        let sentenceChunk = '';

        for (const sentence of sentences) {
          const sentenceWithPunctuation = sentence + (sentence.match(/[.!?]$/) ? '' : '.');
          const testSentenceChunk = sentenceChunk
            ? `${sentenceChunk} ${sentenceWithPunctuation}`
            : sentenceWithPunctuation;
          const sentenceTokenCount = encode(testSentenceChunk).length;

          if (sentenceTokenCount > maxTokens && sentenceChunk) {
            chunks.push(sentenceChunk.trim());
            sentenceChunk = sentenceWithPunctuation;
          } else {
            sentenceChunk = testSentenceChunk;
          }
        }

        if (sentenceChunk) {
          currentChunk = sentenceChunk;
          _currentTokens = encode(sentenceChunk).length;
        }
      }
      // Otherwise, accumulate the paragraph
      else {
        currentChunk = testChunk;
        _currentTokens = testTokenCount;
      }
    }

    // Add the final chunk if it exists
    if (currentChunk) {
      chunks.push(currentChunk.trim());
    }

    return chunks.filter((chunk) => chunk.length > 0);
  }

  /**
   * Count tokens in text using gpt-tokenizer (approximation for nomic-embed-text)
   */
  countTokens(text: string): number {
    return encode(text).length;
  }
}
