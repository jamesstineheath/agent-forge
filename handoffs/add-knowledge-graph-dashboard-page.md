# Agent Forge -- Add Knowledge Graph Dashboard Page

## Metadata
- **Branch:** `feat/knowledge-graph-dashboard`
- **Priority:** low
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** app/(app)/knowledge-graph/page.tsx, components/sidebar.tsx, app/api/knowledge-graph/status/route.ts (stub, if missing)

## Context

Agent Forge is a dev orchestration platform built with Next.js App Router. The UI includes a dashboard with multiple sections (work items, pipeline, repos, settings) accessible via a sidebar (`components/sidebar.tsx`). Recent PRs have added a knowledge graph subsystem with indexing (`lib/knowledge-graph/indexer.ts`), querying (`lib/knowledge-graph/query.ts`), and resolver (`lib/knowledge-graph/resolver.ts`) capabilities.

This task adds a UI page at `app/(app)/knowledge-graph/page.tsx` to expose the knowledge graph visually: repo status, manual re-indexing, entity search, and entity detail with dependency graph. All components should use shadcn/ui primitives and follow the patterns in existing dashboard pages.

The route is protected (inside `app/(app)/` which uses auth middleware). The sidebar uses a list of nav items — we just need to add one more entry.

## Requirements

1. `app/(app)/knowledge-graph/page.tsx` must render without TypeScript errors and be a valid Next.js App Router page (Client Component with `"use client"` since it needs interactivity).
2. **Status panel**: Fetch `GET /api/knowledge-graph/status` (or fall back gracefully if not yet implemented) and display a table/card per repo showing: repo name, last indexed timestamp, entity count, relationship count, commit SHA.
3. **Trigger indexing**: A button per repo row that calls `POST /api/knowledge-graph/index` with `{ repo }` body and shows loading/success/error feedback inline.
4. **Search bar**: An `<Input>` for name pattern, a `<Select>` for entity type filter (options: All, Function, Class, Interface, Variable, Import), and a `<Select>` for repo filter. Submitting queries `GET /api/knowledge-graph/query?pattern=...&type=...&repo=...`.
5. **Results table**: Show matching entities in a `<Table>` with columns: Name, Type, File Path, Lines.
6. **Entity detail panel**: Clicking a result row fetches `GET /api/knowledge-graph/entity/[id]` and displays a panel/card showing entity name, type, and two lists: Dependencies (what it imports) and Dependents (what imports it).
7. `components/sidebar.tsx` must include a "Knowledge Graph" nav link pointing to `/knowledge-graph`, using the same pattern as existing nav items (likely with a relevant Lucide icon such as `Network`).
8. All fetch calls must handle loading and error states gracefully (show a spinner or "Loading…" text, show error messages on failure).
9. No new dependencies beyond what's already in the project (`shadcn/ui`, `lucide-react`, etc.).

## Execution Steps

### Step 0: Pre-flight checks
