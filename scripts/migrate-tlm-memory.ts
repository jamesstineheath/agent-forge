#!/usr/bin/env node
// scripts/migrate-tlm-memory.ts
//
// Migrates docs/tlm-memory.md entries into the BlobEpisodeStore.
// Usage:
//   npx tsx scripts/migrate-tlm-memory.ts [--file path/to/tlm-memory.md]
//   npx tsx scripts/migrate-tlm-memory.ts [--repo owner/name]
//
// Requires environment: BLOB_READ_WRITE_TOKEN, GH_PAT (if --repo)

import fs from "fs";
import path from "path";
import {
  parseTlmMemory,
  legacyEntryToEpisode,
  contentHash,
  BlobEpisodeStore,
} from "../lib/episode-compat";

// -- Source reading --

async function readMarkdown(options: {
  file?: string;
  repo?: string;
}): Promise<string> {
  if (options.file) {
    return fs.readFileSync(path.resolve(options.file), "utf-8");
  }
  if (options.repo) {
    const { readRepoFile } = await import("../lib/github");
    const content = await readRepoFile(
      options.repo,
      "docs/tlm-memory.md"
    );
    if (!content)
      throw new Error(`docs/tlm-memory.md not found in ${options.repo}`);
    return content;
  }
  // Default: local file
  const localPath = path.resolve("docs/tlm-memory.md");
  if (fs.existsSync(localPath)) {
    return fs.readFileSync(localPath, "utf-8");
  }
  throw new Error(
    "No source specified. Use --file or --repo, or ensure docs/tlm-memory.md exists locally."
  );
}

// -- Main --

async function main() {
  const args = process.argv.slice(2);
  const fileIdx = args.indexOf("--file");
  const repoIdx = args.indexOf("--repo");

  const opts = {
    file: fileIdx >= 0 ? args[fileIdx + 1] : undefined,
    repo: repoIdx >= 0 ? args[repoIdx + 1] : undefined,
  };

  console.log("Reading tlm-memory.md...");
  const markdown = await readMarkdown(opts);
  console.log(`   ${markdown.length} characters read.`);

  console.log("Parsing entries...");
  const entries = parseTlmMemory(markdown);
  console.log(
    `   Found ${entries.length} entries (${entries.filter((e) => e.type === "hot_pattern").length} hot_pattern, ${entries.filter((e) => e.type === "outcome").length} outcome, ${entries.filter((e) => e.type === "lesson").length} lesson).`
  );

  if (entries.length === 0) {
    console.log(
      "No entries parsed. Check that docs/tlm-memory.md has ## Hot Patterns / ## Recent Outcomes / ## Lessons sections."
    );
    process.exit(0);
  }

  console.log("Connecting to episode store...");
  const store = new BlobEpisodeStore();

  let migrated = 0;
  let skipped = 0;
  let failed = 0;

  for (const entry of entries) {
    const hash = contentHash(entry);
    try {
      const existing = await store.findByHash(hash);
      if (existing) {
        skipped++;
        continue;
      }
      const episode = legacyEntryToEpisode(entry);
      await store.save(episode);
      migrated++;
      console.log(
        `   Migrated: ${entry.description.slice(0, 60)}...`
      );
    } catch (err) {
      failed++;
      console.error(
        `   Failed for "${entry.description.slice(0, 40)}...":`,
        err
      );
    }
  }

  console.log("\nMigration summary:");
  console.log(`   Total entries:  ${entries.length}`);
  console.log(`   Migrated:       ${migrated}`);
  console.log(`   Skipped:        ${skipped} (already exist)`);
  console.log(`   Failed:         ${failed}`);

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
