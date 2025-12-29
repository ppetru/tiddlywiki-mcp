// ABOUTME: Handler for the update_tiddler MCP tool
// ABOUTME: Updates existing tiddlers with diff preview and custom field support

import { createTwoFilesPatch } from 'diff';
import {
  getTiddler,
  putTiddler,
  updateTiddlerObject,
  getAuthUser,
  type Tiddler,
} from '../tiddlywiki-http.js';
import type { ToolResult } from './types.js';
import { UpdateTiddlerInput } from './types.js';

/**
 * Generate a readable diff between two tiddlers
 */
function generateTiddlerDiff(oldTiddler: Tiddler, newTiddler: Tiddler): string {
  const lines: string[] = [];

  // Text diff
  const oldText = oldTiddler.text || '';
  const newText = newTiddler.text || '';

  if (oldText !== newText) {
    const patch = createTwoFilesPatch(
      oldTiddler.title,
      newTiddler.title,
      oldText,
      newText,
      'Before',
      'After',
      { context: 1 } // Reduce context to 1 line for more compact diffs
    );

    // Add a concise summary
    const oldLines = oldText.split('\n').length;
    const newLines = newText.split('\n').length;
    const delta = newLines - oldLines;
    const summary =
      delta > 0
        ? `+${delta} line${delta === 1 ? '' : 's'}`
        : delta < 0
          ? `${delta} line${delta === -1 ? '' : 's'}`
          : 'modified';

    lines.push(`**Content:** ${summary}`);
    lines.push('```diff');
    lines.push(patch);
    lines.push('```');
  }

  // Metadata changes
  const metadataChanges: string[] = [];

  if (oldTiddler.tags !== newTiddler.tags) {
    metadataChanges.push(`  tags: "${oldTiddler.tags || ''}" → "${newTiddler.tags || ''}"`);
  }

  if (oldTiddler.type !== newTiddler.type) {
    metadataChanges.push(`  type: "${oldTiddler.type}" → "${newTiddler.type}"`);
  }

  if (metadataChanges.length > 0) {
    lines.push('');
    lines.push('**Metadata:**');
    lines.push(...metadataChanges);
  }

  return lines.join('\n');
}

/**
 * Handle update_tiddler tool requests.
 * Gets the current tiddler, applies updates, generates a diff, and saves.
 */
export async function handleUpdateTiddler(args: unknown): Promise<ToolResult> {
  const input = UpdateTiddlerInput.parse(args);

  // Get current tiddler
  const current = await getTiddler(input.title);
  if (!current) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ error: `Tiddler not found: ${input.title}` }, null, 2),
        },
      ],
      isError: true,
    };
  }

  // Build updated tiddler - include all custom fields from input
  const { title: _title, text, tags, type, ...customFields } = input;
  const updates: Partial<Tiddler> = { ...customFields };
  if (text !== undefined) updates.text = text;
  if (tags !== undefined) updates.tags = tags;
  if (type !== undefined) updates.type = type;

  const updated = updateTiddlerObject(current, updates, getAuthUser());

  // Generate diff
  const diff = generateTiddlerDiff(current, updated);

  // Apply the change
  await putTiddler(updated);

  return {
    content: [
      {
        type: 'text',
        text: `## Updated: "${input.title}"\n\n${diff}`,
      },
    ],
  };
}

// Re-export the input schema for use in tool registration
export { UpdateTiddlerInput };
