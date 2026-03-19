# ADR-011: Vercel Build Machine & Concurrency Optimization

- **Status:** Accepted
- **Date:** 2025-01-27
- **Scope:** Steps 1 and 2 of Vercel infrastructure cost optimization plan

## Context

Agent Forge runs on four Vercel projects. Until this change, all projects were configured to use **Turbo** build machines — the highest-performance (and highest-cost) option Vercel offers. Turbo machines are provisioned for maximum parallelism and raw speed, but for a Next.js control-plane application with modest build complexity, this level of compute is unnecessary and incurs significant cost.

Vercel offers three build machine tiers:

| Tier | Cost | Use Case |
|------|------|----------|
| Standard | $0.014/min | Default; suitable for most Next.js apps |
| Enhanced | $0.03/min | Faster for projects with complex builds or large dependency trees |
| Turbo | $0.126/min | Maximum performance; reserved for very large monorepos or build-time-sensitive workloads |

At the Turbo rate, a 4-minute build costs ~$0.50. At Standard, the same build costs ~$0.06 — a **9× cost reduction** for equivalent output.

Additionally, the Vercel projects were configured to allow concurrent builds across all pushes to a branch. Because the Agent Forge dispatcher, health monitor, and other agents can trigger rapid sequential pushes (e.g., handoff file commits, index reconciliation commits), Vercel was canceling in-progress builds when new commits arrived, then immediately starting new ones. This produced a cascade of short-lived, canceled builds that wasted compute and obscured which build actually produced the deployed artifact.

## Decision

### Step 1: Switch all four Vercel projects to Standard build machines

All four Agent Forge Vercel projects are switched from **Turbo** to **Standard** build machines effective immediately. This is a Vercel dashboard configuration change under **Project Settings → General → Build Machine**.

If any project's P95 build time exceeds **3 minutes** after one week of monitoring, that project is selectively upgraded to **Enhanced** (not Turbo). The threshold of 3 minutes is chosen because:
- Standard builds completing in under 3 minutes indicate the project is not CPU-bound
- Enhanced provides a 2× cost increase but ~30–40% build time reduction — worthwhile only when builds are a meaningful bottleneck
- Turbo is not considered for re-adoption unless Enhanced proves insufficient after measurement

### Step 2: Set build concurrency to "one build per branch"

All four Vercel projects are configured to limit concurrent builds to **one build per branch**. This is a Vercel dashboard configuration change under **Project Settings → General → Concurrent Builds**.

With this setting:
- When a new commit is pushed to a branch while a build is in progress for that branch, the new build is **queued** rather than immediately preempting the in-progress build
- The prior behavior (cancel-on-push) caused cascading cancellations when agents committed multiple times in rapid succession (e.g., dispatcher reconciliation → handoff push → status update = 3 commits in ~60 seconds)
- Queued builds preserve the full build artifact history and make deployment logs auditable

## Consequences

### Positive

- **Cost reduction**: Estimated 85–90% reduction in Vercel compute spend for equivalent build output, based on the $0.014 vs $0.126 per-minute rate difference
- **Build auditability**: "One build per branch" prevents cascading cancellations; every commit that should produce a deployment does produce one
- **No behavior change for users**: Standard machines run the same build commands; output is identical
- **Upgrade path defined**: The 3-minute threshold and Enhanced tier provide a clear escalation path without reverting to Turbo

### Negative / Trade-offs

- **Potentially slower builds**: Standard machines have less CPU/memory than Turbo. If the Next.js build becomes CPU-bound (e.g., after adding many new routes or heavy `generateStaticParams` pages), build times may increase
- **Queued builds add latency**: With one-build-per-branch concurrency, a rapid succession of pushes will queue behind each other rather than deploying the latest commit immediately. For the Agent Forge control plane (internal tooling, not latency-critical), this trade-off is acceptable

### Neutral

- This ADR covers only Vercel dashboard configuration. No application code, environment variables, or CI/CD workflow files are changed
- The four Vercel projects are all under the same Vercel team account; changes apply independently per project

## Monitoring Plan

During the **first week** after applying these changes, validate the following:

### Build Time Checks (Vercel Dashboard → Deployments)

- [ ] **Day 1**: Confirm at least one successful build per project after the machine type change. Record build duration for each project.
- [ ] **Day 3**: Review P50 and P95 build times across all four projects. Flag any project where P95 exceeds 3 minutes.
- [ ] **Day 7**: Final weekly review. For any project exceeding the 3-minute P95 threshold, open a follow-up work item to upgrade that project to Enhanced.

### Concurrency Behavior Checks

- [ ] **Day 1–2**: Trigger a scenario where the dispatcher or health monitor commits multiple times within 60 seconds (this occurs naturally during normal operation). Confirm in Vercel dashboard that builds queue rather than cascade-cancel.
- [ ] **Day 3–7**: Monitor the Vercel deployment log for any "build canceled" events. Occurrences should drop to near zero for branch builds; `main` branch deployments may still cancel if a hotfix is pushed immediately after a merge.

### Cost Checks (Vercel Billing)

- [ ] **Day 7**: Compare Vercel compute usage (minutes) this week vs the prior week. Expect a significant reduction even accounting for any queued build latency.

### Rollback Criteria

If **any** of the following occur within the first week, revert the affected project to Enhanced (not Turbo) and reassess:

- P95 build time exceeds 5 minutes on Standard
- A build failure is attributable to OOM (out-of-memory) on the Standard machine
- Queued builds cause a deployment delay exceeding 10 minutes for a production push to `main`

## Validation

A structured validation checklist for confirming these optimizations are
working as intended has been created at
[`docs/vercel-spend-validation-checklist.md`](../vercel-spend-validation-checklist.md).

The checklist covers:
1. Vercel billing dashboard shows monthly on-demand charges under $50.
2. Code changes trigger builds and deployments across all registered repos.
3. Docs-only changes are skipped by the build-skip script.
4. The AF dashboard loads and displays current work item data.
5. Each cron job fires on its adjusted schedule (confirmed via Vercel function logs).
6. Spend alert emails are received when billing thresholds are crossed.
7. No automated status-tracking commits appear on `main` branches.

**Final validation results will be recorded in the checklist after one complete
billing cycle.** The ADR status will be updated to `accepted-validated` once
all items pass.

## References

- [Vercel Build Machine Documentation](https://vercel.com/docs/deployments/build-machine)
- ADR-010: ATC Monolith → Autonomous Agent Architecture (context for agent commit patterns)
- Agent Forge Cost Optimization Plan (Steps 1 & 2 of N)
