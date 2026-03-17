"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { WorkItemCard } from "@/components/work-item-card";
import { useWorkItems, useRepos } from "@/lib/hooks";
import type { WorkItem } from "@/lib/types";

const STATUS_OPTIONS: { label: string; value: WorkItem["status"] | "" }[] = [
  { label: "All Statuses", value: "" },
  { label: "Filed", value: "filed" },
  { label: "Ready", value: "ready" },
  { label: "Queued", value: "queued" },
  { label: "Generating", value: "generating" },
  { label: "Executing", value: "executing" },
  { label: "Reviewing", value: "reviewing" },
  { label: "Merged", value: "merged" },
  { label: "Failed", value: "failed" },
  { label: "Parked", value: "parked" },
  { label: "Escalated", value: "escalated" },
];

const PRIORITY_OPTIONS: { label: string; value: WorkItem["priority"] | "" }[] =
  [
    { label: "All Priorities", value: "" },
    { label: "High", value: "high" },
    { label: "Medium", value: "medium" },
    { label: "Low", value: "low" },
  ];

export default function WorkItemsPage() {
  const router = useRouter();
  const [statusFilter, setStatusFilter] = useState<
    WorkItem["status"] | ""
  >("");
  const [priorityFilter, setPriorityFilter] = useState<
    WorkItem["priority"] | ""
  >("");
  const [repoFilter, setRepoFilter] = useState("");
  const [sourceFilter, setSourceFilter] = useState<"" | "direct">("");

  const { data: items, isLoading, error } = useWorkItems({
    status: statusFilter || undefined,
    priority: priorityFilter || undefined,
    targetRepo: repoFilter || undefined,
  });
  const { data: repos } = useRepos();

  const filteredItems = items?.filter((item) =>
    sourceFilter === "direct" ? item.source?.type === "direct" : true
  );

  // New work item form state
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
    <div className="overflow-x-hidden space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">Work Items</h1>
        <Button className="min-h-[44px]" onClick={() => setShowForm(!showForm)}>
          {showForm ? "Cancel" : "New Work Item"}
        </Button>
      </div>

      {showForm && (
        <Card>
          <CardHeader>
            <CardTitle>New Work Item</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleCreateItem} className="space-y-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="sm:col-span-2 space-y-1">
                  <label className="text-sm font-medium">
                    Title <span className="text-red-500">*</span>
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
                  <label className="text-sm font-medium">
                    Description <span className="text-red-500">*</span>
                  </label>
                  <textarea
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
                  <label className="text-sm font-medium">
                    Target Repo <span className="text-red-500">*</span>
                  </label>
                  <select
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
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
                  <label className="text-sm font-medium">Source Type</label>
                  <select
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
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
                  <label className="text-sm font-medium">Priority</label>
                  <select
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
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
                  <label className="text-sm font-medium">Risk Level</label>
                  <select
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
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
                  <label className="text-sm font-medium">Complexity</label>
                  <select
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
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
                <p className="text-sm text-red-600">{formError}</p>
              )}
              <div className="flex gap-2">
                <Button type="submit" disabled={submitting} className="min-h-[44px]">
                  {submitting ? "Creating..." : "Create Work Item"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-[44px]"
                  onClick={() => setShowForm(false)}
                >
                  Cancel
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {/* Filter bar */}
      <div className="flex flex-col gap-2 md:flex-row md:flex-wrap md:gap-3">
        <select
          className="w-full md:w-auto rounded-md border border-input bg-background px-3 py-2 text-sm"
          value={statusFilter}
          onChange={(e) =>
            setStatusFilter(e.target.value as WorkItem["status"] | "")
          }
        >
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <select
          className="w-full md:w-auto rounded-md border border-input bg-background px-3 py-2 text-sm"
          value={priorityFilter}
          onChange={(e) =>
            setPriorityFilter(e.target.value as WorkItem["priority"] | "")
          }
        >
          {PRIORITY_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <select
          className="w-full md:w-auto rounded-md border border-input bg-background px-3 py-2 text-sm"
          value={repoFilter}
          onChange={(e) => setRepoFilter(e.target.value)}
        >
          <option value="">All Repos</option>
          {repos?.map((r) => (
            <option key={r.id} value={r.fullName}>
              {r.fullName}
            </option>
          ))}
        </select>
        <button
          className={`w-full md:w-auto rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
            sourceFilter === "direct"
              ? "border-green-500 bg-green-50 text-green-800"
              : "border-input bg-background text-muted-foreground hover:bg-accent"
          }`}
          onClick={() =>
            setSourceFilter(sourceFilter === "direct" ? "" : "direct")
          }
        >
          ⚡ Fast Lane
        </button>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading...</p>
      ) : error ? (
        <p className="text-sm text-red-600">Failed to load work items.</p>
      ) : !filteredItems || filteredItems.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center">
            <p className="text-muted-foreground">
              No work items match the current filters.
            </p>
            <Button
              className="mt-4 min-h-[44px]"
              variant="outline"
              onClick={() => setShowForm(true)}
            >
              Create your first work item
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filteredItems.map((item) => (
            <WorkItemCard key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}
