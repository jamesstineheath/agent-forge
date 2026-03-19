# Agent Forge -- Vercel Spend Validation Checklist and ADR Finalization

## Metadata
- **Branch:** `feat/vercel-spend-validation-checklist`
- **Priority:** low
- **Model:** sonnet
- **Type:** docs
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** docs/vercel-spend-validation-checklist.md, docs/adr/ADR-011-vercel-build-machine-optimization.md

## Context

ADR-011 documented the switch from Turbo to Standard build machines and related Vercel spend optimizations across Agent Forge's Vercel projects. Those changes are now live, but the ADR lacks a formal validation section and there is no structured checklist for confirming the spend reduction is working as intended after one billing cycle.

This task creates:
1. `docs/vercel-spend-validation-checklist.md` — a practical, itemized checklist covering all the key signals that the optimization is working (billing numbers, build triggers, skip logic, cron schedules, spend alerts, and absence of status-tracking commits).
2. An update to `docs/adr/ADR-011-vercel-build-machine-optimization.md` — a `## Validation` section referencing the checklist and noting that final results will be filled in after one billing cycle.

No code changes are required. This is a pure documentation task.

## Requirements

1. Create `docs/vercel-spend-validation-checklist.md` with at least 7 specific, actionable validation items.
2. Checklist item 1: Vercel billing dashboard shows monthly on-demand charges under $50.
3. Checklist item 2: Push a test code change to each repo and confirm builds trigger and deploy successfully.
4. Checklist item 3: Push a docs-only change and confirm builds are skipped by the build-skip script.
5. Checklist item 4: Confirm the AF dashboard at the root page loads and shows current work item data.
6. Checklist item 5: Confirm each cron fires on its adjusted schedule via Vercel function logs.
7. Checklist item 6: Confirm spend alert emails are received when billing thresholds are crossed.
8. Checklist item 7: Confirm no status-tracking commits appear on `main` branches of any target repo.
9. Checklist should include a header, brief context paragraph, and use GitHub-flavoured markdown checkboxes (`- [ ]`).
10. Checklist should include a "Results" section at the bottom with placeholder fields for recording outcomes after one billing cycle.
11. `docs/adr/ADR-011-vercel-build-machine-optimization.md` must receive a `## Validation` section (appended or inserted before any existing closing section) that references `docs/vercel-spend-validation-checklist.md` and states that final results will be recorded after one billing cycle.
12. `npm run build` must pass with no new errors.

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/vercel-spend-validation-checklist
```

### Step 1: Create the validation checklist

Create the file `docs/vercel-spend-validation-checklist.md` with the following content (adjust wording as needed for clarity, but preserve all 7+ items and the Results section):

```markdown
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
```

### Step 2: Update ADR-011 with a Validation section

Read the current contents of `docs/adr/ADR-011-vercel-build-machine-optimization.md`. Append (or insert before a closing `---` line if one exists) the following section. Do not modify any existing content.

```markdown

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
```

### Step 3: Verify build

```bash
npm run build
```

Confirm the build exits with code 0. These are documentation-only changes so no TypeScript errors are expected, but run the check to be safe.

### Step 4: Commit, push, open PR

```bash
git add docs/vercel-spend-validation-checklist.md docs/adr/ADR-011-vercel-build-machine-optimization.md
git commit -m "docs: add Vercel spend validation checklist and update ADR-011 with Validation section"
git push origin feat/vercel-spend-validation-checklist
gh pr create \
  --title "docs: Vercel spend validation checklist and ADR-011 finalization" \
  --body "## Summary

Creates \`docs/vercel-spend-validation-checklist.md\` with 7+ structured validation items covering all key signals that the ADR-011 Vercel spend optimizations are working correctly.

Also updates \`docs/adr/ADR-011-vercel-build-machine-optimization.md\` with a \`## Validation\` section referencing the checklist and noting that final results will be recorded after one billing cycle.

## Changes
- \`docs/vercel-spend-validation-checklist.md\` — new file, 7 checklist items + Results table
- \`docs/adr/ADR-011-vercel-build-machine-optimization.md\` — appended Validation section

## Acceptance Criteria
- [x] Checklist file exists with at least 7 specific validation items
- [x] Includes build-trigger and build-skip verification items
- [x] Includes cron schedule verification item
- [x] ADR-011 updated with Validation section referencing checklist
- [x] \`npm run build\` passes"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/vercel-spend-validation-checklist
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```