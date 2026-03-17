"use client";

import Link from "next/link";
import { useState } from "react";
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
    <div className="space-y-6 px-4 md:px-6">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-2xl md:text-3xl font-bold">Registered Repos</h1>
        <Link href="/repos/new" className={buttonVariants() + " min-h-[44px]"}>
          Add Repo
        </Link>
      </div>

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
        <p className="text-sm text-red-600">Failed to load repos.</p>
      ) : !repos || repos.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center">
            <p className="text-muted-foreground">No repos registered yet.</p>
            <Link href="/repos/new" className={buttonVariants() + " mt-4"}>
              Add your first repo
            </Link>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {repos.map((repo) => (
            <Card key={repo.id}>
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <CardTitle className="text-base leading-tight break-all">{repo.fullName}</CardTitle>
                    <p className="text-sm text-muted-foreground break-all">
                      {repo.shortName}
                    </p>
                  </div>
                  <Badge variant="outline" className="shrink-0 text-xs">
                    concurrency: {repo.concurrencyLimit}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span>Budget: ${repo.defaultBudget}</span>
                  <span>Handoffs: {repo.handoffDir}</span>
                  <span className="break-all">
                    Workflow: {repo.executeWorkflow}
                  </span>
                </div>
                <div className="flex flex-wrap gap-2 pt-1">
                  <Button
                    size="sm"
                    variant="outline"
                    className="min-h-[44px]"
                    onClick={() => setEditing(repo)}
                  >
                    Edit
                  </Button>
                  {confirmDelete === repo.id ? (
                    <div className="flex items-center gap-1">
                      <Button
                        size="sm"
                        variant="destructive"
                        className="min-h-[44px]"
                        onClick={() => handleDelete(repo.id)}
                        disabled={deleting}
                      >
                        {deleting ? "..." : "Confirm"}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="min-h-[44px]"
                        onClick={() => setConfirmDelete(null)}
                      >
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      className="min-h-[44px]"
                      onClick={() => setConfirmDelete(repo.id)}
                    >
                      Delete
                    </Button>
                  )}
                </div>
                {deleteError && confirmDelete === repo.id && (
                  <p className="text-xs text-red-600">{deleteError}</p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
