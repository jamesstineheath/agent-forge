"use client";

import { use, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { DispatchButton } from "@/components/dispatch-button";
import { useWorkItem } from "@/lib/hooks";
import type { WorkItem } from "@/lib/types";

const LIFECYCLE: WorkItem["status"][] = [
  "filed",
  "ready",
  "generating",
  "executing",
  "reviewing",
  "merged",
];

const STATUS_COLORS: Record<WorkItem["status"], string> = {
  filed: "bg-gray-100 text-gray-700",
  ready: "bg-blue-100 text-blue-700",
  queued: "bg-blue-50 text-blue-600",
  generating: "bg-yellow-100 text-yellow-700",
  executing: "bg-amber-100 text-amber-700",
  reviewing: "bg-purple-100 text-purple-700",
  merged: "bg-green-100 text-green-700",
  failed: "bg-red-100 text-red-700",
  parked: "bg-slate-100 text-slate-600",
  blocked: "bg-red-200 text-red-800",
};

function formatDate(ts?: string | null): string {
  if (!ts) return "-";
  return new Date(ts).toLocaleString();
}

interface Props {
  params: Promise<{ id: string }>;
}

export default function WorkItemDetailPage({ params }: Props) {
  const { id } = use(params);
  const router = useRouter();
  const { data: item, isLoading, error, mutate } = useWorkItem(id);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  async function handleDelete() {
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/work-items/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Delete failed");
      }
      router.push("/work-items");
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Delete failed");
      setDeleting(false);
    }
  }

  if (isLoading) {
    return (
      <div className="space-y-6">
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    );
  }

  if (error || !item) {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-bold">Work Item</h1>
        <p className="text-sm text-red-600">
          {error ? "Failed to load work item." : "Work item not found."}
        </p>
        <Link href="/work-items" className={buttonVariants({ variant: "outline" })}>
          Back to Work Items
        </Link>
      </div>
    );
  }

  const lifecycleIndex = LIFECYCLE.indexOf(item.status);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Badge className={STATUS_COLORS[item.status]}>{item.status}</Badge>
          </div>
          <h1 className="text-2xl font-bold">{item.title}</h1>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <DispatchButton workItem={item} onSuccess={() => mutate()} />
          <Link href="/work-items" className={buttonVariants({ variant: "outline" })}>
            Back
          </Link>
        </div>
      </div>

      {/* Status timeline */}
      <Card>
        <CardContent className="py-4">
          <div className="flex items-center gap-1">
            {LIFECYCLE.map((s, i) => {
              const isPast = lifecycleIndex > i;
              const isCurrent = lifecycleIndex === i;
              const isFailed =
                (item.status === "failed" || item.status === "parked") &&
                i === LIFECYCLE.length - 1;
              return (
                <div key={s} className="flex items-center flex-1 last:flex-none">
                  <div
                    className={`h-2.5 w-2.5 rounded-full flex-shrink-0 ${
                      isFailed
                        ? "bg-red-400"
                        : isCurrent
                        ? "bg-blue-500 ring-2 ring-blue-200"
                        : isPast
                        ? "bg-green-400"
                        : "bg-gray-200"
                    }`}
                  />
                  <span
                    className={`mx-1 text-xs hidden sm:block ${
                      isCurrent
                        ? "font-medium text-blue-600"
                        : isPast
                        ? "text-green-600"
                        : "text-muted-foreground"
                    }`}
                  >
                    {s}
                  </span>
                  {i < LIFECYCLE.length - 1 && (
                    <div
                      className={`flex-1 h-px ${
                        isPast ? "bg-green-300" : "bg-gray-200"
                      }`}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Metadata */}
      <Card>
        <CardHeader>
          <CardTitle>Metadata</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 text-sm">
            <div>
              <dt className="text-muted-foreground">Target Repo</dt>
              <dd className="font-medium">{item.targetRepo}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Priority</dt>
              <dd className="font-medium">{item.priority}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Risk Level</dt>
              <dd className="font-medium">{item.riskLevel}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Complexity</dt>
              <dd className="font-medium">{item.complexity}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Source</dt>
              <dd className="font-medium">{item.source.type}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Created</dt>
              <dd className="font-medium">{formatDate(item.createdAt)}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      {/* Description */}
      <Card>
        <CardHeader>
          <CardTitle>Description</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm whitespace-pre-wrap">{item.description}</p>
        </CardContent>
      </Card>

      {/* Handoff */}
      {item.handoff && (
        <Card>
          <CardHeader>
            <CardTitle>Handoff</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex gap-4 text-sm">
              <span>
                <span className="text-muted-foreground">Branch: </span>
                <code className="font-mono">{item.handoff.branch}</code>
              </span>
              <span>
                <span className="text-muted-foreground">Budget: </span>
                <span>${item.handoff.budget}</span>
              </span>
              <span>
                <span className="text-muted-foreground">Generated: </span>
                <span>{formatDate(item.handoff.generatedAt)}</span>
              </span>
            </div>
            <Separator />
            <pre className="text-xs bg-muted rounded-md p-4 overflow-x-auto whitespace-pre-wrap">
              {item.handoff.content}
            </pre>
          </CardContent>
        </Card>
      )}

      {/* Execution */}
      {item.execution && (
        <Card>
          <CardHeader>
            <CardTitle>Execution</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              {item.execution.prUrl && (
                <div>
                  <dt className="text-muted-foreground">Pull Request</dt>
                  <dd>
                    <a
                      href={item.execution.prUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 hover:underline"
                    >
                      #{item.execution.prNumber}
                    </a>
                  </dd>
                </div>
              )}
              {item.execution.workflowRunId && (
                <div>
                  <dt className="text-muted-foreground">Workflow Run</dt>
                  <dd className="font-mono">{item.execution.workflowRunId}</dd>
                </div>
              )}
              {item.execution.outcome && (
                <div>
                  <dt className="text-muted-foreground">Outcome</dt>
                  <dd className="font-medium">{item.execution.outcome}</dd>
                </div>
              )}
              <div>
                <dt className="text-muted-foreground">Started</dt>
                <dd>{formatDate(item.execution.startedAt)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Completed</dt>
                <dd>{formatDate(item.execution.completedAt)}</dd>
              </div>
            </dl>
          </CardContent>
        </Card>
      )}

      {/* Actions */}
      <Card>
        <CardContent className="py-4">
          <div className="flex items-center gap-3">
            {!confirmDelete ? (
              <Button
                variant="destructive"
                onClick={() => setConfirmDelete(true)}
              >
                Delete
              </Button>
            ) : (
              <>
                <span className="text-sm text-red-600">
                  Are you sure?
                </span>
                <Button
                  variant="destructive"
                  onClick={handleDelete}
                  disabled={deleting}
                >
                  {deleting ? "Deleting..." : "Yes, Delete"}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setConfirmDelete(false)}
                >
                  Cancel
                </Button>
              </>
            )}
            {deleteError && (
              <p className="text-sm text-red-600">{deleteError}</p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
