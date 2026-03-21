import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { workItems } from "@/lib/db/schema";
import { loadJson } from "@/lib/storage";
import type { WorkItem, WorkItemIndexEntry } from "@/lib/types";
import { sql } from "drizzle-orm";

/**
 * One-time migration: copies all work items from Vercel Blob to Neon Postgres.
 * POST /api/admin/migrate-work-items
 *
 * Requires session auth (Google OAuth).
 * Idempotent: uses ON CONFLICT DO NOTHING so re-runs are safe.
 */
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json(
      { error: "BLOB_READ_WRITE_TOKEN required for migration (reads from Blob)" },
      { status: 400 }
    );
  }

  try {
    // Step 1: List all work item blobs
    const { list } = await import("@vercel/blob");
    const { blobs } = await list({
      prefix: "af-data/work-items/",
      mode: "folded",
    });

    const itemBlobs = blobs.filter((b) => {
      const id = b.pathname
        .replace("af-data/work-items/", "")
        .replace(".json", "");
      return id && id !== "index";
    });

    console.log(
      `[migrate] Found ${itemBlobs.length} work item blobs to migrate`
    );

    let migrated = 0;
    let skipped = 0;
    let skippedCancelled = 0;
    let errors = 0;
    const errorDetails: string[] = [];

    // Items older than 7 days in cancelled status are historical noise
    const CANCELLED_CUTOFF_MS = 7 * 24 * 60 * 60 * 1000;

    // Step 2: Load each blob and insert into Postgres in batches
    const BATCH_SIZE = 50;
    for (let i = 0; i < itemBlobs.length; i += BATCH_SIZE) {
      const batch = itemBlobs.slice(i, i + BATCH_SIZE);
      const rows: Array<typeof workItems.$inferInsert> = [];

      for (const blob of batch) {
        const id = blob.pathname
          .replace("af-data/work-items/", "")
          .replace(".json", "");
        try {
          const item = await loadJson<WorkItem>(`work-items/${id}`, {
            required: true,
          });
          if (!item) {
            skipped++;
            continue;
          }

          // Skip old cancelled items (>7 days) — historical noise
          if (
            item.status === "cancelled" &&
            item.updatedAt &&
            Date.now() - new Date(item.updatedAt).getTime() > CANCELLED_CUTOFF_MS
          ) {
            skippedCancelled++;
            continue;
          }

          // Derive prd_id for project-sourced items with PRD- prefix
          let prdId: string | null = null;
          if (
            item.source?.type === "project" &&
            item.source?.sourceId?.startsWith("PRD-")
          ) {
            prdId = item.source.sourceId;
          }

          rows.push({
            id: item.id,
            title: item.title,
            description: item.description || "",
            targetRepo: item.targetRepo,
            status: item.status,
            priority: item.priority,
            riskLevel: item.riskLevel || "medium",
            complexity: item.complexity || "moderate",
            type: item.type,
            source: item.source,
            dependencies: item.dependencies || [],
            triggeredBy: item.triggeredBy,
            complexityHint: item.complexityHint,
            expedite: item.expedite,
            triagePriority: item.triagePriority,
            rank: item.rank,
            handoff: item.handoff,
            execution: item.execution,
            retryBudget: item.retryBudget,
            blockedReason: item.blockedReason,
            escalation: item.escalation,
            failureCategory: item.failureCategory,
            attribution: item.attribution,
            reasoningMetrics: item.reasoningMetrics,
            prdId,
            createdAt: new Date(item.createdAt),
            updatedAt: new Date(item.updatedAt),
          });
        } catch (err) {
          errors++;
          errorDetails.push(
            `${id}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }

      if (rows.length > 0) {
        // ON CONFLICT DO NOTHING for idempotency
        await db.insert(workItems).values(rows).onConflictDoNothing();
        migrated += rows.length;
      }
    }

    // Step 3: Verify count
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(workItems);
    const dbCount = Number(countResult[0]?.count ?? 0);

    return NextResponse.json({
      message: `Migration complete`,
      blobsFound: itemBlobs.length,
      migrated,
      skipped,
      skippedCancelled,
      errors,
      errorDetails: errorDetails.slice(0, 20), // cap at 20
      dbCount,
    });
  } catch (err) {
    console.error("[migrate] Migration failed:", err);
    return NextResponse.json(
      {
        error: "Migration failed",
        details: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  }
}
