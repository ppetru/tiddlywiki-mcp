// ABOUTME: Tests for create, update, and delete MCP tool handlers
// ABOUTME: Covers basic operations, custom fields, and error handling

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleCreateTiddler } from '../../src/tools/create-tiddler.js';
import { handleUpdateTiddler } from '../../src/tools/update-tiddler.js';
import { handleDeleteTiddler } from '../../src/tools/delete-tiddler.js';
import { createMockTiddler, parseToolResultJson } from './test-utils.js';
import { loadWritePolicy, setWritePolicy } from '../../src/write-policy.js';

// Mock the tiddlywiki-http module
vi.mock('../../src/tiddlywiki-http.js', () => ({
  getTiddler: vi.fn(),
  putTiddler: vi.fn(),
  deleteTiddler: vi.fn(),
  createTiddlerObject: vi.fn().mockImplementation(
    (title: string, text: string, tags: string, type: string, creator: string) => ({
      title,
      text,
      tags,
      type,
      creator,
      modifier: creator,
      created: '20250101120000000',
      modified: '20250101120000000',
    })
  ),
  updateTiddlerObject: vi.fn().mockImplementation(
    (current: Record<string, unknown>, updates: Record<string, unknown>, modifier: string) => ({
      ...current,
      ...updates,
      modifier,
      modified: '20250101130000000',
    })
  ),
  getAuthUser: vi.fn().mockReturnValue('test-user'),
}));

import {
  getTiddler,
  putTiddler,
  deleteTiddler,
} from '../../src/tiddlywiki-http.js';

const mockGetTiddler = vi.mocked(getTiddler);
const mockPutTiddler = vi.mocked(putTiddler);
const mockDeleteTiddler = vi.mocked(deleteTiddler);

describe('handleCreateTiddler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('input validation', () => {
    it('should reject when title is missing', async () => {
      await expect(
        handleCreateTiddler({ text: 'content' })
      ).rejects.toThrow();
    });

    it('should reject when text is missing', async () => {
      await expect(
        handleCreateTiddler({ title: 'Test' })
      ).rejects.toThrow();
    });
  });

  describe('creation', () => {
    it('should create a new tiddler', async () => {
      mockGetTiddler.mockResolvedValue(null); // No existing tiddler
      mockPutTiddler.mockResolvedValue(undefined);

      const result = await handleCreateTiddler({
        title: 'New Entry',
        text: 'Content here',
      });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Created: "New Entry"');
      expect(mockPutTiddler).toHaveBeenCalled();
    });

    it('should use default type of text/markdown', async () => {
      mockGetTiddler.mockResolvedValue(null);
      mockPutTiddler.mockResolvedValue(undefined);

      await handleCreateTiddler({
        title: 'Test',
        text: 'Content',
      });

      expect(mockPutTiddler).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'text/markdown' })
      );
    });

    it('should include tags when provided', async () => {
      mockGetTiddler.mockResolvedValue(null);
      mockPutTiddler.mockResolvedValue(undefined);

      await handleCreateTiddler({
        title: 'Test',
        text: 'Content',
        tags: 'Journal Important',
      });

      expect(mockPutTiddler).toHaveBeenCalledWith(
        expect.objectContaining({ tags: 'Journal Important' })
      );
    });

    it('should include custom fields', async () => {
      mockGetTiddler.mockResolvedValue(null);
      mockPutTiddler.mockResolvedValue(undefined);

      await handleCreateTiddler({
        title: 'Test',
        text: 'Content',
        caption: 'My Caption',
        author: 'Jane Doe',
      });

      expect(mockPutTiddler).toHaveBeenCalledWith(
        expect.objectContaining({
          caption: 'My Caption',
          author: 'Jane Doe',
        })
      );
    });
  });

  describe('duplicate handling', () => {
    it('should return error when tiddler already exists', async () => {
      mockGetTiddler.mockResolvedValue(createMockTiddler({ title: 'Existing' }));

      const result = await handleCreateTiddler({
        title: 'Existing',
        text: 'New content',
      });
      const parsed = parseToolResultJson<{ error: string }>(result);

      expect(result.isError).toBe(true);
      expect(parsed.error).toContain('already exists');
      expect(mockPutTiddler).not.toHaveBeenCalled();
    });
  });
});

describe('handleUpdateTiddler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('input validation', () => {
    it('should reject when title is missing', async () => {
      await expect(
        handleUpdateTiddler({ text: 'new content' })
      ).rejects.toThrow();
    });
  });

  describe('updating', () => {
    it('should update existing tiddler', async () => {
      const existing = createMockTiddler({ title: 'Test', text: 'Old content' });
      mockGetTiddler.mockResolvedValue(existing);
      mockPutTiddler.mockResolvedValue(undefined);

      const result = await handleUpdateTiddler({
        title: 'Test',
        text: 'New content',
      });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Updated: "Test"');
      expect(mockPutTiddler).toHaveBeenCalled();
    });

    it('should generate diff in response', async () => {
      const existing = createMockTiddler({ text: 'Line 1\nLine 2' });
      mockGetTiddler.mockResolvedValue(existing);
      mockPutTiddler.mockResolvedValue(undefined);

      const result = await handleUpdateTiddler({
        title: 'Test Tiddler',
        text: 'Line 1\nLine 2\nLine 3',
      });

      expect(result.content[0].text).toContain('+1 line');
      expect(result.content[0].text).toContain('diff');
    });

    it('should preserve existing fields when partially updating', async () => {
      const existing = createMockTiddler({
        text: 'Original',
        tags: 'Original Tag',
        type: 'text/markdown',
      });
      mockGetTiddler.mockResolvedValue(existing);
      mockPutTiddler.mockResolvedValue(undefined);

      await handleUpdateTiddler({
        title: 'Test Tiddler',
        text: 'New text only',
      });

      // Should preserve tags and type since they weren't in the update
      expect(mockPutTiddler).toHaveBeenCalledWith(
        expect.objectContaining({
          tags: 'Original Tag',
          type: 'text/markdown',
        })
      );
    });

    it('should update tags when provided', async () => {
      const existing = createMockTiddler({ tags: 'OldTag' });
      mockGetTiddler.mockResolvedValue(existing);
      mockPutTiddler.mockResolvedValue(undefined);

      await handleUpdateTiddler({
        title: 'Test Tiddler',
        tags: 'NewTag',
      });

      expect(mockPutTiddler).toHaveBeenCalledWith(
        expect.objectContaining({ tags: 'NewTag' })
      );
    });

    it('should support custom fields in updates', async () => {
      const existing = createMockTiddler();
      mockGetTiddler.mockResolvedValue(existing);
      mockPutTiddler.mockResolvedValue(undefined);

      await handleUpdateTiddler({
        title: 'Test Tiddler',
        caption: 'New Caption',
      });

      expect(mockPutTiddler).toHaveBeenCalledWith(
        expect.objectContaining({ caption: 'New Caption' })
      );
    });
  });

  describe('error handling', () => {
    it('should return error when tiddler not found', async () => {
      mockGetTiddler.mockResolvedValue(null);

      const result = await handleUpdateTiddler({
        title: 'NonExistent',
        text: 'New content',
      });
      const parsed = parseToolResultJson<{ error: string }>(result);

      expect(result.isError).toBe(true);
      expect(parsed.error).toContain('not found');
      expect(mockPutTiddler).not.toHaveBeenCalled();
    });
  });
});

describe('handleDeleteTiddler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('input validation', () => {
    it('should reject when title is missing', async () => {
      await expect(handleDeleteTiddler({})).rejects.toThrow();
    });
  });

  describe('deletion', () => {
    it('should delete existing tiddler', async () => {
      mockGetTiddler.mockResolvedValue(createMockTiddler({ title: 'ToDelete' }));
      mockDeleteTiddler.mockResolvedValue(undefined);

      const result = await handleDeleteTiddler({ title: 'ToDelete' });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Deleted: "ToDelete"');
      expect(mockDeleteTiddler).toHaveBeenCalledWith('ToDelete');
    });

    it('should show preview of deleted content', async () => {
      mockGetTiddler.mockResolvedValue(
        createMockTiddler({
          title: 'ToDelete',
          text: 'Content to be deleted',
          tags: 'Important',
        })
      );
      mockDeleteTiddler.mockResolvedValue(undefined);

      const result = await handleDeleteTiddler({ title: 'ToDelete' });

      expect(result.content[0].text).toContain('Content to be deleted');
      expect(result.content[0].text).toContain('Important');
    });
  });

  describe('error handling', () => {
    it('should return error when tiddler not found', async () => {
      mockGetTiddler.mockResolvedValue(null);

      const result = await handleDeleteTiddler({ title: 'NonExistent' });
      const parsed = parseToolResultJson<{ error: string }>(result);

      expect(result.isError).toBe(true);
      expect(parsed.error).toContain('not found');
      expect(mockDeleteTiddler).not.toHaveBeenCalled();
    });
  });
});

describe('write policy in handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPutTiddler.mockResolvedValue(undefined);
  });

  afterEach(() => {
    setWritePolicy(loadWritePolicy({}));
  });

  it('should not create code tiddlers by default', async () => {
    mockGetTiddler.mockResolvedValue(null);

    const result = await handleCreateTiddler({
      title: 'Boot',
      text: 'console.log(1)',
      type: 'application/javascript',
      'module-type': 'startup',
    });

    expect(result.isError).toBe(true);
    expect(parseToolResultJson<{ error: string }>(result).error).toContain(
      'UNSAFE_ALLOW_CODE_WRITES'
    );
    expect(mockPutTiddler).not.toHaveBeenCalled();
  });

  it('should not update a tiddler into a code tiddler via nested fields', async () => {
    mockGetTiddler.mockResolvedValue(createMockTiddler());

    const result = await handleUpdateTiddler({
      title: 'Test Tiddler',
      fields: { 'module-type': 'startup' },
    });

    expect(result.isError).toBe(true);
    expect(mockPutTiddler).not.toHaveBeenCalled();
  });

  it.each([
    [
      'nested __proto__',
      '{"title":"P","text":"{}","type":"application/json","fields":{"__proto__":{"plugin-type":"plugin"}}}',
      /Nested/,
    ],
    [
      'whitespace field names',
      '{"title":"P","text":"x","module-type ":"startup","type ":"application/javascript"}',
      /Invalid field name/,
    ],
  ])('should reject a write with %s', async (_label, json, error) => {
    mockGetTiddler.mockResolvedValue(null);

    const result = await handleCreateTiddler(JSON.parse(json));

    expect(result.isError).toBe(true);
    expect(parseToolResultJson<{ error: string }>(result).error).toMatch(error);
    expect(mockPutTiddler).not.toHaveBeenCalled();
  });

  it('should not send a top-level __proto__ to TiddlyWiki', async () => {
    mockGetTiddler.mockResolvedValue(null);

    // Zod's passthrough drops a top-level __proto__ key before the policy sees it
    const result = await handleCreateTiddler(
      JSON.parse('{"title":"P","text":"{}","type":"application/json","__proto__":{"plugin-type":"plugin"}}')
    );

    expect(result.isError).toBeUndefined();
    expect(JSON.stringify(mockPutTiddler.mock.calls[0][0])).not.toMatch(/plugin-type|__proto__/);
  });

  it('should not turn an untagged tiddler into a format whose body sets fields', async () => {
    mockGetTiddler.mockResolvedValue(createMockTiddler({ tags: undefined }));

    const result = await handleUpdateTiddler({
      title: 'Test Tiddler',
      type: 'application/x-tiddler',
      text: 'tags: $:/tags/RawMarkup\n\n<script></script>',
    });

    expect(result.isError).toBe(true);
    expect(mockPutTiddler).not.toHaveBeenCalled();
  });

  it('should not delete code tiddlers by default', async () => {
    mockGetTiddler.mockResolvedValue(
      createMockTiddler({ title: 'Boot', type: 'application/javascript' })
    );

    const result = await handleDeleteTiddler({ title: 'Boot' });

    expect(result.isError).toBe(true);
    expect(mockDeleteTiddler).not.toHaveBeenCalled();
  });

  it('should not delete system tiddlers by default', async () => {
    const result = await handleDeleteTiddler({ title: '$:/config/Something' });

    expect(result.isError).toBe(true);
    expect(mockGetTiddler).not.toHaveBeenCalled();
    expect(mockDeleteTiddler).not.toHaveBeenCalled();
  });

  it('should reject disallowed types', async () => {
    setWritePolicy(loadWritePolicy({ ALLOWED_TYPES: 'text/markdown' }));
    mockGetTiddler.mockResolvedValue(null);

    const result = await handleCreateTiddler({
      title: 'Note',
      text: 'x',
      type: 'text/vnd.tiddlywiki',
    });

    expect(result.isError).toBe(true);
    expect(mockPutTiddler).not.toHaveBeenCalled();
  });

  it('should create ordinary tiddlers', async () => {
    setWritePolicy(loadWritePolicy({ ALLOWED_TYPES: 'text/markdown' }));
    mockGetTiddler.mockResolvedValue(null);

    const result = await handleCreateTiddler({ title: 'Note', text: 'x', tags: 'Concept' });

    expect(result.isError).toBeUndefined();
    expect(mockPutTiddler).toHaveBeenCalledOnce();
  });
});
