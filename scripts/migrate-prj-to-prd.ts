/**
 * One-time migration script: PRJ-XX → PRD-XX sourceId format.
 *
 * Queries all work items in Neon Postgres that have source.sourceId
 * matching the legacy "PRJ-*" format, maps them to "PRD-*" format,
 * and updates the database.
 *
 * Usage:
 *   npx tsx scripts/migrate-prj-to-prd.ts [--dry-run]
 *
 * Flags:
 *   --dry-run   Print what would change without writing to the database.
 */

import { db } from "../lib/db";
import { workItems } from "../lib/db/schema";
import { sql, eq } from "drizzle-orm";

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  console.log(`[migrate-prj-to-prd] Starting migration${dryRun ? " (DRY RUN)" : ""}...`);

  // Find all work items with source.sourceId matching PRJ-*
  const rows = await db
    .select({ id: workItems.id, source: workItems.source })
    .from(workItems);

  const toUpdate: Array<{ id: string; oldSourceId: string; newSourceId: string }> = [];

  for (const row of rows) {
    const source = row.source as { type: string; sourceId?: string; sourceUrl?: string } | null;
    if (!source?.sourceId) continue;

    const match = source.sourceId.match(/^PRJ-(.+)$/);
    if (!match) continue;

    const newSourceId = `PRD-${match[1]}`;
    toUpdate.push({ id: row.id, oldSourceId: source.sourceId, newSourceId });
  }

  console.log(`[migrate-prj-to-prd] Found ${toUpdate.length} work items with PRJ-* sourceIds (out of ${rows.length} total).`);

  if (toUpdate.length === 0) {
    console.log("[migrate-prj-to-prd] Nothing to migrate.");
    return;
  }

  for (const item of toUpdate) {
    console.log(`  ${item.id}: ${item.oldSourceId} → ${item.newSourceId}`);

    if (!dryRun) {
      // Update the JSONB source.sourceId field
      await db
        .update(workItems)
        .set({
          source: sql`jsonb_set(${workItems.source}, '{sourceId}', ${JSON.stringify(item.newSourceId)}::jsonb)`,
        })
        .where(eq(workItems.id, item.id));
    }
  }

  console.log(`[migrate-prj-to-prd] ${dryRun ? "Would update" : "Updated"} ${toUpdate.length} work items.`);
}

main().catch((err) => {
  console.error("[migrate-prj-to-prd] Fatal error:", err);
  process.exit(1);
});
