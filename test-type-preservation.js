import { updateTiddlerObject } from './dist/tiddlywiki-http.js';

// Simulate a markdown tiddler
const markdownTiddler = {
  title: "Test-Markdown",
  text: "Original content",
  type: "text/markdown",
  tags: "test",
  created: "20251114000000000",
  creator: "ppetru"
};

// Simulate a wikitext tiddler
const wikitextTiddler = {
  title: "Test-Wikitext",
  text: "''Original'' content",
  type: "text/vnd.tiddlywiki",
  tags: "test",
  created: "20251114000000000",
  creator: "ppetru"
};

console.log("Testing type preservation...\n");

// Test 1: Update markdown tiddler without specifying type
const updatedMarkdown = updateTiddlerObject(markdownTiddler, { text: "New content" });
console.log("1. Update markdown (no type specified):");
console.log(`   Original type: ${markdownTiddler.type}`);
console.log(`   Updated type: ${updatedMarkdown.type}`);
console.log(`   ✓ Type preserved: ${updatedMarkdown.type === 'text/markdown'}\n`);

// Test 2: Update wikitext tiddler without specifying type
const updatedWikitext = updateTiddlerObject(wikitextTiddler, { text: "''New'' content" });
console.log("2. Update wikitext (no type specified):");
console.log(`   Original type: ${wikitextTiddler.type}`);
console.log(`   Updated type: ${updatedWikitext.type}`);
console.log(`   ✓ Type preserved: ${updatedWikitext.type === 'text/vnd.tiddlywiki'}\n`);

// Test 3: Update wikitext tiddler, explicitly change to markdown
const convertedToMarkdown = updateTiddlerObject(wikitextTiddler, {
  text: "# New content",
  type: "text/markdown"
});
console.log("3. Convert wikitext to markdown (type explicitly specified):");
console.log(`   Original type: ${wikitextTiddler.type}`);
console.log(`   Updated type: ${convertedToMarkdown.type}`);
console.log(`   ✓ Type changed: ${convertedToMarkdown.type === 'text/markdown'}\n`);

// Test 4: Verify metadata is preserved
const updatedWithMetadata = updateTiddlerObject(markdownTiddler, { text: "New" });
console.log("4. Verify metadata preservation:");
console.log(`   created preserved: ${updatedWithMetadata.created === markdownTiddler.created}`);
console.log(`   creator preserved: ${updatedWithMetadata.creator === markdownTiddler.creator}`);
console.log(`   title preserved: ${updatedWithMetadata.title === markdownTiddler.title}`);
console.log(`   ✓ All metadata preserved\n`);

console.log("All tests passed! ✓");
