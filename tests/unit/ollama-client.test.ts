import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OllamaClient } from '../../src/embeddings/ollama-client.js';

describe('OllamaClient', () => {
  let client: OllamaClient;

  beforeEach(() => {
    client = new OllamaClient();
  });

  describe('chunkText', () => {
    it('should return single chunk for short text', () => {
      const text = 'Short paragraph with a few words.';
      const chunks = client.chunkText(text, 1000);

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toBe(text);
    });

    it('should return single chunk when under token limit', () => {
      const text = 'Paragraph one.\n\nParagraph two.\n\nParagraph three.';
      const chunks = client.chunkText(text, 6000);

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toBe(text);
    });

    it('should split at paragraph boundaries when over limit', () => {
      // Create text with multiple paragraphs that exceeds token limit
      const para1 = 'This is paragraph one. '.repeat(50); // ~150 tokens
      const para2 = 'This is paragraph two. '.repeat(50); // ~150 tokens
      const para3 = 'This is paragraph three. '.repeat(50); // ~150 tokens
      const text = `${para1}\n\n${para2}\n\n${para3}`;

      const chunks = client.chunkText(text, 200); // Force splitting

      expect(chunks.length).toBeGreaterThan(1);
      // Each chunk should not contain double newlines (paragraph breaks)
      chunks.forEach(chunk => {
        expect(chunk).not.toContain('\n\n');
      });
    });

    it('should split oversized paragraphs by sentences', () => {
      // Create a single paragraph that exceeds token limit
      const longSentence = 'This is a sentence with many words. ';
      const longParagraph = longSentence.repeat(200); // ~600 tokens

      const chunks = client.chunkText(longParagraph, 100);

      expect(chunks.length).toBeGreaterThan(1);
      // Verify chunks are smaller than the original
      chunks.forEach(chunk => {
        expect(chunk.length).toBeLessThan(longParagraph.length);
      });
    });

    it('should handle empty text', () => {
      const chunks = client.chunkText('', 1000);

      // Note: Implementation returns [''] for empty input (single empty chunk)
      // This is acceptable since the filter only applies to chunked text
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toBe('');
    });

    it('should handle text with no paragraph breaks', () => {
      const text = 'Single long paragraph without double newlines. '.repeat(100);
      const chunks = client.chunkText(text, 200);

      expect(chunks.length).toBeGreaterThan(0);
      // Should split by sentences when no paragraph breaks
      expect(chunks.length).toBeGreaterThan(1);
    });

    it('should preserve content when chunking', () => {
      const text = 'Para 1.\n\nPara 2.\n\nPara 3.';
      const chunks = client.chunkText(text, 50);

      // Reassemble chunks (with double newlines) and compare
      const reassembled = chunks.join('\n\n');
      // Content should be preserved (may have different spacing)
      expect(reassembled).toContain('Para 1');
      expect(reassembled).toContain('Para 2');
      expect(reassembled).toContain('Para 3');
    });

    it('should trim whitespace from multi-paragraph chunks', () => {
      // When text exceeds token limit and is split into multiple chunks,
      // each chunk is trimmed
      const para1 = 'Paragraph one. '.repeat(50);
      const para2 = 'Paragraph two. '.repeat(50);
      const text = `${para1}\n\n${para2}`;
      const chunks = client.chunkText(text, 200);

      // Should have multiple chunks due to token limit
      expect(chunks.length).toBeGreaterThan(1);
      // Each chunk should be trimmed
      chunks.forEach(chunk => {
        expect(chunk).toBe(chunk.trim());
      });
    });

    it('should filter out empty chunks', () => {
      const text = '\n\n\n\nSome text.\n\n\n\n';
      const chunks = client.chunkText(text, 1000);

      chunks.forEach(chunk => {
        expect(chunk.length).toBeGreaterThan(0);
      });
    });
  });

  describe('countTokens', () => {
    it('should count tokens for simple text', () => {
      const text = 'Hello world';
      const count = client.countTokens(text);

      expect(count).toBeGreaterThan(0);
      expect(typeof count).toBe('number');
    });

    it('should return 0 for empty text', () => {
      const count = client.countTokens('');

      expect(count).toBe(0);
    });

    it('should count more tokens for longer text', () => {
      const shortText = 'Hello';
      const longText = 'Hello world this is a longer sentence with more tokens';

      const shortCount = client.countTokens(shortText);
      const longCount = client.countTokens(longText);

      expect(longCount).toBeGreaterThan(shortCount);
    });
  });

  describe('generateEmbedding', () => {
    it('should call generateEmbeddings and return first result', async () => {
      const mockEmbedding = Array(768).fill(0.1);
      const generateEmbeddingsSpy = vi.spyOn(client, 'generateEmbeddings')
        .mockResolvedValue([mockEmbedding]);

      const result = await client.generateEmbedding('test text');

      expect(generateEmbeddingsSpy).toHaveBeenCalledWith(['test text']);
      expect(result).toEqual(mockEmbedding);
    });
  });

  describe('healthCheck', () => {
    it('should return true when Ollama is healthy', async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: true });

      const healthy = await client.healthCheck();

      expect(healthy).toBe(true);
    });

    it('should return false when Ollama is not responding', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('Connection refused'));

      const healthy = await client.healthCheck();

      expect(healthy).toBe(false);
    });

    it('should return false when Ollama returns error status', async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: false });

      const healthy = await client.healthCheck();

      expect(healthy).toBe(false);
    });
  });
});
