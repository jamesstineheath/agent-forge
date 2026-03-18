# Agent Forge -- Add Knowledge Graph Dashboard Page

## Metadata
- **Branch:** `feat/knowledge-graph-dashboard`
- **Priority:** low
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** app/(app)/knowledge-graph/page.tsx, components/sidebar.tsx

## Context

Agent Forge is a dev orchestration platform built with Next.js App Router. The UI includes a dashboard with multiple sections (work items, pipeline, repos, settings) accessible via a sidebar (`components/sidebar.tsx`). Recent PRs have added a knowledge graph subsystem with indexing (`lib/knowledge-graph/indexer.ts`), querying (`lib/knowledge-graph/query.ts`), and resolver (`lib/knowledge-graph/resolver.ts`) capabilities. There are API routes for the knowledge graph already (or to be assumed at `POST /api/knowledge-graph/index`, `GET /api/knowledge-graph/query`, `GET /api/knowledge-graph/entity/[id]`).

This task adds a UI page at `app/(app)/knowledge-graph/page.tsx` to expose the knowledge graph visually: repo status, manual re-indexing, entity search, and entity detail with dependency graph. All components should use shadcn/ui primitives and follow the patterns in `app/(app)/page.tsx` and `app/(app)/work-items/`.

The route is protected (inside `app/(app)/` which uses auth middleware). The sidebar uses a list of nav items — we just need to add one more entry.

## Requirements

1. `app/(app)/knowledge-graph/page.tsx` must render without TypeScript errors and be a valid Next.js App Router page (can be a Client Component using `"use client"` since it needs interactivity).
2. **Status panel**: Fetch `GET /api/knowledge-graph/status` (or fall back gracefully if not yet implemented) and display a table/card per repo showing: repo name, last indexed timestamp, entity count, relationship count, commit SHA.
3. **Trigger indexing**: A button per repo row that calls `POST /api/knowledge-graph/index` with `{ repo }` body and shows loading/success/error feedback inline.
4. **Search bar**: An `<Input>` for name pattern, a `<Select>` for entity type filter (options: All, Function, Class, Interface, Variable, Import), and a `<Select>` for repo filter. Submitting queries `GET /api/knowledge-graph/query?pattern=...&type=...&repo=...`.
5. **Results table**: Show matching entities in a `<Table>` with columns: Name, Type, File Path, Lines.
6. **Entity detail panel**: Clicking a result row fetches `GET /api/knowledge-graph/entity/[id]` and displays a panel/card showing entity name, type, and two lists: Dependencies (what it imports) and Dependents (what imports it).
7. `components/sidebar.tsx` must include a "Knowledge Graph" nav link pointing to `/knowledge-graph`, using the same pattern as existing nav items (likely with a relevant Lucide icon such as `Network`).
8. All fetch calls must handle loading and error states gracefully (show a spinner or "Loading…" text, show error messages on failure).
9. No new dependencies beyond what's already in the project (`shadcn/ui`, `lucide-react`, etc.).

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/knowledge-graph-dashboard
```

### Step 1: Inspect existing patterns

Read these files to understand the exact patterns to follow before writing any code:

```bash
cat app/(app)/page.tsx
cat app/(app)/work-items/page.tsx 2>/dev/null || ls app/\(app\)/work-items/
cat components/sidebar.tsx
# Check what shadcn/ui components are available
ls components/ui/
# Check existing API routes to understand response shapes
ls app/api/knowledge-graph/ 2>/dev/null || echo "No KG API routes yet"
cat lib/knowledge-graph/query.ts 2>/dev/null | head -80
cat lib/knowledge-graph/indexer.ts 2>/dev/null | head -80
```

Note the exact import paths, component patterns, and nav item structure used in the sidebar. The new page and sidebar entry must match those patterns exactly.

### Step 2: Add Knowledge Graph nav item to sidebar

Open `components/sidebar.tsx` and add a "Knowledge Graph" entry to the navigation list. Based on the existing pattern (likely an array of `{ href, label, icon }` or JSX list items):

Add the import for the `Network` icon at the top:
```tsx
import { /* existing icons... */, Network } from "lucide-react";
```

Then add the nav item in the same location as existing items (e.g., after "Pipeline" or before "Settings"):
```tsx
{ href: "/knowledge-graph", label: "Knowledge Graph", icon: Network }
```

If the sidebar uses a different structure (e.g., inline JSX `<Link>` elements), match that structure exactly.

### Step 3: Create the knowledge graph page directory and file

```bash
mkdir -p "app/(app)/knowledge-graph"
```

Create `app/(app)/knowledge-graph/page.tsx` with the following structure. Adjust TypeScript interfaces to match the actual API response shapes discovered in Step 1.

```tsx
"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { RefreshCw, Search, Network } from "lucide-react";

// ── Types ──────────────────────────────────────────────────────────────────

interface RepoStatus {
  repo: string;
  lastIndexed: string | null;
  entityCount: number;
  relationshipCount: number;
  commitSha: string | null;
}

interface Entity {
  id: string;
  name: string;
  type: string;
  filePath: string;
  startLine: number;
  endLine: number;
  repo: string;
}

interface EntityDetail extends Entity {
  dependencies: Entity[];
  dependents: Entity[];
}

const ENTITY_TYPES = ["All", "Function", "Class", "Interface", "Variable", "Import"];

// ── Component ──────────────────────────────────────────────────────────────

export default function KnowledgeGraphPage() {
  // Status panel state
  const [statuses, setStatuses] = useState<RepoStatus[]>([]);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [indexingRepo, setIndexingRepo] = useState<string | null>(null);
  const [indexingResult, setIndexingResult] = useState<Record<string, string>>({});

  // Search state
  const [pattern, setPattern] = useState("");
  const [typeFilter, setTypeFilter] = useState("All");
  const [repoFilter, setRepoFilter] = useState("All");
  const [searchResults, setSearchResults] = useState<Entity[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // Entity detail state
  const [selectedEntity, setSelectedEntity] = useState<EntityDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  // ── Fetch status on mount ────────────────────────────────────────────────

  const fetchStatus = useCallback(async () => {
    setStatusLoading(true);
    setStatusError(null);
    try {
      const res = await fetch("/api/knowledge-graph/status");
      if (!res.ok) throw new Error(`Status fetch failed: ${res.status}`);
      const data = await res.json();
      // Expect { statuses: RepoStatus[] } or RepoStatus[]
      setStatuses(Array.isArray(data) ? data : (data.statuses ?? []));
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : "Failed to load status");
      setStatuses([]);
    } finally {
      setStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // ── Trigger indexing ────────────────────────────────────────────────────

  const triggerIndex = async (repo: string) => {
    setIndexingRepo(repo);
    setIndexingResult((prev) => ({ ...prev, [repo]: "indexing" }));
    try {
      const res = await fetch("/api/knowledge-graph/index", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `Request failed: ${res.status}`);
      }
      setIndexingResult((prev) => ({ ...prev, [repo]: "success" }));
      // Refresh status after a short delay
      setTimeout(fetchStatus, 2000);
    } catch (err) {
      setIndexingResult((prev) => ({
        ...prev,
        [repo]: `error: ${err instanceof Error ? err.message : "unknown"}`,
      }));
    } finally {
      setIndexingRepo(null);
    }
  };

  // ── Search ───────────────────────────────────────────────────────────────

  const handleSearch = async () => {
    if (!pattern.trim()) return;
    setSearching(true);
    setSearchError(null);
    setSelectedEntity(null);
    try {
      const params = new URLSearchParams({ pattern });
      if (typeFilter !== "All") params.set("type", typeFilter);
      if (repoFilter !== "All") params.set("repo", repoFilter);
      const res = await fetch(`/api/knowledge-graph/query?${params}`);
      if (!res.ok) throw new Error(`Query failed: ${res.status}`);
      const data = await res.json();
      setSearchResults(Array.isArray(data) ? data : (data.entities ?? data.results ?? []));
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : "Search failed");
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  };

  // ── Entity detail ────────────────────────────────────────────────────────

  const loadEntityDetail = async (entity: Entity) => {
    setDetailLoading(true);
    setDetailError(null);
    setSelectedEntity(null);
    try {
      const res = await fetch(`/api/knowledge-graph/entity/${encodeURIComponent(entity.id)}`);
      if (!res.ok) throw new Error(`Entity fetch failed: ${res.status}`);
      const data = await res.json();
      setSelectedEntity(data);
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : "Failed to load entity");
    } finally {
      setDetailLoading(false);
    }
  };

  // ── Repo options for search filter ──────────────────────────────────────

  const repoOptions = ["All", ...statuses.map((s) => s.repo)];

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center gap-3">
        <Network className="h-6 w-6" />
        <h1 className="text-2xl font-semibold">Knowledge Graph</h1>
      </div>

      {/* ── Status Panel ── */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>Indexed Repositories</CardTitle>
            <CardDescription>Snapshot info for each indexed repo</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={fetchStatus} disabled={statusLoading}>
            <RefreshCw className={`h-4 w-4 mr-2 ${statusLoading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </CardHeader>
        <CardContent>
          {statusError && (
            <p className="text-sm text-destructive mb-4">{statusError}</p>
          )}
          {statusLoading ? (
            <p className="text-sm text-muted-foreground">Loading status…</p>
          ) : statuses.length === 0 ? (
            <p className="text-sm text-muted-foreground">No repos indexed yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Repo</TableHead>
                  <TableHead>Last Indexed</TableHead>
                  <TableHead>Entities</TableHead>
                  <TableHead>Relationships</TableHead>
                  <TableHead>Commit SHA</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {statuses.map((s) => (
                  <TableRow key={s.repo}>
                    <TableCell className="font-mono text-sm">{s.repo}</TableCell>
                    <TableCell className="text-sm">
                      {s.lastIndexed
                        ? new Date(s.lastIndexed).toLocaleString()
                        : "Never"}
                    </TableCell>
                    <TableCell>{s.entityCount}</TableCell>
                    <TableCell>{s.relationshipCount}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {s.commitSha ? s.commitSha.slice(0, 8) : "—"}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => triggerIndex(s.repo)}
                          disabled={indexingRepo === s.repo}
                        >
                          {indexingRepo === s.repo ? (
                            <>
                              <RefreshCw className="h-3 w-3 mr-1 animate-spin" />
                              Indexing…
                            </>
                          ) : (
                            "Re-index"
                          )}
                        </Button>
                        {indexingResult[s.repo] && (
                          <span
                            className={`text-xs ${
                              indexingResult[s.repo] === "success"
                                ? "text-green-600"
                                : indexingResult[s.repo].startsWith("error")
                                ? "text-destructive"
                                : "text-muted-foreground"
                            }`}
                          >
                            {indexingResult[s.repo] === "success"
                              ? "✓ Done"
                              : indexingResult[s.repo] === "indexing"
                              ? "Running…"
                              : indexingResult[s.repo]}
                          </span>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* ── Search Panel ── */}
      <Card>
        <CardHeader>
          <CardTitle>Search Entities</CardTitle>
          <CardDescription>Query the graph by name pattern, type, or repo</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex gap-3 flex-wrap">
            <Input
              placeholder="Search by name (e.g. fetchStatus)"
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
              className="max-w-sm"
            />
            <Select value={typeFilter} onValueChange={setTypeFilter}>
              <SelectTrigger className="w-40">
                <SelectValue placeholder="Type" />
              </SelectTrigger>
              <SelectContent>
                {ENTITY_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={repoFilter} onValueChange={setRepoFilter}>
              <SelectTrigger className="w-56">
                <SelectValue placeholder="Repo" />
              </SelectTrigger>
              <SelectContent>
                {repoOptions.map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button onClick={handleSearch} disabled={searching || !pattern.trim()}>
              <Search className="h-4 w-4 mr-2" />
              {searching ? "Searching…" : "Search"}
            </Button>
          </div>

          {searchError && (
            <p className="text-sm text-destructive">{searchError}</p>
          )}

          {searchResults.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>File Path</TableHead>
                  <TableHead>Lines</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {searchResults.map((entity) => (
                  <TableRow
                    key={entity.id}
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => loadEntityDetail(entity)}
                  >
                    <TableCell className="font-mono text-sm font-medium">
                      {entity.name}
                    </TableCell>
                    <TableCell>
                      <span className="text-xs bg-muted px-2 py-0.5 rounded-full">
                        {entity.type}
                      </span>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {entity.filePath}
                    </TableCell>
                    <TableCell className="text-sm">
                      {entity.startLine}–{entity.endLine}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          {!searching && searchResults.length === 0 && pattern && !searchError && (
            <p className="text-sm text-muted-foreground">No results.</p>
          )}
        </CardContent>
      </Card>

      {/* ── Entity Detail Panel ── */}
      {(detailLoading || detailError || selectedEntity) && (
        <Card>
          <CardHeader>
            <CardTitle>Entity Detail</CardTitle>
            {selectedEntity && (
              <CardDescription>
                {selectedEntity.type} · {selectedEntity.filePath}:{selectedEntity.startLine}
              </CardDescription>
            )}
          </CardHeader>
          <CardContent>
            {detailLoading && (
              <p className="text-sm text-muted-foreground">Loading…</p>
            )}
            {detailError && (
              <p className="text-sm text-destructive">{detailError}</p>
            )}
            {selectedEntity && (
              <div className="flex flex-col gap-6">
                <div>
                  <h3 className="font-semibold mb-1">{selectedEntity.name}</h3>
                  <p className="text-sm text-muted-foreground">
                    {selectedEntity.repo} · Lines {selectedEntity.startLine}–{selectedEntity.endLine}
                  </p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {/* Dependencies */}
                  <div>
                    <h4 className="text-sm font-semibold mb-2">
                      Dependencies ({selectedEntity.dependencies?.length ?? 0})
                    </h4>
                    {selectedEntity.dependencies?.length ? (
                      <ul className="space-y-1">
                        {selectedEntity.dependencies.map((dep) => (
                          <li
                            key={dep.id}
                            className="text-sm font-mono text-muted-foreground hover:text-foreground cursor-pointer"
                            onClick={() => loadEntityDetail(dep)}
                          >
                            {dep.name}
                            <span className="ml-2 text-xs opacity-60">{dep.type}</span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-sm text-muted-foreground">None</p>
                    )}
                  </div>

                  {/* Dependents */}
                  <div>
                    <h4 className="text-sm font-semibold mb-2">
                      Dependents ({selectedEntity.dependents?.length ?? 0})
                    </h4>
                    {selectedEntity.dependents?.length ? (
                      <ul className="space-y-1">
                        {selectedEntity.dependents.map((dep) => (
                          <li
                            key={dep.id}
                            className="text-sm font-mono text-muted-foreground hover:text-foreground cursor-pointer"
                            onClick={() => loadEntityDetail(dep)}
                          >
                            {dep.name}
                            <span className="ml-2 text-xs opacity-60">{dep.type}</span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-sm text-muted-foreground">None</p>
                    )}
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
```

### Step 4: Check for missing shadcn/ui components

Verify the components used in the page are present:

```bash
ls components/ui/ | grep -E "^(card|input|select|button|table)\.tsx$"
```

If any are missing, add them via the shadcn CLI (or manually copy the component pattern used elsewhere). For example:

```bash
# Only run these for missing components
npx shadcn@latest add card 2>/dev/null || true
npx shadcn@latest add input 2>/dev/null || true
npx shadcn@latest add select 2>/dev/null || true
npx shadcn@latest add button 2>/dev/null || true
npx shadcn@latest add table 2>/dev/null || true
```

### Step 5: Check for a status API route and create a stub if missing

```bash
ls app/api/knowledge-graph/ 2>/dev/null
```

If there is no `status/route.ts`, create a minimal stub so the page doesn't 404 at runtime (the page handles errors gracefully, but a 404 is less useful than an empty response):

```bash
mkdir -p app/api/knowledge-graph/status
```

Create `app/api/knowledge-graph/status/route.ts` only if it doesn't already exist:

```ts
import { NextResponse } from "next/server";

// Stub: returns empty statuses until the knowledge graph indexer
// populates actual snapshot data.
export async function GET() {
  return NextResponse.json({ statuses: [] });
}
```

Do NOT create stubs for `/api/knowledge-graph/index`, `/api/knowledge-graph/query`, or `/api/knowledge-graph/entity/[id]` — these should already exist from the knowledge-graph implementation work items. If they don't exist, the page handles the errors gracefully.

### Step 6: TypeScript verification

```bash
npx tsc --noEmit
```

Fix any type errors before proceeding. Common issues to watch for:
- Missing or mismatched imports (check exact casing of component filenames)
- `any` types that need explicit annotation
- Incorrect shadcn/ui prop types (check existing usage in other pages)

### Step 7: Build verification

```bash
npm run build
```

If the build fails due to missing API routes (Next.js static analysis), ensure the route stubs exist. If it fails due to missing shadcn/ui components, add them in Step 4.

### Step 8: Commit, push, open PR

```bash
git add -A
git commit -m "feat: add knowledge graph dashboard page and sidebar nav"
git push origin feat/knowledge-graph-dashboard
gh pr create \
  --title "feat: add knowledge graph dashboard page" \
  --body "## Summary

Adds a new Knowledge Graph page at \`/knowledge-graph\` to the Agent Forge dashboard.

## Features
- **Status panel**: Shows indexed repos with last indexed time, entity count, relationship count, and commit SHA
- **Re-index button**: Triggers \`POST /api/knowledge-graph/index\` per repo with inline loading/success/error feedback
- **Search interface**: Name pattern input + entity type filter + repo filter, queries \`GET /api/knowledge-graph/query\`
- **Results table**: Displays matching entities with name, type, file path, and line numbers
- **Entity detail**: Click any row to load \`GET /api/knowledge-graph/entity/[id]\` and view dependencies/dependents
- **Sidebar nav**: Added 'Knowledge Graph' link with Network icon to sidebar

## Files Changed
- \`app/(app)/knowledge-graph/page.tsx\` — new page (client component)
- \`components/sidebar.tsx\` — added nav item
- \`app/api/knowledge-graph/status/route.ts\` — stub if not already present

## Testing
- \`npx tsc --noEmit\` passes
- \`npm run build\` passes
- Page renders at /knowledge-graph with graceful error handling for missing/empty API data
"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report:

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/knowledge-graph-dashboard
FILES CHANGED: [list of modified files]
SUMMARY: [what was completed]
ISSUES: [what failed or is incomplete]
NEXT STEPS: [what remains — e.g., "sidebar.tsx not updated", "TypeScript errors in select component"]
```

## Escalation Protocol

If you encounter a blocker you cannot resolve autonomously (e.g., shadcn/ui component API has changed significantly, sidebar uses an undocumented pattern, knowledge graph API routes have different response shapes than expected):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "add-knowledge-graph-dashboard-page",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["app/(app)/knowledge-graph/page.tsx", "components/sidebar.tsx"]
    }
  }'
```