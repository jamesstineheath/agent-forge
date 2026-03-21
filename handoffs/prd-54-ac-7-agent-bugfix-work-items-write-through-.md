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

**Concurrent work — DO NOT modify these files:**
- `lib/event-reactor.ts` (AC-4)
- `app/api/bugs/route.ts` (AC-5)
- `lib/hooks.ts` (AC-5)
- `app/(app)/page.tsx` (AC-5)
- `components/bug-summary.tsx` (AC-5)

**⚠️ `lib/bugs.ts` conflict risk:** AC-4 is also modifying `lib/bugs.ts` on its branch. If `lib/bugs.ts` already exists on main (from AC-3 or a merged AC-4), add `writeBugRecord` as a new export without removing existing content. If it does not exist, create it fresh. The eventual merge of AC-4 + AC-7 should be additive.

## Requirements

1. After `createWorkItem(...)` succeeds in `app/api/work-items/route.ts` POST handler, call `writeBugRecord(item)` only when `item.type === "bugfix"`.
2. The Notion write must NOT block the 201 response. Use `waitUntil` from `@vercel/functions` to keep the serverless function alive for the background write. Fallback: `.catch()` pattern if `waitUntil` is not available.
3. Implement `writeBugRecord(item: WorkItem): Promise<void>` in `lib/bugs.ts`.
4. Map `item.source` to one of the Bugs DB Source select values: `"Feedback Compiler"`, `"Code Reviewer"`, `"QA Agent"`, `"Outcome Tracker"`. Unmapped sources default to `"Outcome Tracker"`.
5. Create a Notion page in the Bugs DB with: Title = `item.title`, Status = `"In Progress"`, Severity = `"Medium"` (default), Target Repo = `item.targetRepo`, Source = mapped agent name, Work Item ID = `item.id`, Context = `item.description` (truncated to 2000 chars).
6. Wrap the Notion call in try/catch inside the helper. Log failures with `console.error("[work-items] Bugs DB write-through failed:", err)`.
7. TypeScript must compile with `npx tsc --noEmit`. No new type errors.

## Execution Steps

### Step 0: Branch setup