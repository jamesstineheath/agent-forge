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
    let errors = 0;
    const errorDetails: string[] = [];

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
