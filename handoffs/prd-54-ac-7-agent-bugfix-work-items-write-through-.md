<!-- source: direct -->
<!-- triggeredBy: unknown -->
<!-- budget: 1 -->

# Agent Forge -- PRD-54 AC-7: Agent Bugfix Work Items Write-Through to Bugs DB

## Metadata
- **Branch:** `feat/prd-54-ac-7-bugfix-work-items-write-through-bugs-db`
- **Priority:** medium
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** app/api/work-items/route.ts, lib/bugs.ts

## Context

PRD-54 is adding a Bugs database to the Agent Forge control plane. Previous ACs have wired up:
- **AC-2**: MCP tools (`file_bug`, `list_bugs`, `update_bug_status`) in `lib/mcp/tools/bugs.ts`
- **AC-3**: Dispatcher bug integration in `lib/atc/dispatcher.ts` + Notion helpers in `lib/notion.ts`
- **AC-4**: Auto-close bugs in Notion when a work item PR merges (branch `fix/prd-54-ac-4-auto-close-bugs-in-notion-when-work-it`, modifying `lib/event-reactor.ts` and `lib/bugs.ts`)
- **AC-5**: Dashboard bug tracking section (branch `fix/prd-54-ac-5-dashboard-bug-tracking-section-with-se`, modifying `lib/hooks.ts`, `app/api/bugs/route.ts`, etc.)

This task (AC-7) adds a write-through so that when **pipeline agents** create bugfix work items via `POST /api/work-items`, a corresponding record is automatically created in the Notion Bugs database (`023f3621-2885-468d-a8cf-2e0bd1458bb3`). This is fire-and-forget — it must not block the 201 response.

**Concurrent work to avoid:**
- AC-4 is modifying `lib/bugs.ts` and `lib/event-reactor.ts` — coordinate if `lib/bugs.ts` already exists; do NOT touch `lib/event-reactor.ts`
- AC-5 is modifying `app/api/bugs/route.ts`, `lib/hooks.ts`, `app/(app)/page.tsx`, `components/bug-summary.tsx` — do NOT touch these files

**Key existing patterns:**
- Notion client: `getClient()` from `lib/notion.ts` (returns `@notionhq/client` Client instance)
- Work item types: `lib/types.ts` — `WorkItem` type with fields including `id`, `title`, `description`, `targetRepo`, `type`, `source`
- The `source` field on work items encodes the originating agent (e.g., `source.type` or `source.agent` — inspect the actual type in `lib/types.ts`)
- Notion Bugs DB ID: `023f3621-2885-468d-a8cf-2e0bd1458bb3`
- Bugs DB properties (from AC-2 usage in `lib/mcp/tools/bugs.ts`): Title, Status, Severity, Target Repo, Source, Work Item ID, Context

## Requirements

1. After `createWorkItem(parsed.data)` succeeds in `app/api/work-items/route.ts`, add a fire-and-forget call to `writeBugRecord(item)` only when `item.type === "bugfix"`.
2. `writeBugRecord` must NOT be awaited before returning 201 — use `.catch()` pattern.
3. Implement `writeBugRecord(item: WorkItem): Promise<void>` — either in `lib/bugs.ts` (preferred if AC-4 already created that module) or inline in the route file as a local helper.
4. Map `item.source` to one of the Bugs DB Source select values: `"Feedback Compiler"`, `"Code Reviewer"`, `"QA Agent"`, `"Outcome Tracker"`. Unmapped sources default to `"Outcome Tracker"` (or omit the field).
5. Create a Notion page in the Bugs DB with: Title = `item.title`, Status = `"In Progress"`, Severity = `"Medium"` (default; use `item.severity` or equivalent metadata if present on the WorkItem type), Target Repo = `item.targetRepo`, Source = mapped agent name, Work Item ID = `item.id`, Context = `item.description`.
6. Wrap in try/catch inside the helper (so `.catch()` on the outer call gracefully handles errors). Log failures with `console.error("[work-items] Bugs DB write-through failed:", err)`.
7. Do not modify `lib/event-reactor.ts`, `app/api/bugs/route.ts`, `lib/hooks.ts`, `app/(app)/page.tsx`, or `components/bug-summary.tsx` (concurrent AC-4/AC-5 work).
8. TypeScript must compile with `npx tsc --noEmit` — no new type errors.

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/prd-54-ac-7-bugfix-work-items-write-through-bugs-db
```

### Step 1: Inspect existing types and files

Before writing any code, read the actual source to understand the exact shape of `WorkItem` and `source`:

```bash
cat lib/types.ts
cat lib/notion.ts | head -80
cat app/api/work-items/route.ts
```

Check whether AC-4's `lib/bugs.ts` already exists (it may be on a different branch, so it likely does NOT exist on main yet):

```bash
ls lib/bugs.ts 2>/dev/null && cat lib/bugs.ts || echo "lib/bugs.ts does not exist"
```

Check AC-2's bug tools for property name patterns:
```bash
cat lib/mcp/tools/bugs.ts
```

Note down:
- Exact type of `source` on `WorkItem` (string, object, enum?)
- Whether `severity` or similar metadata exists on `WorkItem`
- Exact Notion property names used in AC-2's `file_bug` tool (these must match)
- The return type of `createWorkItem` — does it return the created `WorkItem`?

### Step 2: Implement `writeBugRecord` in `lib/bugs.ts`

Create `lib/bugs.ts` (or add to it if it already exists on main). This is preferred over inline in the route file to avoid conflicts and keep the route lean.

**Important:** If `lib/bugs.ts` already exists on main with content from AC-3, add the `writeBugRecord` export without removing existing exports.

```typescript
// lib/bugs.ts
import { getClient } from "./notion";
import type { WorkItem } from "./types";

const BUGS_DB_ID = "023f3621-2885-468d-a8cf-2e0bd1458bb3";

/** Maps work item source identifiers to Notion Bugs DB Source select values */
function mapSourceToAgent(source: WorkItem["source"]): string {
  // Adjust this mapping based on the actual shape of WorkItem["source"]
  // If source is a string:
  if (typeof source === "string") {
    const lower = source.toLowerCase();
    if (lower.includes("feedback") || lower.includes("compiler")) return "Feedback Compiler";
    if (lower.includes("review") || lower.includes("code")) return "Code Reviewer";
    if (lower.includes("qa")) return "QA Agent";
    if (lower.includes("outcome") || lower.includes("tracker")) return "Outcome Tracker";
    return "Outcome Tracker"; // default
  }
  // If source is an object with a type or agent field:
  if (source && typeof source === "object") {
    const s = source as Record<string, string>;
    const identifier = (s.agent ?? s.type ?? "").toLowerCase();
    if (identifier.includes("feedback") || identifier.includes("compiler")) return "Feedback Compiler";
    if (identifier.includes("review") || identifier.includes("code")) return "Code Reviewer";
    if (identifier.includes("qa")) return "QA Agent";
    if (identifier.includes("outcome") || identifier.includes("tracker")) return "Outcome Tracker";
  }
  return "Outcome Tracker"; // safe default
}

/**
 * Fire-and-forget: creates a corresponding Bugs DB record in Notion when a
 * pipeline agent files a bugfix work item. Non-fatal — callers should .catch().
 */
export async function writeBugRecord(item: WorkItem): Promise<void> {
  const notion = getClient();
  const agentSource = mapSourceToAgent(item.source);

  // Build severity — use item metadata if available, default to "Medium"
  // Adjust the field name below if WorkItem has a severity property
  const severity: string =
    (item as WorkItem & { severity?: string }).severity ?? "Medium";

  await notion.pages.create({
    parent: { database_id: BUGS_DB_ID },
    properties: {
      // Title property — adjust property name to match AC-2's Notion schema
      Name: {
        title: [{ text: { content: item.title } }],
      },
      Status: {
        select: { name: "In Progress" },
      },
      Severity: {
        select: { name: severity },
      },
      "Target Repo": {
        rich_text: [{ text: { content: item.targetRepo ?? "" } }],
      },
      Source: {
        select: { name: agentSource },
      },
      "Work Item ID": {
        rich_text: [{ text: { content: item.id } }],
      },
      Context: {
        rich_text: [{ text: { content: (item.description ?? "").slice(0, 2000) } }],
      },
    },
  });
}
```

**⚠️ Critical:** Before finalizing, verify the exact Notion property names (Name vs Title, "Target Repo" vs "TargetRepo", etc.) by looking at `lib/mcp/tools/bugs.ts` from AC-2. Use the same names — mismatches will cause runtime Notion API errors.

### Step 3: Add write-through to `app/api/work-items/route.ts`

Open `app/api/work-items/route.ts` and locate the POST handler. Find the `createWorkItem(parsed.data)` call and add the fire-and-forget write-through immediately after:

```typescript
// At top of file, add import:
import { writeBugRecord } from "@/lib/bugs";

// ... inside POST handler, after createWorkItem succeeds ...

const item = await createWorkItem(parsed.data);

// AC-7: Fire-and-forget write-through to Bugs DB for bugfix work items
if (item.type === "bugfix") {
  writeBugRecord(item).catch((err) =>
    console.error("[work-items] Bugs DB write-through failed:", err)
  );
}

return NextResponse.json(item, { status: 201 });
```

**Notes:**
- If `createWorkItem` returns `void` or does not return the item, check whether the parsed data + a generated ID is returned, or query `getWorkItem` after creation. Adapt accordingly.
- Do not change any other logic in the POST handler.
- Do not touch any other routes (GET, PATCH, etc.) in this file.

### Step 4: Verify the Notion property names match AC-2

```bash
grep -n "properties" lib/mcp/tools/bugs.ts
grep -n "title\|Status\|Severity\|Target Repo\|Source\|Work Item\|Context\|Name" lib/mcp/tools/bugs.ts
```

Update `lib/bugs.ts` property names to exactly match what AC-2 uses in the `file_bug` tool. This is critical for the Notion API call to succeed at runtime.

### Step 5: TypeScript verification

```bash
npx tsc --noEmit
```

Resolve any type errors. Common issues to watch for:
- `WorkItem["source"]` type mismatch — adapt `mapSourceToAgent` signature to the actual type
- `item.targetRepo` may be optional — use `?? ""` guard
- `item.description` may be optional — use `?? ""` guard
- Notion SDK `pages.create` property shape — ensure each property value matches the Notion API type

### Step 6: Build check

```bash
npm run build
```

Fix any build errors before proceeding.

### Step 7: Verify no concurrent-work files were touched

```bash
git diff --name-only
```

Confirm the diff contains ONLY:
- `app/api/work-items/route.ts`
- `lib/bugs.ts`

If any of these files appear in the diff, revert those changes immediately:
- `lib/event-reactor.ts`
- `app/api/bugs/route.ts`
- `lib/hooks.ts`
- `app/(app)/page.tsx`
- `components/bug-summary.tsx`

### Step 8: Commit, push, open PR

```bash
git add app/api/work-items/route.ts lib/bugs.ts
git commit -m "feat: AC-7 — write-through to Bugs DB when agents file bugfix work items"
git push origin feat/prd-54-ac-7-bugfix-work-items-write-through-bugs-db
gh pr create \
  --title "feat: PRD-54 AC-7 — agent bugfix work items write-through to Bugs DB" \
  --body "## Summary

Implements PRD-54 AC-7: when a pipeline agent creates a bugfix work item via \`POST /api/work-items\`, a corresponding record is fire-and-forget written to the Notion Bugs database.

## Changes

### \`lib/bugs.ts\`
- Added \`writeBugRecord(item: WorkItem)\` export
- Maps \`item.source\` to Bugs DB Source select values: Feedback Compiler, Code Reviewer, QA Agent, Outcome Tracker
- Creates Notion page with: Title, Status=In Progress, Severity=Medium, Target Repo, Source, Work Item ID, Context
- Wrapped in async/await with error propagation to caller's \`.catch()\`

### \`app/api/work-items/route.ts\`
- After \`createWorkItem\` succeeds, conditionally calls \`writeBugRecord(item).catch(...)\` for \`type === 'bugfix'\` items
- Fire-and-forget: does not block the 201 response
- Non-fatal: logs error but never throws

## Non-goals / Scope
- Does not modify \`lib/event-reactor.ts\`, \`app/api/bugs/route.ts\`, \`lib/hooks.ts\`, \`app/(app)/page.tsx\`, or \`components/bug-summary.tsx\` (concurrent AC-4/AC-5 work)
- AC-4 (\`lib/bugs.ts\` on its branch) may need a merge/rebase when both land; \`writeBugRecord\` is additive

## Testing
- \`npx tsc --noEmit\` passes
- \`npm run build\` passes
- Manual: POST a work item with \`type: 'bugfix'\` and verify a Notion page appears in the Bugs DB
"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles:
```bash
git add -A
git commit -m "wip: AC-7 partial — bugs db write-through [abort]"
git push origin feat/prd-54-ac-7-bugfix-work-items-write-through-bugs-db
gh pr create --title "wip: PRD-54 AC-7 partial" --body "Partial implementation — see ISSUES in description" --draft
```

2. Output structured report:
```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/prd-54-ac-7-bugfix-work-items-write-through-bugs-db
FILES CHANGED: [app/api/work-items/route.ts, lib/bugs.ts]
SUMMARY: [what was implemented]
ISSUES: [what failed — e.g., "WorkItem.source type is unknown union — mapSourceToAgent needs update", "Notion property names differ from AC-2 schema"]
NEXT STEPS: [e.g., "Verify Notion property names in lib/mcp/tools/bugs.ts and update lib/bugs.ts lines 30-50"]
```

3. Escalate if blocked on Notion schema shape or `WorkItem.source` type:
```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "prd-54-ac-7",
    "reason": "Cannot determine exact Notion Bugs DB property names or WorkItem.source type shape without human confirmation",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "Step 2 or Step 4",
      "error": "Type mismatch or Notion API 400 on property name",
      "filesChanged": ["lib/bugs.ts", "app/api/work-items/route.ts"]
    }
  }'
```

## Key Decisions & Notes

- **`lib/bugs.ts` vs inline helper**: Prefer `lib/bugs.ts` to keep the route file lean and because AC-4 will also export from `lib/bugs.ts` — placing `writeBugRecord` there means the eventual merge of AC-4 and AC-7 is additive rather than conflicting.
- **Fire-and-forget pattern**: The `.catch()` is on the returned Promise — this means the Notion write happens asynchronously after the response is sent. Vercel serverless functions may terminate before the write completes if the event loop drains. If this becomes an issue in production, consider `waitUntil` from `@vercel/functions` — but for now, `.catch()` is sufficient per the spec.
- **Severity default**: `WorkItem` likely does not have a `severity` field (it's not in the core type). The cast `(item as WorkItem & { severity?: string }).severity ?? "Medium"` is safe — it will always resolve to `"Medium"` for standard work items.
- **Context truncation**: Notion rich_text blocks have a 2000-character limit. The `.slice(0, 2000)` guard prevents API errors on long descriptions.