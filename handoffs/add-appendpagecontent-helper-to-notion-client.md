# Agent Forge -- Add appendPageContent helper to Notion client

## Metadata
- **Branch:** `feat/notion-append-page-content`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/notion.ts

## Context

Agent Forge uses a Notion client in `lib/notion.ts` to read project plans and poll project status. The file already contains a `fetchPageContent()` function and uses the Notion API with a `NOTION_API_KEY` header for auth.

This task adds a new `appendPageContent(pageId, markdown)` function that writes rich text content back to a Notion page — needed by an upcoming outcome summary feature that will post execution summaries directly to Notion project pages.

The Notion API endpoint for appending blocks is:
```
PATCH https://api.notion.com/v1/blocks/{block_id}/children
Body: { children: [...NotionBlock[]] }
```

The markdown subset to support is limited to what outcome templates produce:
- `## Heading` → `heading_2` block
- `### Heading` → `heading_3` block
- `- bullet item` → `bulleted_list_item` block (with `**bold**` annotations preserved)
- `**bold** text` inline → rich_text array with bold annotation
- Plain paragraphs → `paragraph` block

## Requirements

1. Add `appendPageContent(pageId: string, markdown: string): Promise<void>` to `lib/notion.ts` and export it.
2. Implement a `markdownToNotionBlocks(markdown: string): NotionBlock[]` helper (can be unexported) that converts the supported markdown subset to Notion block objects.
3. `## Heading text` → `{ object: 'block', type: 'heading_2', heading_2: { rich_text: [{ type: 'text', text: { content: 'Heading text' } }] } }`
4. `### Heading text` → same pattern but `heading_3`
5. `- item text` → `{ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: [...] } }` with inline bold parsing applied to item text
6. Plain non-empty lines → `{ object: 'block', type: 'paragraph', paragraph: { rich_text: [...] } }` with inline bold parsing applied
7. Empty lines → skipped (not converted to blocks)
8. Inline bold parsing: split on `**...**` pattern and produce rich_text array where bold segments have `annotations: { bold: true }` and plain segments have no annotations (or `annotations: { bold: false }`)
9. `appendPageContent` calls `PATCH https://api.notion.com/v1/blocks/${pageId}/children` with `Authorization: Bearer ${NOTION_API_KEY}`, `Notion-Version: 2022-06-28`, `Content-Type: application/json`, body `{ children: blocks }`
10. On non-2xx response, throw a descriptive error including the status code and response body.
11. `npx tsc --noEmit` passes with no type errors.

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/notion-append-page-content
```

### Step 1: Inspect existing lib/notion.ts

Read the full contents of `lib/notion.ts` to understand the existing patterns (how `NOTION_API_KEY` is accessed, how fetch is called, existing type definitions, export style).

```bash
cat lib/notion.ts
```

### Step 2: Add types and helpers to lib/notion.ts

After reviewing the existing file, add the following to `lib/notion.ts`. Insert after the existing imports/types and before or after existing functions — keep the file organized.

**Types to add** (only if not already present — check first):

```typescript
// Notion rich text element
interface NotionRichText {
  type: 'text';
  text: { content: string };
  annotations?: { bold?: boolean };
}

// Notion block (subset used by appendPageContent)
interface NotionBlock {
  object: 'block';
  type: 'heading_2' | 'heading_3' | 'bulleted_list_item' | 'paragraph';
  heading_2?: { rich_text: NotionRichText[] };
  heading_3?: { rich_text: NotionRichText[] };
  bulleted_list_item?: { rich_text: NotionRichText[] };
  paragraph?: { rich_text: NotionRichText[] };
}
```

**Inline bold parser:**

```typescript
function parseInlineMarkdown(text: string): NotionRichText[] {
  const parts: NotionRichText[] = [];
  const regex = /\*\*(.+?)\*\*/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    // Plain text before bold
    if (match.index > lastIndex) {
      parts.push({
        type: 'text',
        text: { content: text.slice(lastIndex, match.index) },
      });
    }
    // Bold text
    parts.push({
      type: 'text',
      text: { content: match[1] },
      annotations: { bold: true },
    });
    lastIndex = regex.lastIndex;
  }

  // Remaining plain text
  if (lastIndex < text.length) {
    parts.push({
      type: 'text',
      text: { content: text.slice(lastIndex) },
    });
  }

  // If no parts were produced (empty string), return a single empty text element
  if (parts.length === 0) {
    parts.push({ type: 'text', text: { content: '' } });
  }

  return parts;
}
```

**Markdown to Notion blocks converter:**

```typescript
function markdownToNotionBlocks(markdown: string): NotionBlock[] {
  const lines = markdown.split('\n');
  const blocks: NotionBlock[] = [];

  for (const line of lines) {
    // Skip empty lines
    if (line.trim() === '') continue;

    // ## Heading 2
    if (line.startsWith('## ')) {
      const content = line.slice(3).trim();
      blocks.push({
        object: 'block',
        type: 'heading_2',
        heading_2: {
          rich_text: [{ type: 'text', text: { content } }],
        },
      });
      continue;
    }

    // ### Heading 3
    if (line.startsWith('### ')) {
      const content = line.slice(4).trim();
      blocks.push({
        object: 'block',
        type: 'heading_3',
        heading_3: {
          rich_text: [{ type: 'text', text: { content } }],
        },
      });
      continue;
    }

    // - Bullet list item
    if (line.startsWith('- ')) {
      const content = line.slice(2).trim();
      blocks.push({
        object: 'block',
        type: 'bulleted_list_item',
        bulleted_list_item: {
          rich_text: parseInlineMarkdown(content),
        },
      });
      continue;
    }

    // Plain paragraph
    blocks.push({
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: parseInlineMarkdown(line),
      },
    });
  }

  return blocks;
}
```

**Main exported function:**

```typescript
export async function appendPageContent(
  pageId: string,
  markdown: string
): Promise<void> {
  const notionApiKey = process.env.NOTION_API_KEY;
  if (!notionApiKey) {
    throw new Error('NOTION_API_KEY environment variable is not set');
  }

  const blocks = markdownToNotionBlocks(markdown);

  if (blocks.length === 0) {
    // Nothing to append
    return;
  }

  const url = `https://api.notion.com/v1/blocks/${pageId}/children`;
  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${notionApiKey}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ children: blocks }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Notion API error appending blocks to page ${pageId}: HTTP ${response.status} — ${body}`
    );
  }
}
```

### Step 3: Verify the existing NOTION_API_KEY access pattern

After adding the code, verify that the `NOTION_API_KEY` access pattern matches what the rest of the file uses. If existing code uses a different pattern (e.g., a shared `notionHeaders` constant or a `getNotionClient()` factory), refactor `appendPageContent` to use the same pattern for consistency.

```bash
grep -n "NOTION_API_KEY\|notionHeaders\|Notion-Version\|notion_api" lib/notion.ts
```

If there's a shared headers object or client setup, use that instead of re-declaring in the function body.

### Step 4: TypeScript check

```bash
npx tsc --noEmit
```

Fix any type errors before proceeding. Common issues to watch for:
- The `NotionBlock` union type may need `[key: string]: unknown` or use a discriminated union carefully — adjust if tsc complains about index signatures
- If existing types in the file conflict with new type names, rename the new types (e.g., `AppendNotionBlock`, `AppendNotionRichText`)

### Step 5: Build check

```bash
npm run build
```

Fix any build errors.

### Step 6: Commit, push, open PR

```bash
git add lib/notion.ts
git commit -m "feat: add appendPageContent helper to Notion client

Adds appendPageContent(pageId, markdown) to lib/notion.ts that converts
a markdown subset (## headings, ### headings, - bullets, **bold**, plain
paragraphs) to Notion block objects and appends them to a page via
PATCH /v1/blocks/{pageId}/children.

This is the foundational Notion write integration needed by the outcome
summary feature."

git push origin feat/notion-append-page-content

gh pr create \
  --title "feat: add appendPageContent helper to Notion client" \
  --body "## Summary

Adds \`appendPageContent(pageId: string, markdown: string): Promise<void>\` to \`lib/notion.ts\`.

## What's added

- \`markdownToNotionBlocks()\` — converts markdown subset to Notion block objects
  - \`## Heading\` → \`heading_2\` block
  - \`### Heading\` → \`heading_3\` block
  - \`- item\` → \`bulleted_list_item\` block
  - Plain lines → \`paragraph\` block
  - \`**bold**\` inline → rich_text with bold annotation
- \`parseInlineMarkdown()\` — splits text on \`**...**\` patterns into rich_text arrays
- \`appendPageContent()\` — calls \`PATCH /v1/blocks/{pageId}/children\`, throws descriptive error on non-2xx

## Acceptance criteria
- [x] Exports \`appendPageContent(pageId, markdown): Promise<void>\`
- [x] Converts \`##\` / \`###\` headings to heading_2/heading_3 blocks
- [x] Converts \`- \` bullets to bulleted_list_item blocks with bold annotations preserved
- [x] Converts plain paragraphs to paragraph blocks
- [x] \`npx tsc --noEmit\` passes

## Testing
TypeScript compilation verified. Runtime can be validated by calling the function against a test Notion page with the \`NOTION_API_KEY\` env var set." \
  --base main
```

## Session Abort Protocol
If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/notion-append-page-content
FILES CHANGED: [lib/notion.ts]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

## Escalation

If you encounter a blocker you cannot resolve (e.g., conflicting type definitions in `lib/notion.ts` that require architectural decisions, or the Notion client uses a third-party SDK instead of raw fetch making the implementation pattern unclear):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "add-appendPageContent-notion-client",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/notion.ts"]
    }
  }'
```