// ABOUTME: Configurable policy for what MCP clients may do with the wiki
// ABOUTME: Restricts tools by permission, content types, and writes of code tiddlers

import type { Tiddler } from './tiddlywiki-http.js';
import type { ToolResult } from './tools/types.js';

export type Permission = 'read' | 'create' | 'update' | 'delete';

export interface WritePolicy {
  permissions: Set<Permission>;
  allowedTypes: string[] | null; // null = any type
  allowCodeWrites: boolean;
}

const ALL_PERMISSIONS: Permission[] = ['read', 'create', 'update', 'delete'];

export const TOOL_PERMISSIONS: Record<string, Permission> = {
  search_tiddlers: 'read',
  create_tiddler: 'create',
  update_tiddler: 'update',
  delete_tiddler: 'delete',
};

let policy: WritePolicy = {
  permissions: new Set(ALL_PERMISSIONS),
  allowedTypes: null,
  allowCodeWrites: false,
};

function parseList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/**
 * Build the policy from PERMISSIONS, ALLOWED_TYPES and UNSAFE_ALLOW_CODE_WRITES.
 * Throws on unknown or empty-but-set lists so a typo never widens access.
 */
export function loadWritePolicy(env: NodeJS.ProcessEnv): WritePolicy {
  const requested = parseList(env.PERMISSIONS?.toLowerCase());
  if (env.PERMISSIONS !== undefined && requested.length === 0) {
    throw new Error('PERMISSIONS is set but empty. Unset it to allow all tools.');
  }
  const unknown = requested.filter((p) => !ALL_PERMISSIONS.includes(p as Permission));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown PERMISSIONS: ${unknown.join(', ')} (allowed: ${ALL_PERMISSIONS.join(', ')})`
    );
  }

  const allowedTypes = parseList(env.ALLOWED_TYPES);
  if (env.ALLOWED_TYPES !== undefined && allowedTypes.length === 0) {
    throw new Error('ALLOWED_TYPES is set but empty. Unset it to allow the default types.');
  }

  return {
    permissions: new Set(requested.length > 0 ? (requested as Permission[]) : ALL_PERMISSIONS),
    allowedTypes: allowedTypes.length > 0 ? allowedTypes : null,
    allowCodeWrites: env.UNSAFE_ALLOW_CODE_WRITES === 'true',
  };
}

/**
 * ALLOWED_TYPES entries that have no effect because code writes are disabled
 * and the type is not in SAFE_TYPES. Used for a startup warning.
 */
export function ineffectiveAllowedTypes(config: WritePolicy): string[] {
  if (config.allowCodeWrites || !config.allowedTypes) return [];
  return config.allowedTypes.filter((type) => !SAFE_TYPES.includes(type));
}

export function setWritePolicy(next: WritePolicy): void {
  policy = next;
}

export function getWritePolicy(): WritePolicy {
  return policy;
}

/**
 * Whether a tool may be listed and called. Unknown tools are left to the caller.
 */
export function isToolAllowed(name: string): boolean {
  const permission = TOOL_PERMISSIONS[name];
  return permission === undefined || policy.permissions.has(permission);
}

/**
 * The fields TiddlyWiki will store for a PUT body: its PUT endpoint pulls a
 * nested `fields` object up to the top level. Only the server's own GET
 * responses may contain one; client requests with `fields` are rejected.
 */
function effectiveFields(tiddler: Partial<Tiddler>): Record<string, unknown> {
  const { fields, ...rest } = tiddler;
  return fields && typeof fields === 'object' ? { ...rest, ...fields } : rest;
}

// Names that would set the prototype when TiddlyWiki copies fields by assignment
const PROTOTYPE_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Reason why a field name sent by a client is invalid, or null.
 * TiddlyWiki trims field names when it loads tiddler files, so `"type "`
 * would bypass every check here and turn into `type` after a restart.
 */
function fieldNameReason(name: string): string | null {
  if (name === 'fields') {
    return 'Nested "fields" objects are not accepted; send custom fields at the top level';
  }
  const hasControlChar = [...name].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);
  if (name.trim() !== name || name === '' || hasControlChar) {
    return `Invalid field name ${JSON.stringify(name)}`;
  }
  if (PROTOTYPE_NAMES.has(name)) return `Invalid field name ${name}`;
  return null;
}

/**
 * Content types that TiddlyWiki stores so that only its own serializer writes
 * fields: wikitext as a .tid file, the others as a body file plus a .meta file
 * whose body is loaded as plain text. Every other format may be parsed for
 * fields when the wiki loads (.tid as a type, .css and .js header comments,
 * .multids, .tiddler, .recipe, HTML, plugin formats), so its text could add
 * fields such as tags or module-type that no check here sees.
 */
export const SAFE_TYPES = [
  'text/vnd.tiddlywiki',
  'text/markdown',
  'text/x-markdown',
  'text/plain',
  'application/json',
];

// TiddlyWiki's type for tiddlers without a type field
const DEFAULT_TYPE = 'text/vnd.tiddlywiki';

/**
 * Reason why TiddlyWiki could store or load the tiddler as code, or null.
 * This is an allowlist of types plus three field rules: JavaScript modules
 * and plugins run on the server, and `$:/` tags such as `$:/tags/RawMarkup`
 * inject into the page. Tags are matched as a substring, because TiddlyWiki's
 * list syntax has edge cases (e.g. `[[a $:/tags/RawMarkup ]]b`).
 *
 * Not covered: rendered wikitext and Markdown may contain raw HTML (e.g. an
 * iframe with srcdoc) that runs as script in the viewer's browser. That is
 * TiddlyWiki's trust model and has to be addressed where content is rendered.
 */
function codeReason(fields: Record<string, unknown>): string | null {
  const type = String(fields.type ?? DEFAULT_TYPE);
  if (!SAFE_TYPES.includes(type)) return `the type ${JSON.stringify(type)}`;
  if ('module-type' in fields) return 'a module-type field';
  if ('plugin-type' in fields) return 'a plugin-type field';
  if (String(fields.tags ?? '').includes('$:/')) return 'a $:/ system tag';
  return null;
}

const CODE_WRITES_DISABLED = `Writes that TiddlyWiki could store or load as code are disabled. Allowed: types ${SAFE_TYPES.join(', ')}; no module-type or plugin-type field; no $:/ titles or tags). See UNSAFE_ALLOW_CODE_WRITES`;

/**
 * Check a write before it is sent to TiddlyWiki.
 *
 * @param tiddler - The full tiddler that will be stored; its title is the one
 *   in the PUT URL, which is the title TiddlyWiki stores
 * @param changes - The fields sent by the client (for create: the full tiddler)
 * @returns A reason the write is rejected, or null if it is allowed
 */
export function checkWrite(
  tiddler: Partial<Tiddler>,
  changes: Partial<Tiddler> = tiddler
): string | null {
  for (const name of Object.keys(changes)) {
    const reason = fieldNameReason(name);
    if (reason) return reason;
  }

  if (policy.allowedTypes && changes.type !== undefined) {
    const type = String(changes.type);
    if (!policy.allowedTypes.includes(type)) {
      return `Type ${type} is not allowed (ALLOWED_TYPES: ${policy.allowedTypes.join(', ')})`;
    }
  }

  if (!policy.allowCodeWrites) {
    if (String(tiddler.title ?? '').startsWith('$:/')) {
      return `Rejected: $:/ system tiddler. ${CODE_WRITES_DISABLED}`;
    }
    const changed = codeReason(changes);
    if (changed) return `Rejected: ${changed}. ${CODE_WRITES_DISABLED}`;
    const existing = codeReason(effectiveFields(tiddler));
    if (existing) {
      return `Rejected: the existing tiddler has ${existing}, so it cannot be edited. ${CODE_WRITES_DISABLED}`;
    }
  }

  return null;
}

/**
 * Check a delete before it is sent to TiddlyWiki. Tiddlers that could not be
 * edited (system tiddlers, code tiddlers) cannot be deleted either.
 *
 * @param existing - The current tiddler, if already fetched
 * @returns A reason the delete is rejected, or null if it is allowed
 */
export function checkDelete(title: string, existing?: Partial<Tiddler> | null): string | null {
  if (policy.allowCodeWrites) return null;
  if (title.startsWith('$:/')) return `Rejected: $:/ system tiddler. ${CODE_WRITES_DISABLED}`;
  const reason = existing ? codeReason(effectiveFields(existing)) : null;
  if (reason) {
    return `Rejected: the tiddler has ${reason}, so it cannot be deleted. ${CODE_WRITES_DISABLED}`;
  }
  return null;
}

/**
 * Tool result for a request rejected by the policy.
 */
export function policyErrorResult(reason: string): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: reason }, null, 2) }],
    isError: true,
  };
}
