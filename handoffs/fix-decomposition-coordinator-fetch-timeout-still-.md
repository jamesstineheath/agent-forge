<!-- source: direct -->
<!-- triggeredBy: unknown -->
<!-- budget: 1 -->

# Agent Forge -- Fix Decomposition Coordinator Fetch Timeout

## Metadata
- **Branch:** `fix/decomposition-coordinator-timeout`
- **Priority:** high
- **Model:** sonnet
- **Type:** fix
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files (modify):** `app/api/agents/supervisor/cron/route.ts`, `lib/atc/supervisor.ts`, `app/api/agents/project-manager/cron/route.ts`, `lib/pm-agent.ts`
- **Read-only investigation:** `lib/orchestrator.ts`, `lib/decomposer.ts`, `lib/atc/utils.ts`, `vercel.json`, `next.config.ts`

## Context

The Supervisor decomposition phase consistently fails at exactly 340,002ms with "fetch failed". Two prior PRs (#402 and #404) attempted fixes:
- PR #402: bumped undici headersTimeout
- PR #404: set coordinator fetch timeout to 800s

Neither fix changed behavior. The 340s ceiling (~300s + 40s overhead) strongly suggests the **Supervisor cron route's own `maxDuration`** is capping the total cycle time, starving decomposition before its 800s timeout can fire. Additionally, `pm-sweep` times out at 120,002ms every cycle, suggesting a similar pattern.

This is the critical path blocker for all pipeline automation since Session 62.

**⚠️ High-churn warning:** `lib/atc/supervisor.ts` has been modified in 7+ PRs recently. Keep changes to this file absolutely minimal — only timeout/duration values. Do not refactor, reorganize, or touch unrelated logic.

## Requirements

1. Read all relevant source files before making any changes to understand the actual code structure
2. Identify the Supervisor cron route's `maxDuration` config and raise it to accommodate 800s decomposition + overhead (target: 800s or Vercel Pro Fluid max)
3. Confirm PR #404's coordinator fetch timeout change applies to the correct call site — if there are multiple fetch call sites in the coordinator, fix all of them
4. Fix pm-sweep timeout: identify the constraint enforcing 120s and raise it appropriately
5. Do not introduce any TypeScript errors
6. The fix must be minimal and surgical — change only timeout/maxDuration values and ensure they are consistently applied
7. Do NOT modify `lib/atc/dispatcher.ts` or `lib/atc/health-monitor.ts` (active work items touching those files)

## Execution Steps

### Step 0: Pre-flight checks
