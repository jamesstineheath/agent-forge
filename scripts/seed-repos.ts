// scripts/seed-repos.ts
// Registers target repos in Agent Forge. Idempotent.
// Usage: AGENT_FORGE_URL=http://localhost:3002 npx tsx scripts/seed-repos.ts

const AGENT_FORGE_URL = process.env.AGENT_FORGE_URL || "https://agent-forge-phi.vercel.app";

interface RepoSeed {
  fullName: string;
  shortName: string;
  claudeMdPath: string;
  systemMapPath?: string;
  adrPath?: string;
  handoffDir: string;
  executeWorkflow: string;
  concurrencyLimit: number;
  defaultBudget: number;
}

const REPOS: RepoSeed[] = [
  {
    fullName: "jamesstineheath/personal-assistant",
    shortName: "pa",
    claudeMdPath: "CLAUDE.md",
    systemMapPath: "docs/SYSTEM_MAP.md",
    adrPath: "docs/adr",
    handoffDir: "handoffs/",
    executeWorkflow: "execute-handoff.yml",
    concurrencyLimit: 2,
    defaultBudget: 8,
  },
  {
    fullName: "jamesstineheath/rez-sniper",
    shortName: "rez-sniper",
    claudeMdPath: "CLAUDE.md",
    handoffDir: "handoffs/",
    executeWorkflow: "execute-handoff.yml",
    concurrencyLimit: 1,
    defaultBudget: 5,
  },
];

async function main() {
  // Fetch existing repos
  const listRes = await fetch(`${AGENT_FORGE_URL}/api/repos`);
  if (!listRes.ok) {
    console.error("Failed to list repos:", listRes.status, await listRes.text());
    process.exit(1);
  }
  const existing = (await listRes.json()) as Array<{ fullName: string }>;
  const existingNames = new Set(existing.map((r) => r.fullName));

  for (const repo of REPOS) {
    if (existingNames.has(repo.fullName)) {
      console.log(`[skip] ${repo.fullName} already registered`);
      continue;
    }

    const createRes = await fetch(`${AGENT_FORGE_URL}/api/repos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(repo),
    });

    if (createRes.ok) {
      const created = await createRes.json();
      console.log(`[created] ${repo.fullName} (id: ${created.id})`);
    } else {
      console.error(`[error] ${repo.fullName}:`, createRes.status, await createRes.text());
    }
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
