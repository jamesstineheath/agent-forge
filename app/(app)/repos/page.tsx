"use client";

import Link from "next/link";
import { useState } from "react";
import { BookMarked } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { RepoForm } from "@/components/repo-form";
import { useRepos } from "@/lib/hooks";
import type { RepoConfig } from "@/lib/types";

export default function ReposPage() {
  const { data: repos, isLoading, error, mutate } = useRepos();
  const [editing, setEditing] = useState<RepoConfig | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function handleDelete(id: string) {
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/repos/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Delete failed");
      }
      setConfirmDelete(null);
      mutate();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <header className="sticky top-0 z-10 glass-header border-b border-border">
        <div className="flex items-center justify-between px-6 py-3.5">
          <div>
            <h1 className="text-lg font-display font-bold text-foreground">Repos</h1>
            <p className="text-[11px] font-medium text-muted-foreground">
              Registered target repositories
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1.5 rounded-full bg-surface-2 px-3 py-1 text-[11px] font-medium text-muted-foreground ring-1 ring-border">
              <BookMarked className="h-3 w-3" />
              {repos?.length ?? 0} repos
            </span>
            <Link href="/repos/new" className={buttonVariants({ size: "sm" })}>
              Add Repo
            </Link>
          </div>
        </div>
      </header>

      <div className="p-4 md:p-6 dot-grid min-h-[calc(100vh-60px)]">
        <div className="max-w-5xl space-y-6">
          {editing && (
            <RepoForm
              existing={editing}
              onSuccess={() => {
                setEditing(null);
                mutate();
              }}
            />
          )}

          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading...</p>
          ) : error ? (
            <p className="text-sm text-status-blocked">Failed to load repos.</p>
          ) : !repos || repos.length === 0 ? (
            <div className="rounded-xl card-elevated bg-surface-1 p-12 text-center">
              <BookMarked className="h-8 w-8 text-muted-foreground/20 mx-auto mb-3" />
              <p className="text-[14px] font-display font-bold text-foreground">No repos registered</p>
              <p className="text-[12px] text-muted-foreground mt-1">
                Connect a repository to start orchestrating work
              </p>
              <Link href="/repos/new" className={buttonVariants() + " mt-4"}>
                Add your first repo
              </Link>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {repos.map((repo) => (
                <div key={repo.id} className="rounded-xl card-elevated bg-surface-1 overflow-hidden">
                  <div className="p-4 border-b border-border">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <h3 className="text-sm font-display font-bold text-foreground break-all">{repo.fullName}</h3>
                        <p className="text-[11px] text-muted-foreground break-all font-mono">
                          {repo.shortName}
                        </p>
                      </div>
                      <Badge variant="outline" className="shrink-0 text-[10px] font-bold">
                        concurrency: {repo.concurrencyLimit}
                      </Badge>
                    </div>
                  </div>
                  <div className="p-4 space-y-3">
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                      <span>Budget: ${repo.defaultBudget}</span>
                      <span>Handoffs: {repo.handoffDir}</span>
                      <span className="break-all font-mono">
                        Workflow: {repo.executeWorkflow}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-2 pt-1">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setEditing(repo)}
                      >
                        Edit
                      </Button>
                      {confirmDelete === repo.id ? (
                        <div className="flex items-center gap-1">
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={() => handleDelete(repo.id)}
                            disabled={deleting}
                          >
                            {deleting ? "..." : "Confirm"}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setConfirmDelete(null)}
                          >
                            Cancel
                          </Button>
                        </div>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setConfirmDelete(repo.id)}
                        >
                          Delete
                        </Button>
                      )}
                    </div>
                    {deleteError && confirmDelete === repo.id && (
                      <p className="text-xs text-status-blocked">{deleteError}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
