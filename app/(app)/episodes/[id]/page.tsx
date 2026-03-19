"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { useEpisode } from "@/lib/hooks";

function formatDate(ts?: string | null): string {
  if (!ts) return "-";
  return new Date(ts).toLocaleString();
}

const OUTCOME_COLORS: Record<string, string> = {
  success: "bg-status-merged/15 text-status-merged",
  failure: "bg-status-blocked/15 text-status-blocked",
  partial: "bg-orange-500/15 text-orange-600",
  unknown: "bg-muted text-muted-foreground",
};

export default function EpisodeDetailPage() {
  const params = useParams();
  const id = params?.id as string;
  const { data: episode, isLoading, error } = useEpisode(id);

  if (isLoading) {
    return (
      <div className="p-4 md:p-6">
        <p className="text-[12px] text-muted-foreground">Loading...</p>
      </div>
    );
  }

  if (error || !episode) {
    return (
      <div className="p-4 md:p-6 space-y-6">
        <h1 className="text-lg font-display font-bold text-foreground">Episode</h1>
        <p className="text-[12px] text-status-blocked">
          {error ? "Failed to load episode." : "Episode not found."}
        </p>
        <Link href="/episodes" className={buttonVariants({ variant: "outline" })}>
          Back to Episodes
        </Link>
      </div>
    );
  }

  return (
    <>
      {/* Sticky glass header */}
      <header className="sticky top-0 z-10 glass-header border-b border-border">
        <div className="flex items-center justify-between px-6 py-3.5">
          <h1 className="text-lg font-display font-bold text-foreground truncate">
            Episode Detail
          </h1>
          <Link href="/episodes" className={buttonVariants({ variant: "outline" })}>
            Back
          </Link>
        </div>
      </header>

      <div className="p-4 md:p-6 dot-grid min-h-[calc(100vh-60px)]">
        <div className="max-w-4xl space-y-4">
          {/* Task Context */}
          <div className="rounded-xl card-elevated bg-surface-1 p-4 space-y-3">
            <h2 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
              Task Context
            </h2>
            <dl className="grid grid-cols-1 gap-3 text-[12px]">
              <div>
                <dt className="text-muted-foreground">Task Description</dt>
                <dd className="font-medium text-foreground whitespace-pre-wrap">
                  {episode.taskDescription || "-"}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Repository</dt>
                <dd className="font-medium text-foreground">{episode.repoSlug || "-"}</dd>
              </div>
              {episode.tags && episode.tags.length > 0 && (
                <div>
                  <dt className="text-muted-foreground mb-1">Tags</dt>
                  <dd className="flex flex-wrap gap-1.5">
                    {episode.tags.map((tag) => (
                      <Badge key={tag} variant="secondary">
                        {tag}
                      </Badge>
                    ))}
                  </dd>
                </div>
              )}
            </dl>
          </div>

          {/* Approach */}
          <div className="rounded-xl card-elevated bg-surface-1 p-4 space-y-3">
            <h2 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
              Approach
            </h2>
            <p className="text-[12px] text-foreground whitespace-pre-wrap">
              {episode.approach || "-"}
            </p>
          </div>

          {/* Outcome */}
          <div className="rounded-xl card-elevated bg-surface-1 p-4 space-y-3">
            <h2 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
              Outcome
            </h2>
            <div className="space-y-2 text-[12px]">
              {episode.outcome && (
                <div>
                  <dt className="text-muted-foreground mb-1">Status</dt>
                  <dd>
                    <Badge
                      className={
                        OUTCOME_COLORS[episode.outcome.toLowerCase()] ??
                        "bg-muted text-muted-foreground"
                      }
                    >
                      {episode.outcome}
                    </Badge>
                  </dd>
                </div>
              )}
              {episode.outcomeDetail && (
                <div>
                  <dt className="text-muted-foreground">Detail</dt>
                  <dd className="text-foreground whitespace-pre-wrap mt-1">
                    {episode.outcomeDetail}
                  </dd>
                </div>
              )}
            </div>
          </div>

          {/* Insights */}
          {episode.insights && episode.insights.length > 0 && (
            <div className="rounded-xl card-elevated bg-surface-1 p-4 space-y-3">
              <h2 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
                Insights
              </h2>
              <ul className="list-disc list-inside space-y-1 text-[12px] text-foreground">
                {episode.insights.map((insight, i) => (
                  <li key={i}>{insight}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Files Changed */}
          {episode.filesChanged && episode.filesChanged.length > 0 && (
            <div className="rounded-xl card-elevated bg-surface-1 p-4 space-y-3">
              <h2 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
                Files Changed
              </h2>
              <ul className="space-y-1">
                {episode.filesChanged.map((file, i) => (
                  <li
                    key={i}
                    className="font-mono text-[11px] text-foreground bg-muted px-2 py-1 rounded"
                  >
                    {file}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Links */}
          {(episode.workItemId || episode.projectId) && (
            <div className="rounded-xl card-elevated bg-surface-1 p-4 space-y-3">
              <h2 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
                Links
              </h2>
              <ul className="space-y-1 text-[12px]">
                {episode.workItemId && (
                  <li>
                    <Link
                      href={`/work-items/${episode.workItemId}`}
                      className="text-primary hover:underline"
                    >
                      Work Item: {episode.workItemId}
                    </Link>
                  </li>
                )}
                {episode.projectId && (
                  <li>
                    <Link
                      href={`/projects/${episode.projectId}`}
                      className="text-primary hover:underline"
                    >
                      Project: {episode.projectId}
                    </Link>
                  </li>
                )}
              </ul>
            </div>
          )}

          {/* Metadata */}
          <div className="rounded-xl card-elevated bg-surface-1 p-4 space-y-3">
            <h2 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
              Metadata
            </h2>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 text-[12px]">
              <div>
                <dt className="text-muted-foreground">ID</dt>
                <dd className="font-mono font-medium text-foreground break-all">{episode.id}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Created</dt>
                <dd className="font-medium text-foreground">{formatDate(episode.createdAt)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Updated</dt>
                <dd className="font-medium text-foreground">{formatDate(episode.updatedAt)}</dd>
              </div>
            </dl>
          </div>
        </div>
      </div>
    </>
  );
}
