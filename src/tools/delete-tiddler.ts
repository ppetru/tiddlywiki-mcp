// ABOUTME: Handler for the delete_tiddler MCP tool
// ABOUTME: Deletes tiddlers with preview of what will be deleted

import { getTiddler, deleteTiddler } from '../tiddlywiki-http.js';
import { checkDelete, policyErrorResult } from '../write-policy.js';
import type { ToolResult } from './types.js';
import { DeleteTiddlerInput } from './types.js';
import { formatTiddlerPreview } from './create-tiddler.js';

/**
 * Handle delete_tiddler tool requests.
 * Shows a preview of the tiddler content before deletion.
 */
export async function handleDeleteTiddler(args: unknown): Promise<ToolResult> {
  const input = DeleteTiddlerInput.parse(args);

  const violation = checkDelete(input.title);
  if (violation) return policyErrorResult(violation);

  // Get current tiddler to show what will be deleted
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

  const existingViolation = checkDelete(input.title, current);
  if (existingViolation) return policyErrorResult(existingViolation);

  // Generate preview of what will be deleted
  const preview = formatTiddlerPreview(current);

  // Delete the tiddler
  await deleteTiddler(input.title);

  return {
    content: [
      {
        type: 'text',
        text: `## Deleted: "${input.title}"\n\n${preview}`,
      },
    ],
  };
}

// Re-export the input schema for use in tool registration
export { DeleteTiddlerInput };
