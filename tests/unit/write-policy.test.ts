// ABOUTME: Tests for the configurable write policy
// ABOUTME: Covers env parsing, tool permissions, type restriction and code-write blocking

import { describe, it, expect, afterEach } from 'vitest';
import {
  checkDelete,
  checkWrite,
  ineffectiveAllowedTypes,
  isToolAllowed,
  loadWritePolicy,
  setWritePolicy,
  type WritePolicy,
} from '../../src/write-policy.js';

const DEFAULT_POLICY: WritePolicy = loadWritePolicy({});

describe('write-policy', () => {
  afterEach(() => {
    setWritePolicy(DEFAULT_POLICY);
  });

  describe('loadWritePolicy', () => {
    it('should allow all tools and types but no code writes by default', () => {
      const policy = loadWritePolicy({});

      expect([...policy.permissions]).toEqual(['read', 'create', 'update', 'delete']);
      expect(policy.allowedTypes).toBeNull();
      expect(policy.allowCodeWrites).toBe(false);
    });

    it('should parse comma-separated lists', () => {
      const policy = loadWritePolicy({
        PERMISSIONS: ' Read, create ',
        ALLOWED_TYPES: 'text/markdown, text/vnd.tiddlywiki',
      });

      expect([...policy.permissions]).toEqual(['read', 'create']);
      expect(policy.allowedTypes).toEqual(['text/markdown', 'text/vnd.tiddlywiki']);
    });

    it('should reject PERMISSIONS that is set but empty', () => {
      expect(() => loadWritePolicy({ PERMISSIONS: ' , ' })).toThrow(/set but empty/);
    });

    it('should reject ALLOWED_TYPES that is set but empty', () => {
      expect(() => loadWritePolicy({ ALLOWED_TYPES: ',' })).toThrow(/set but empty/);
    });

    it('should report ALLOWED_TYPES entries that have no effect', () => {
      expect(
        ineffectiveAllowedTypes(loadWritePolicy({ ALLOWED_TYPES: 'text/markdown,text/css' }))
      ).toEqual(['text/css']);
      expect(
        ineffectiveAllowedTypes(
          loadWritePolicy({ ALLOWED_TYPES: 'text/css', UNSAFE_ALLOW_CODE_WRITES: 'true' })
        )
      ).toEqual([]);
    });

    it('should reject unknown permissions', () => {
      expect(() => loadWritePolicy({ PERMISSIONS: 'read,wirte' })).toThrow(/wirte/);
    });

    it('should enable code writes only for the exact value "true"', () => {
      expect(loadWritePolicy({ UNSAFE_ALLOW_CODE_WRITES: 'true' }).allowCodeWrites).toBe(true);
      expect(loadWritePolicy({ UNSAFE_ALLOW_CODE_WRITES: '1' }).allowCodeWrites).toBe(false);
    });
  });

  describe('isToolAllowed', () => {
    it('should map tools to permissions', () => {
      setWritePolicy(loadWritePolicy({ PERMISSIONS: 'read,update' }));

      expect(isToolAllowed('search_tiddlers')).toBe(true);
      expect(isToolAllowed('update_tiddler')).toBe(true);
      expect(isToolAllowed('create_tiddler')).toBe(false);
      expect(isToolAllowed('delete_tiddler')).toBe(false);
    });
  });

  describe('checkWrite: ALLOWED_TYPES', () => {
    it('should allow any type when unset', () => {
      expect(checkWrite({ title: 'A', type: 'text/vnd.tiddlywiki' })).toBeNull();
    });

    it('should reject types not in the list', () => {
      setWritePolicy(loadWritePolicy({ ALLOWED_TYPES: 'text/markdown' }));

      expect(checkWrite({ title: 'A', type: 'text/markdown' })).toBeNull();
      expect(checkWrite({ title: 'A', type: 'text/vnd.tiddlywiki' })).toMatch(/not allowed/);
    });

    it('should only check the type of an update if the update changes it', () => {
      setWritePolicy(loadWritePolicy({ ALLOWED_TYPES: 'text/markdown' }));
      const existing = { title: 'Legacy', type: 'text/vnd.tiddlywiki', text: 'new' };

      expect(checkWrite(existing, { text: 'new' })).toBeNull();
      expect(checkWrite(existing, { type: 'text/vnd.tiddlywiki' })).toMatch(/not allowed/);
    });

    it('should not be bypassed by a field name with whitespace', () => {
      setWritePolicy(loadWritePolicy({ ALLOWED_TYPES: 'text/markdown' }));

      expect(checkWrite({ title: 'A', type: 'text/markdown', 'type ': 'text/html' })).toMatch(
        /Invalid field name/
      );
    });
  });

  // Each case was a working bypass in an earlier version of this policy,
  // verified against a TiddlyWiki 5.4.1 server.
  describe('checkWrite: field structure', () => {
    it.each([
      ['a nested fields object', { title: 'A', fields: { 'module-type': 'startup' } }, /Nested/],
      [
        'a nested title',
        { title: '$:/core/ui/PageTemplate', fields: { title: 'Harmless' } },
        /Nested/,
      ],
      ['trailing whitespace', { title: 'A', 'module-type ': 'startup' }, /Invalid field name/],
      [
        'leading whitespace',
        { title: 'A', ' type': 'application/javascript' },
        /Invalid field name/,
      ],
      ['a control character', { title: 'A', 'module-type\t': 'startup' }, /Invalid field name/],
      ['constructor', { title: 'A', constructor: 'x' }, /Invalid field name/],
    ])('should reject %s', (_label, tiddler, error) => {
      expect(checkWrite(tiddler)).toMatch(error);
    });

    it('should reject a __proto__ key parsed from JSON', () => {
      const tiddler = JSON.parse('{"title":"A","__proto__":{"plugin-type":"plugin"}}');

      expect(checkWrite(tiddler)).toMatch(/Invalid field name __proto__/);
    });

    it('should check the title TiddlyWiki stores, not a nested one', () => {
      expect(checkWrite({ title: '$:/core/ui/PageTemplate' }, { text: 'x' })).toMatch(
        /system tiddler/
      );
    });
  });

  describe('checkWrite: code tiddlers', () => {
    it.each([
      ['a $:/ title', { title: '$:/core/ui/PageTemplate' }],
      ['module-type', { title: 'A', 'module-type': 'startup' }],
      ['plugin-type', { title: 'A', 'plugin-type': 'plugin' }],
      ['a JavaScript type', { title: 'A', type: 'application/javascript' }],
      ['a system tag', { title: 'A', tags: 'Notes $:/tags/RawMarkup' }],
      ['a bracketed system tag', { title: 'A', tags: '[[$:/tags/Startup Action]]' }],
      ['a tag array', { title: 'A', tags: ['$:/tags/Macro'] }],
      // TiddlyWiki parses this as ["[[x", "$:/tags/RawMarkup", "]]y"]
      ['a system tag hidden in list syntax', { title: 'A', tags: '[[x $:/tags/RawMarkup ]]y' }],
      // These formats are parsed for fields when the wiki loads
      ['a .tid body (application/x-tiddler)', { title: 'A', type: 'application/x-tiddler' }],
      ['a .multids body', { title: 'A', type: 'application/x-tiddlers' }],
      ['a CSS header comment', { title: 'A', type: 'text/css' }],
      ['HTML', { title: 'A', type: 'text/html' }],
      ['an unknown type', { title: 'A', type: 'application/x-anything' }],
    ])('should reject %s', (_label, tiddler) => {
      expect(checkWrite(tiddler)).toMatch(/UNSAFE_ALLOW_CODE_WRITES/);
    });

    it('should reject edits of tiddlers that already carry code fields', () => {
      // Shape of a GET response: TiddlyWiki nests custom fields
      const existing = { title: 'A', text: 'x', fields: { 'module-type': 'startup' } };

      expect(checkWrite(existing, { text: 'x' })).toMatch(
        /existing tiddler has a module-type field/
      );
    });

    it('should reject edits of tiddlers with a type outside the allowlist', () => {
      const stylesheet = { title: 'Style', type: 'text/css', text: 'body {}' };

      expect(checkWrite(stylesheet, { text: 'body { color: red }' })).toMatch(
        /existing tiddler has the type "text\/css"/
      );
    });

    it('should reject deleting system tiddlers and code tiddlers', () => {
      expect(checkDelete('$:/config/Something')).toMatch(/UNSAFE_ALLOW_CODE_WRITES/);
      expect(checkDelete('Boot', { title: 'Boot', type: 'application/javascript' })).toMatch(
        /cannot be deleted/
      );
      expect(checkDelete('Note', { title: 'Note', type: 'text/markdown' })).toBeNull();
      expect(checkDelete('Note')).toBeNull();
    });

    it('should allow ordinary tiddlers', () => {
      expect(
        checkWrite({ title: 'Note', type: 'text/markdown', tags: '[[My Topic]] Concept' })
      ).toBeNull();
    });

    it('should allow code writes when UNSAFE_ALLOW_CODE_WRITES is true', () => {
      setWritePolicy(loadWritePolicy({ UNSAFE_ALLOW_CODE_WRITES: 'true' }));

      expect(checkWrite({ title: 'A', 'module-type': 'startup' })).toBeNull();
    });
  });
});
