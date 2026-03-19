"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { FolderKanban, Zap, TableProperties, Columns3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { MultiSelectFilter } from "@/components/multi-select-filter";
import { WorkItemsTable } from "@/components/work-items-table";
import { WorkItemsKanban } from "@/components/work-items-kanban";
import { useWorkItems, useRepos, useProjects } from "@/lib/hooks";
import type { WorkItem } from "@/lib/types";

const STATUS_OPTIONS: { label: string; value: WorkItem["status"] }[] = [
  { label: "Filed", value: "filed" },
  { label: "Ready", value: "ready" },
  { label: "Queued", value: "queued" },
  { label: "Generating", value: "generating" },
  { label: "Executing", value: "executing" },
  { label: "Reviewing", value: "reviewing" },
  { label: "Merged", value: "merged" },
  { label: "Failed", value: "failed" },
  { label: "Retrying", value: "retrying" },
  { label: "Parked", value: "parked" },
  { label: "Escalated", value: "escalated" },
  { label: "Verified", value: "verified" },
  { label: "Partial", value: "partial" },
];

const PRIORITY_OPTIONS: { label: string; value: WorkItem["priority"] }[] = [
  { label: "High", value: "high" },
  { label: "Medium", value: "medium" },
  { label: "Low", value: "low" },
];

export default function WorkItemsPage() {
  const router = useRouter();
  const [statusFilters, setStatusFilters] = useState<WorkItem["status"][]>([]);
  const [priorityFilters, setPriorityFilters] = useState<WorkItem["priority"][]>([]);
  const [repoFilters, setRepoFilters] = useState<string[]>([]);
  const [projectFilters, setProjectFilters] = useState<string[]>([]);
  const [sourceFilter, setSourceFilter] = useState<"" | "direct">("");

  const { data: items, isLoading, error } = useWorkItems();
  const { data: repos } = useRepos();
  const { data: projects } = useProjects();

  const repoOptions = (repos ?? []).map((r) => ({
    label: r.fullName.split("/").pop() ?? r.fullName,
    value: r.fullName,
  }));

  const projectOptions = (projects ?? []).map((p) => ({
    label: p.title,
    value: p.projectId,
  }));

  // Build a map of projectId -> matching targetRepo prefixes for filtering
  const projectRepoMap = new Map(
    (projects ?? [])
      .filter((p) => p.targetRepo)
      .map((p) => [p.projectId, `jamesstineheath/${p.targetRepo}`])
  );

  const filteredItems = items?.filter((item) => {
    if (statusFilters.length > 0 && !statusFilters.includes(item.status)) return false;
    if (priorityFilters.length > 0 && !priorityFilters.includes(item.priority)) return false;
    if (repoFilters.length > 0 && !repoFilters.includes(item.targetRepo)) return false;
    if (projectFilters.length > 0) {
      const matchesProject = projectFilters.some((pid) =>
        (item.source?.type === "project" && item.source?.sourceId === pid) ||
        item.targetRepo === projectRepoMap.get(pid)
      );
      if (!matchesProject) return false;
    }
    if (sourceFilter === "direct" && item.source?.type !== "direct") return false;
    return true;
  });

  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({
    title: "",
    description: "",
    targetRepo: "",
    sourceType: "manual" as "pa-improvement" | "github-issue" | "manual",
    priority: "medium" as WorkItem["priority"],
    riskLevel: "medium" as WorkItem["riskLevel"],
    complexity: "moderate" as WorkItem["complexity"],
  });
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function handleCreateItem(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setFormError(null);

    try {
      const res = await fetch("/api/work-items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: formData.title,
          description: formData.description,
          targetRepo: formData.targetRepo,
          source: { type: formData.sourceType },
          priority: formData.priority,
          riskLevel: formData.riskLevel,
          complexity: formData.complexity,
          dependencies: [],
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Failed to create work item");
      }

      const created = await res.json();
      setShowForm(false);
      router.push(`/work-items/${created.id}`);
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : "Failed to create work item"
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <header className="sticky top-0 z-10 glass-header border-b border-border">
        <div className="flex items-center justify-between px-6 py-3.5">
          <div>
            <h1 className="text-lg font-display font-bold text-foreground">Work Items</h1>
            <p className="text-[11px] font-medium text-muted-foreground">
              All work items across repos
            </p>
          </div>
          <Button size="sm" onClick={() => setShowForm(!showForm)}>
            {showForm ? "Cancel" : "New Work Item"}
          </Button>
        </div>
      </header>

      <div className="p-4 md:p-6 dot-grid min-h-[calc(100vh-60px)]">
        <div className="space-y-6">
          {showForm && (
            <div className="max-w-5xl rounded-xl card-elevated bg-surface-1 p-5">
              <h2 className="text-sm font-display font-bold text-foreground mb-4">New Work Item</h2>
              <form onSubmit={handleCreateItem} className="space-y-4">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="sm:col-span-2 space-y-1">
                    <label className="text-[12px] font-medium text-foreground">
                      Title <span className="text-status-blocked">*</span>
                    </label>
                    <Input
                      value={formData.title}
                      onChange={(e) =>
                        setFormData((p) => ({ ...p, title: e.target.value }))
                      }
                      required
                      placeholder="Brief description of the work"
                    />
                  </div>
                  <div className="sm:col-span-2 space-y-1">
                    <label className="text-[12px] font-medium text-foreground">
                      Description <span className="text-status-blocked">*</span>
                    </label>
                    <textarea
                      className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      rows={3}
                      value={formData.description}
                      onChange={(e) =>
                        setFormData((p) => ({
                          ...p,
                          description: e.target.value,
                        }))
                      }
                      required
                      placeholder="Detailed description of what needs to be done"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[12px] font-medium text-foreground">
                      Target Repo <span className="text-status-blocked">*</span>
                    </label>
                    <select
                      className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
                      value={formData.targetRepo}
                      onChange={(e) =>
                        setFormData((p) => ({
                          ...p,
                          targetRepo: e.target.value,
                        }))
                      }
                      required
                    >
                      <option value="">Select repo...</option>
                      {repos?.map((r) => (
                        <option key={r.id} value={r.fullName}>
                          {r.fullName}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label className="text-[12px] font-medium text-foreground">Source Type</label>
                    <select
                      className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
                      value={formData.sourceType}
                      onChange={(e) =>
                        setFormData((p) => ({
                          ...p,
                          sourceType: e.target.value as typeof formData.sourceType,
                        }))
                      }
                    >
                      <option value="manual">Manual</option>
                      <option value="pa-improvement">PA Improvement</option>
                      <option value="github-issue">GitHub Issue</option>
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label className="text-[12px] font-medium text-foreground">Priority</label>
                    <select
                      className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
                      value={formData.priority}
                      onChange={(e) =>
                        setFormData((p) => ({
                          ...p,
                          priority: e.target.value as WorkItem["priority"],
                        }))
                      }
                    >
                      <option value="high">High</option>
                      <option value="medium">Medium</option>
                      <option value="low">Low</option>
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label className="text-[12px] font-medium text-foreground">Risk Level</label>
                    <select
                      className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
                      value={formData.riskLevel}
                      onChange={(e) =>
                        setFormData((p) => ({
                          ...p,
                          riskLevel: e.target.value as WorkItem["riskLevel"],
                        }))
                      }
                    >
                      <option value="low">Low</option>
                      <option value="medium">Medium</option>
                      <option value="high">High</option>
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label className="text-[12px] font-medium text-foreground">Complexity</label>
                    <select
                      className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
                      value={formData.complexity}
                      onChange={(e) =>
                        setFormData((p) => ({
                          ...p,
                          complexity: e.target.value as WorkItem["complexity"],
                        }))
                      }
                    >
                      <option value="simple">Simple</option>
                      <option value="moderate">Moderate</option>
                      <option value="complex">Complex</option>
                    </select>
                  </div>
                </div>
                {formError && (
                  <p className="text-sm text-status-blocked">{formError}</p>
                )}
                <div className="flex gap-2">
                  <Button type="submit" disabled={submitting} size="sm">
                    {submitting ? "Creating..." : "Create Work Item"}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setShowForm(false)}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            </div>
          )}

          {/* Filter bar */}
          <div className="flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center md:gap-3">
            <MultiSelectFilter
              label="Statuses"
              options={STATUS_OPTIONS}
              selected={statusFilters}
              onChange={setStatusFilters}
            />
            <MultiSelectFilter
              label="Priorities"
              options={PRIORITY_OPTIONS}
              selected={priorityFilters}
              onChange={setPriorityFilters}
            />
            <MultiSelectFilter
              label="Repos"
              options={repoOptions}
              selected={repoFilters}
              onChange={setRepoFilters}
            />
            <MultiSelectFilter
              label="Projects"
              options={projectOptions}
              selected={projectFilters}
              onChange={setProjectFilters}
            />
            <button
              className={cn(
                "rounded-lg border px-3 py-2 text-sm font-medium transition-colors",
                sourceFilter === "direct"
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-input bg-background text-muted-foreground hover:bg-accent"
              )}
              onClick={() =>
                setSourceFilter(sourceFilter === "direct" ? "" : "direct")
              }
            >
              <Zap className="inline h-3 w-3 mr-1" />
              Fast Lane
            </button>
          </div>

          {/* Content */}
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading...</p>
          ) : error ? (
            <p className="text-sm text-status-blocked">Failed to load work items.</p>
          ) : !filteredItems || filteredItems.length === 0 ? (
            <div className="rounded-xl card-elevated bg-surface-1 p-12 text-center">
              <FolderKanban className="h-8 w-8 text-muted-foreground/20 mx-auto mb-3" />
              <p className="text-[14px] font-display font-bold text-foreground">No work items</p>
              <p className="text-[12px] text-muted-foreground mt-1">
                No work items match the current filters
              </p>
              <Button
                className="mt-4"
                variant="outline"
                size="sm"
                onClick={() => setShowForm(true)}
              >
                Create your first work item
              </Button>
            </div>
          ) : (
            <Tabs defaultValue="table">
              <TabsList>
                <TabsTrigger value="table">
                  <TableProperties className="h-3.5 w-3.5" />
                  Table
                </TabsTrigger>
                <TabsTrigger value="board">
                  <Columns3 className="h-3.5 w-3.5" />
                  Board
                </TabsTrigger>
              </TabsList>
              <TabsContent value="table">
                <WorkItemsTable items={filteredItems} />
              </TabsContent>
              <TabsContent value="board">
                <WorkItemsKanban items={filteredItems} />
              </TabsContent>
            </Tabs>
          )}
        </div>
      </div>
    </>
  );
}
