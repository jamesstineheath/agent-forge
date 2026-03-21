// scripts/diagnose-prj9.ts
// Run with: npx ts-node --project tsconfig.json scripts/diagnose-prj9.ts
// Requires NOTION_API_KEY and NOTION_PROJECTS_DB_ID in environment

import { Client } from "@notionhq/client";

async function main() {
  const notion = new Client({ auth: process.env.NOTION_API_KEY });
  const dbId = process.env.NOTION_PROJECTS_DB_ID || "b1eb06a469ac4a9eb3f01851611fb80b";

  // Query for PRD-9
  const response = await notion.databases.query({
    database_id: dbId,
    filter: {
      property: "ID",
      rich_text: { equals: "PRD-9" },
    },
  });

  console.log("Query result page count:", response.results.length);

  if (response.results.length === 0) {
    console.error("PRD-9 not found. Check filter property name.");
    // Try listing a few projects to see available properties
    const sample = await notion.databases.query({ database_id: dbId, page_size: 3 });
    console.log("Sample project properties:", JSON.stringify(
      sample.results[0] && "properties" in sample.results[0]
        ? Object.keys(sample.results[0].properties)
        : "no results",
      null,
      2
    ));
    return;
  }

  const project = response.results[0];
  if (!("properties" in project)) return;

  console.log("PRD-9 properties:", JSON.stringify(project.properties, null, 2));
  console.log("PRD-9 page ID:", project.id);

  // Find the plan page (look for a "Plan" relation or child page)
  const blocks = await notion.blocks.children.list({ block_id: project.id });
  console.log("Top-level block count:", blocks.results.length);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  console.log("Block types:", blocks.results.map((b: any) => b.type));
  console.log("Full blocks:", JSON.stringify(blocks.results, null, 2));
}

main().catch(console.error);
