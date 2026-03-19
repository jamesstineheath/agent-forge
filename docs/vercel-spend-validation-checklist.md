# Vercel Spend Validation Checklist

## Context

This checklist validates that the Vercel spend optimizations described in
[ADR-011](adr/ADR-011-vercel-build-machine-optimization.md) are working as
intended. It should be completed after all changes have been live for one full
billing cycle. Record outcomes in the **Results** section at the bottom.

**Target threshold:** Monthly on-demand Vercel charges under **$50**.

---

## Validation Items

### 1. Billing dashboard charge under $50
- [ ] Log in to the Vercel dashboard for the Agent Forge organization.
- [ ] Navigate to **Settings → Billing → Usage**.
- [ ] Confirm that total monthly on-demand charges for the current (or most recently completed) billing cycle are **below $50**.
- [ ] Screenshot or note the exact figure in the Results section.

### 2. Code changes trigger builds and deployments
- [ ] Push a trivial code change (e.g., add a comment to a `.ts` file) to each of the monitored repos:
  - [ ] `jamesstineheath/agent-forge`
  - [ ] Any additional registered target repos
- [ ] Confirm that a Vercel build is triggered for each push (visible in the Vercel dashboard under **Deployments**).
- [ ] Confirm each build completes successfully and a deployment is created.

### 3. Docs-only changes skip builds
- [ ] Push a change that touches only documentation files (e.g., edit a `.md` file in `docs/`) to a monitored repo.
- [ ] Confirm that the build-skip script suppresses the Vercel build (the deployment should either not appear or show as "Skipped").
- [ ] Verify this behaviour for at least one target repo.

### 4. AF dashboard loads with current work item data
- [ ] Open the Agent Forge dashboard at its root URL (production Vercel deployment).
- [ ] Confirm the page loads without errors.
- [ ] Confirm that the pipeline overview / work item list reflects current (non-stale) data.
- [ ] Note any errors or stale data indicators in the Results section.

### 5. Cron jobs fire on adjusted schedules
- [ ] Open Vercel **Functions → Logs** for the Agent Forge deployment.
- [ ] Confirm that each cron route has fired at least once within the expected window since the schedule change:
  - [ ] Dispatcher (`/api/agents/dispatcher/cron`) — every 5 minutes
  - [ ] Health Monitor (`/api/agents/health-monitor/cron`) — every 5 minutes
  - [ ] Supervisor (`/api/agents/supervisor/cron`) — every 10 minutes
  - [ ] PM Agent (`/api/pm-agent`) — every 15 minutes
- [ ] Note last-seen timestamps in the Results section.

### 6. Spend alert emails are received at billing thresholds
- [ ] Confirm that Vercel spend alerts are configured in **Settings → Billing → Spend Alerts** for the organization.
- [ ] If a threshold was crossed during the billing cycle, confirm that an alert email was received at `james.stine.heath@gmail.com`.
- [ ] If no threshold was crossed (spend under limit), mark this item as N/A and note it in Results.

### 7. No status-tracking commits on main branches
- [ ] For each registered target repo, inspect the `main` branch commit history for the past billing cycle.
- [ ] Confirm that no automated status-tracking commits (e.g., commits from a bot updating a state file) appear on `main`.
- [ ] If any such commits are found, log them in the Results section and open a follow-up work item.

---

## Additional Checks (Optional)

- [ ] Confirm build minutes consumed are within the expected Standard machine range (lower than Turbo baseline from ADR-011).
- [ ] Confirm no unexpected Serverless Function invocation spikes in Vercel analytics.
- [ ] Review Vercel function error rate — confirm no regressions introduced by the machine-type switch.

---

## Results

> **Complete this section after one full billing cycle.**

| Item | Status | Notes |
|------|--------|-------|
| 1. Billing under $50 | ⬜ Pending | |
| 2. Code changes trigger builds | ⬜ Pending | |
| 3. Docs-only changes skip builds | ⬜ Pending | |
| 4. AF dashboard loads with current data | ⬜ Pending | |
| 5. Cron jobs fire on schedule | ⬜ Pending | |
| 6. Spend alert emails received | ⬜ Pending | |
| 7. No status-tracking commits on main | ⬜ Pending | |

**Billing cycle covered:** <!-- e.g., 2026-04-01 → 2026-04-30 -->

**Actual monthly on-demand charge:** <!-- e.g., $34.20 -->

**Validated by:** <!-- GitHub handle -->

**Date validated:** <!-- YYYY-MM-DD -->

**Overall result:** <!-- PASS / FAIL / PARTIAL -->

**Follow-up work items opened (if any):**
<!-- List any work items created as a result of failures found during validation -->
