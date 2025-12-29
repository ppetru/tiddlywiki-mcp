// ABOUTME: Handler for the create_tiddler MCP tool
// ABOUTME: Creates new tiddlers with preview and custom field support

import {
  getTiddler,
  putTiddler,
  createTiddlerObject,
  getAuthUser,
  type Tiddler,
} from '../tiddlywiki-http.js';
import type { ToolResult } from './types.js';
import { CreateTiddlerInput } from './types.js';

/**
 * Format a tiddler for preview display.
 * Exported for use by delete-tiddler handler.
 */
export function formatTiddlerPreview(tiddler: Tiddler): string {
  const lines: string[] = [];

  lines.push(`**Title:** ${tiddler.title}`);
  lines.push(`**Type:** ${tiddler.type || 'text/vnd.tiddlywiki'}`);
  lines.push(`**Tags:** ${tiddler.tags || '(none)'}`);
  lines.push('');
  lines.push('**Content:**');
  lines.push('```');
  lines.push(tiddler.text || '(empty)');
  lines.push('```');

  return lines.join('\n');
}

/**
 * Handle create_tiddler tool requests.
 * Checks for duplicates, creates the tiddler, and returns a preview.
 */
export async function handleCreateTiddler(args: unknown): Promise<ToolResult> {
  const input = CreateTiddlerInput.parse(args);

  // Check if tiddler already exists
  const existing = await getTiddler(input.title);
  if (existing) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            { error: `Tiddler already exists: ${input.title}. Use update_tiddler to modify it.` },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }

  // Create new tiddler object with custom fields
  const { title, text, tags, type, ...customFields } = input;
  const newTiddler = {
    ...createTiddlerObject(title, text, tags || '', type || 'text/markdown', getAuthUser()),
    ...customFields, // Add any custom fields
  };

  // Generate preview
  const preview = formatTiddlerPreview(newTiddler);

  // Create the tiddler
  await putTiddler(newTiddler);

  return {
    content: [
      {
        type: 'text',
        text: `## Created: "${input.title}"\n\n${preview}`,
      },
    ],
  };
}

// Re-export the input schema for use in tool registration
export { CreateTiddlerInput };
