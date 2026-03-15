// scripts/sync-escalation-secrets.ts
// Adds AGENT_FORGE_API_SECRET and AGENT_FORGE_URL as repository secrets to target repos
// so their execute-handoff workflows can call back to the Agent Forge escalation API.
//
// Prerequisites:
//   - GH_PAT env var with admin:org or repo scope for target repos
//   - AGENT_FORGE_API_SECRET env var (the shared secret to set)
//   - AGENT_FORGE_URL env var (the Agent Forge base URL)
//
// Usage: GH_PAT=... AGENT_FORGE_API_SECRET=... AGENT_FORGE_URL=... npx tsx scripts/sync-escalation-secrets.ts
//
// This script uses the GitHub CLI (gh) to set secrets, which handles the
// libsodium encryption required by the GitHub Secrets API.

import { execSync } from "child_process";

const TARGET_REPOS = [
  "jamesstineheath/personal-assistant",
  "jamesstineheath/rez-sniper",
];

const SECRETS_TO_SYNC: Record<string, string | undefined> = {
  AGENT_FORGE_API_SECRET: process.env.AGENT_FORGE_API_SECRET,
  AGENT_FORGE_URL: process.env.AGENT_FORGE_URL,
};

function main() {
  const ghPat = process.env.GH_PAT;
  if (!ghPat) {
    console.error("GH_PAT environment variable is required");
    process.exit(1);
  }

  // Validate all secrets have values
  const missing = Object.entries(SECRETS_TO_SYNC)
    .filter(([, value]) => !value)
    .map(([key]) => key);

  if (missing.length > 0) {
    console.error(`Missing environment variables: ${missing.join(", ")}`);
    process.exit(1);
  }

  for (const repo of TARGET_REPOS) {
    console.log(`\n--- ${repo} ---`);

    for (const [name, value] of Object.entries(SECRETS_TO_SYNC)) {
      try {
        // gh secret set reads the value from stdin to avoid shell escaping issues
        execSync(`gh secret set ${name} --repo ${repo}`, {
          input: value,
          env: { ...process.env, GH_TOKEN: ghPat },
          stdio: ["pipe", "pipe", "pipe"],
        });
        console.log(`  [set] ${name}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`  [error] ${name}: ${message}`);
      }
    }
  }

  console.log("\nDone. Verify with: gh secret list --repo <repo>");
}

main();
