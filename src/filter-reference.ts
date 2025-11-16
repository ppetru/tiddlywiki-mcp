/**
 * TiddlyWiki Filter Reference
 *
 * Complete reference for TiddlyWiki filter syntax and operators
 */

export const FILTER_REFERENCE = `# TiddlyWiki Filter Reference

## Syntax Basics

Filters are composed of **runs** enclosed in square brackets: \`[operator[parameter]]\`
Multiple operators can be chained within a run.
Multiple runs can be combined with different logic.

## Logic Operators

- **AND (implicit)**: Space between runs → \`[run1] [run2]\` (intersection)
- **OR**: Comma + prefix → \`[run1],[run2]\` (union)
- **NOT**: ! prefix → \`[all[tiddlers]!tag[Exclude]]\` (exclusion)

## Selection Operators

### all[]
Select tiddlers by type:
- \`[all[tiddlers]]\` - all non-shadow tiddlers
- \`[all[shadows]]\` - all shadow tiddlers
- \`[all[]]]\` - all tiddlers (including shadows)

### tag[]
Select by tag:
- \`[tag[Journal]]\` - tiddlers tagged "Journal"
- \`[tag[OYS]tag[Planning]]\` - tiddlers with BOTH tags (AND)
- \`[tag[OYS]],[tag[Planning]]\` - tiddlers with EITHER tag (OR)
- \`[all[tiddlers]!tag[System]]\` - exclude tagged tiddlers

### prefix[] / suffix[]
String matching on title:
- \`[prefix[2025-11]]\` - titles starting with "2025-11"
- \`[suffix[.md]]\` - titles ending with ".md"
- \`[prefix[OYS ]]\` - OYS posts (note the space!)

### search[]
Full-text search:
- \`[search[keyword]]\` - search title and text
- \`[search:title[keyword]]\` - search title only
- \`[search:text[keyword]]\` - search text only
- \`[search:tags[keyword]]\` - search tags
- \`[search[Inês]]\` - find all mentions

### field matching
Match by field value:
- \`[field:fieldname[value]]\` - exact match
- \`[type[text/markdown]]\` - tiddlers of specific type
- \`[creator[ppetru]]\` - created by user

## Date Operators

### days[]
Relative date filtering:
- \`[!days:created[-7]]\` - created in last 7 days
- \`[!days:modified[-30]]\` - modified in last 30 days
- \`[days:created[1]]\` - created tomorrow or before (future + past)
- \`[days:modified[0]]\` - modified today only

**Parameter D**: number of days from today
- D=0: today only
- D=1: tomorrow and everything before
- D=-1: yesterday and everything after
- D=-7: last week and everything after

### sameday[]
Match specific date:
- \`[sameday:created[20251112]]\` - created on Nov 12, 2025
- \`[sameday:modified[20251112]]\` - modified on Nov 12, 2025

**Date format**: YYYYMMDD or YYYYMMDDHHmmSSsss

## Sorting Operators

### sort[] / !sort[]
Sort results:
- \`[tag[Journal]sort[title]]\` - alphabetical by title
- \`[tag[Journal]!sort[created]]\` - newest first (! = descending)
- \`[tag[Journal]!sort[modified]]\` - most recently modified first
- \`[all[tiddlers]nsort[title]]\` - natural sort (handles numbers)

### limit[]
Limit results:
- \`[tag[Journal]!sort[modified]limit[10]]\` - 10 most recent
- \`[tag[Journal]limit[5]]\` - first 5 matches

## Practical Examples

### Recent journal entries
\`\`\`
[tag[Journal]!days:modified[-7]!sort[modified]]
\`\`\`
Journal entries modified in last 7 days, newest first

### November 2025 entries
\`\`\`
[tag[Journal]prefix[2025-11]sort[title]]
\`\`\`
All November 2025 journal entries, chronological

### Search with context
\`\`\`
[tag[Journal]search[Inês]!sort[modified]limit[10]]
\`\`\`
10 most recent journal entries mentioning Inês

### OYS posts
\`\`\`
[tag[OYS]!sort[created]]
\`\`\`
All OYS posts, newest first

### Entries without a tag
\`\`\`
[tag[Journal]!tag[agent-generated]]
\`\`\`
Human-written journal entries only

### Date range (last 30 days)
\`\`\`
[tag[Journal]!days:created[-30]!sort[created]]
\`\`\`
Journal entries created in last 30 days

### Complex query
\`\`\`
[tag[Journal]!days:modified[-14]search[exercise]!tag[Draft]!sort[modified]limit[5]]
\`\`\`
Last 5 non-draft journal entries mentioning "exercise" from the past 2 weeks

## Tips

1. **Testing**: Test filters incrementally. Start with broad selection, then add constraints.
2. **Performance**: More specific filters (prefix, tag) are faster than full-text search.
3. **Case sensitivity**: Search is case-insensitive by default.
4. **Timestamps**: TiddlyWiki uses milliseconds since epoch for created/modified fields.
5. **Empty results**: Invalid syntax may return empty results rather than errors.

## Common Patterns

| Goal | Filter |
|------|--------|
| Last 7 days | \`[!days:modified[-7]]\` |
| This month | \`[prefix[2025-11]]\` |
| Last 10 entries | \`[tag[Journal]!sort[modified]limit[10]]\` |
| Find keyword | \`[search[keyword]]\` |
| Exclude system | \`[all[tiddlers]!prefix[$:]]\` |
| By date | \`[sameday:created[20251112]]\` |
`;

/**
 * Get the filter reference as a structured object
 */
export function getFilterReference(): { content: string } {
  return {
    content: FILTER_REFERENCE
  };
}
