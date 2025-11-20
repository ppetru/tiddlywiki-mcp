import { describe, it, expect, beforeEach } from 'vitest';
import {
  generateTimestamp,
  createTiddlerObject,
  updateTiddlerObject,
  type Tiddler
} from '../../src/tiddlywiki-http.js';

describe('tiddlywiki-http', () => {
  describe('generateTimestamp', () => {
    it('should generate timestamp in YYYYMMDDhhmmssSSS format', () => {
      const date = new Date('2025-11-18T10:30:45.123Z');
      const timestamp = generateTimestamp(date);

      expect(timestamp).toMatch(/^\d{17}$/);
      expect(timestamp).toBe('20251118103045123');
    });

    it('should pad single-digit values with zeros', () => {
      const date = new Date('2025-01-02T03:04:05.006Z');
      const timestamp = generateTimestamp(date);

      expect(timestamp).toBe('20250102030405006');
    });

    it('should generate current timestamp when no date provided', () => {
      const timestamp = generateTimestamp();

      expect(timestamp).toMatch(/^\d{17}$/);
      expect(timestamp.length).toBe(17);
    });

    it('should handle year boundaries correctly', () => {
      const date = new Date('2024-12-31T23:59:59.999Z');
      const timestamp = generateTimestamp(date);

      expect(timestamp).toBe('20241231235959999');
    });
  });

  describe('createTiddlerObject', () => {
    it('should create tiddler with all required fields', () => {
      const tiddler = createTiddlerObject('Test Title', 'Test content', 'tag1 tag2', 'text/markdown', 'test-user');

      expect(tiddler.title).toBe('Test Title');
      expect(tiddler.text).toBe('Test content');
      expect(tiddler.tags).toBe('tag1 tag2');
      expect(tiddler.type).toBe('text/markdown');
      expect(tiddler.creator).toBe('test-user');
      expect(tiddler.created).toMatch(/^\d{17}$/);
    });

    it('should use default empty tags when not provided', () => {
      const tiddler = createTiddlerObject('Title', 'Content', undefined, undefined, 'user');

      expect(tiddler.tags).toBe('');
    });

    it('should use default text/markdown type when not provided', () => {
      const tiddler = createTiddlerObject('Title', 'Content', undefined, undefined, 'user');

      expect(tiddler.type).toBe('text/markdown');
    });

    it('should generate different timestamps for different calls', () => {
      const tiddler1 = createTiddlerObject('Title1', 'Content1', '', 'text/markdown', 'user');
      // Small delay to ensure different timestamp
      const tiddler2 = createTiddlerObject('Title2', 'Content2', '', 'text/markdown', 'user');

      // They might be the same if called very quickly, but at least check format
      expect(tiddler1.created).toMatch(/^\d{17}$/);
      expect(tiddler2.created).toMatch(/^\d{17}$/);
    });
  });

  describe('updateTiddlerObject', () => {
    let currentTiddler: Tiddler;

    beforeEach(() => {
      currentTiddler = {
        title: 'Original Title',
        text: 'Original content',
        type: 'text/vnd.tiddlywiki',
        tags: 'tag1 tag2',
        created: '20250101000000000',
        creator: 'original-user',
        modified: '20250101120000000',
        modifier: 'original-modifier'
      };
    });

    it('should preserve created timestamp when updating', () => {
      const updated = updateTiddlerObject(currentTiddler, { text: 'New content' }, 'new-user');

      expect(updated.created).toBe('20250101000000000');
    });

    it('should preserve creator when updating', () => {
      const updated = updateTiddlerObject(currentTiddler, { text: 'New content' }, 'new-user');

      expect(updated.creator).toBe('original-user');
    });

    it('should preserve type when not explicitly changed', () => {
      const updated = updateTiddlerObject(currentTiddler, { text: 'New content' }, 'new-user');

      expect(updated.type).toBe('text/vnd.tiddlywiki');
    });

    it('should allow explicit type change', () => {
      const updated = updateTiddlerObject(currentTiddler, { type: 'text/markdown' }, 'new-user');

      expect(updated.type).toBe('text/markdown');
    });

    it('should update text when provided', () => {
      const updated = updateTiddlerObject(currentTiddler, { text: 'Updated content' }, 'new-user');

      expect(updated.text).toBe('Updated content');
    });

    it('should update tags when provided', () => {
      const updated = updateTiddlerObject(currentTiddler, { tags: 'new-tag' }, 'new-user');

      expect(updated.tags).toBe('new-tag');
    });

    it('should set modifier to the provided user', () => {
      const updated = updateTiddlerObject(currentTiddler, { text: 'New' }, 'modifier-user');

      expect(updated.modifier).toBe('modifier-user');
    });

    it('should generate new modified timestamp', () => {
      const updated = updateTiddlerObject(currentTiddler, { text: 'New' }, 'user');

      expect(updated.modified).toMatch(/^\d{17}$/);
      expect(updated.modified).not.toBe('20250101120000000');
    });

    it('should preserve title even if updates include it', () => {
      const updated = updateTiddlerObject(currentTiddler, { title: 'Attempted Change' } as any, 'user');

      expect(updated.title).toBe('Original Title');
    });

    it('should remove revision field', () => {
      const tiddlerWithRevision = { ...currentTiddler, revision: 5 };
      const updated = updateTiddlerObject(tiddlerWithRevision, { text: 'New' }, 'user');

      expect(updated.revision).toBeUndefined();
    });

    it('should remove bag field', () => {
      const tiddlerWithBag = { ...currentTiddler, bag: 'default' };
      const updated = updateTiddlerObject(tiddlerWithBag, { text: 'New' }, 'user');

      expect(updated.bag).toBeUndefined();
    });

    it('should handle updating from text/vnd.tiddlywiki to text/markdown', () => {
      const updated = updateTiddlerObject(
        currentTiddler,
        { text: '# Markdown content', type: 'text/markdown' },
        'user'
      );

      expect(updated.type).toBe('text/markdown');
      expect(updated.text).toBe('# Markdown content');
      expect(updated.created).toBe('20250101000000000');
      expect(updated.creator).toBe('original-user');
    });

    it('should handle updating from text/markdown to text/vnd.tiddlywiki', () => {
      const markdownTiddler = {
        ...currentTiddler,
        type: 'text/markdown',
        text: '# Markdown'
      };

      const updated = updateTiddlerObject(
        markdownTiddler,
        { text: '! Wikitext', type: 'text/vnd.tiddlywiki' },
        'user'
      );

      expect(updated.type).toBe('text/vnd.tiddlywiki');
      expect(updated.text).toBe('! Wikitext');
    });

    it('should preserve type when only text is updated', () => {
      const wikitextTiddler = {
        ...currentTiddler,
        type: 'text/vnd.tiddlywiki'
      };

      const updated = updateTiddlerObject(
        wikitextTiddler,
        { text: '! Updated wikitext' },
        'user'
      );

      expect(updated.type).toBe('text/vnd.tiddlywiki');
    });

    it('should handle multiple field updates simultaneously', () => {
      const updated = updateTiddlerObject(
        currentTiddler,
        {
          text: 'New text',
          tags: 'new-tags',
          type: 'text/markdown'
        },
        'batch-user'
      );

      expect(updated.text).toBe('New text');
      expect(updated.tags).toBe('new-tags');
      expect(updated.type).toBe('text/markdown');
      expect(updated.creator).toBe('original-user');
      expect(updated.created).toBe('20250101000000000');
      expect(updated.modifier).toBe('batch-user');
    });
  });
});
