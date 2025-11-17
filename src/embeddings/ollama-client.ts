import { encode } from 'gpt-tokenizer';

interface OllamaEmbedResponse {
  model: string;
  embeddings: number[][];
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
}

export class OllamaClient {
  private baseUrl: string;
  private model: string;

  constructor(
    baseUrl: string = 'http://ollama.service.consul:11434',
    model: string = 'nomic-embed-text'
  ) {
    this.baseUrl = baseUrl;
    this.model = model;
  }

  async generateEmbeddings(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    const response = await fetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        input: texts
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Ollama API error (${response.status}): ${errorText}`);
    }

    const data: OllamaEmbedResponse = await response.json();
    return data.embeddings;
  }

  async generateEmbedding(text: string): Promise<number[]> {
    const embeddings = await this.generateEmbeddings([text]);
    return embeddings[0];
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(this.baseUrl, {
        method: 'GET'
      });
      return response.ok;
    } catch (error) {
      console.error('Ollama health check failed:', error);
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
    let currentTokens = 0;

    for (const para of paragraphs) {
      const paraTokens = encode(para);
      const testChunk = currentChunk ? `${currentChunk}\n\n${para}` : para;
      const testTokenCount = encode(testChunk).length;

      // If adding this paragraph would exceed the limit and we have content, save current chunk
      if (testTokenCount > maxTokens && currentChunk) {
        chunks.push(currentChunk.trim());
        currentChunk = para;
        currentTokens = paraTokens.length;
      }
      // If a single paragraph is too large, split it by sentences
      else if (paraTokens.length > maxTokens) {
        // Save any accumulated text first
        if (currentChunk) {
          chunks.push(currentChunk.trim());
          currentChunk = '';
          currentTokens = 0;
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
          currentTokens = encode(sentenceChunk).length;
        }
      }
      // Otherwise, accumulate the paragraph
      else {
        currentChunk = testChunk;
        currentTokens = testTokenCount;
      }
    }

    // Add the final chunk if it exists
    if (currentChunk) {
      chunks.push(currentChunk.trim());
    }

    return chunks.filter(chunk => chunk.length > 0);
  }

  /**
   * Count tokens in text using gpt-tokenizer (approximation for nomic-embed-text)
   */
  countTokens(text: string): number {
    return encode(text).length;
  }
}
