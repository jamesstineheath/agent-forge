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
            <p className="text-sm text-muted-foreground">Loading status...</p>
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
                      {s.commitSha ? s.commitSha.slice(0, 8) : "\u2014"}
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
                              Indexing...
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
                              ? "Done"
                              : indexingResult[s.repo] === "indexing"
                              ? "Running..."
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
            <Select value={typeFilter} onValueChange={(v) => setTypeFilter(v ?? "All")}>
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
            <Select value={repoFilter} onValueChange={(v) => setRepoFilter(v ?? "All")}>
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
              {searching ? "Searching..." : "Search"}
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
              <p className="text-sm text-muted-foreground">Loading...</p>
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
