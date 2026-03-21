# Agent Memory: TLM Code Reviewer

*Maintained by the TLM Outcome Tracker. Read by the Code Reviewer and Spec Reviewer.*

## Hot Patterns (max 10)
<!-- Maintained by Outcome Tracker. Items here should influence every review. -->
<!-- Format: - [YYYY-MM-DD] Pattern description. -->

- [2026-03-21] **Schema Changes Require Migration** (critical): Any PR that modifies `lib/db/schema.ts` (adding/removing/renaming columns) requires a corresponding database migration against the live Neon database. Drizzle ORM generates SQL referencing ALL columns in the schema definition. If the schema defines columns that don't exist in the database, every query fails at runtime. PRD-54 PRs #422-#426 all merged with new columns in the schema but no migration, breaking `/api/work-items` for hours. Action: FLAG_FOR_HUMAN any PR touching schema.ts unless it also includes a migration file or migration API route.


- [2026-03-21] Rapid merge cadence is a proven failure multiplier. March 15: 6 PRs merged in ~2.5 hours → 100% caused_issues rate (PRs #21-#27). March 21: ~40 PRs merged in one day with extensive file overlap (lib/types.ts touched 14 times, lib/db/schema.ts touched 4 times). (high): When more than 10 PRs have merged in the last 6 hours, or when the same file appears in 3+ unassessed PRs, flag this as elevated integration risk. For PRs touching high-churn files during high-velocity periods, recommend rebasing against latest main before merge to catch type conflicts and schema drift.
- [2026-03-14] PR #1 shipped API route handlers without proper error logging, requiring a follow-up fix commit. This is a basic quality issue that automated review should catch. (medium): TLM should check that API route handlers include try/catch blocks with error logging as a standard pattern. Consider adding this to the review checklist for any route.ts file.
- [2026-03-20] lib/atc/*.ts modules (dispatcher.ts, supervisor.ts, health-monitor.ts) and lib/decomposer.ts are all high-churn files. supervisor.ts was modified in 7+ PRs March 19-20 (#361, #381, #385, #386, #387, #389, #390) including a major phase decomposition refactor followed by two timeout fix PRs. health-monitor.ts was modified in 7 PRs March 18-20 (#281, #308, #311, #370, #377, #380, #385), many being bugfixes for status transition and escalation logic. lib/decomposer.ts modified in 6 PRs March 17-20 (#215, #227, #301, #385, #387, #389). lib/types.ts also remains high-churn. (high): Flag modifications to lib/atc/supervisor.ts, lib/atc/health-monitor.ts, lib/atc/dispatcher.ts, lib/decomposer.ts, and lib/types.ts for extra scrutiny. For supervisor.ts: check timeout/budget settings, phase orchestration correctness, and manifest consistency. For health-monitor.ts: check status transition correctness, work item state machine consistency, and escalation interaction. For decomposer.ts: check timeout handling, AI model call budgets, and error recovery. For all: check interface stability, backward compatibility, and concurrent modification conflicts.

- [2026-03-15] Environment variable rename (PR #23) caused CI failures, likely due to deployment configuration not being updated in sync with the code change. (medium): TLM should flag environment variable renames and require evidence that deployment environments will be updated simultaneously. Consider requiring a deployment checklist for env var changes.
- [2026-03-15] Multiple PRs merged within minutes of each other on March 15 (PRs #22-#30 all within ~2.5 hours), making it difficult to attribute CI failures to specific PRs. The rapid merge cadence creates signal noise. (medium): Consider recommending a minimum soak time between merges to main, especially for infrastructure changes, to get cleaner CI signal attribution.
- [2026-03-15] PR #25 (ATC dedup guard) appears to be a pattern fix addressing issues that emerged from the cumulative effect of PRs #7, #11, #12, #13 building up the ATC module without concurrent-dispatch safeguards. (medium): When reviewing additions to stateful dispatch systems, TLM should proactively check for deduplication and idempotency guarantees, not just functional correctness.
- [2026-03-19] lib/model-router.ts is a new shared module handling AI model selection and Sonnet→Opus escalation. Modified in 4+ PRs on March 19 (PRs #326, #327, #341, #357). Changes to this file affect cost (model pricing) and reliability (fallback/escalation behavior). (medium): Flag lib/model-router.ts modifications for cost-impact review. Verify escalation logic has proper fallbacks and that telemetry/analytics changes don't break the routing decision path.
- [2026-03-20] .github/ workflow and action files (tlm-review.yml, action dist bundles) are modified frequently. While the March 15 batch had CI failures, subsequent .github/ changes (PRs #304, #310, #314, #319, #330, #344, #388) have been stable. (medium): .github/ file modifications should be reviewed for: recursion guards, self-filter logic, cascade prevention, branch-ignore filters, and null checks on trigger fields. Extra caution for new workflows or orchestrator configuration changes.

## Recent Outcomes (last 20)
<!-- Each entry: Date | Action | Entity | Outcome (Correct/Reversed/Caused Issues/Missed) | Notes -->
| Date | Action | Entity | Outcome | Notes |
|---|---|---|---|---|
| 2026-03-15 | premature | PR #28 PR #28 feat: add fast-path skip for low-risk spec reviews | premature |  |
| 2026-03-15 | caused_issues | PR #24 PR #24 fix: env var cleanup verification — zero ESCALATION_SECRET references confirmed | caused_issues |  |
| 2026-03-15 | caused_issues | PR #27 PR #27 feat: workflow template storage and template reader | caused_issues |  |
| 2026-03-15 | premature | PR #26 PR #26 feat: add bootstrap types to lib/types.ts | premature |  |
| 2026-03-15 | caused_issues | PR #25 PR #25 fix: ATC dedup guard, orphan cleanup, debug endpoint removal | caused_issues |  |
| 2026-03-15 | caused_issues | PR #23 PR #23 refactor: rename ESCALATION_SECRET to AGENT_FORGE_API_SECRET | caused_issues |  |
| 2026-03-15 | caused_issues | PR #22 PR #22 feat: Handoff Lifecycle Orchestrator | caused_issues |  |
| 2026-03-15 | caused_issues | PR #21 PR #21 feat: CI feedback loop (CI wait + Code Review gate + stuck-PR monitor) | caused_issues |  |
| 2026-03-14 | correct | PR #20 PR #20 feat: add Bearer token auth to work items API | correct |  |
| 2026-03-14 | correct | PR #19 PR #19 feat: ATC decomposer wiring + Gmail summary + E2E test (H16) | correct |  |
| 2026-03-14 | correct | PR #18 PR #18 feat: dependency-aware dispatch + project lifecycle (Phase 2e-3, H15) | correct |  |
| 2026-03-14 | correct | PR #17 PR #17 feat: Plan Decomposer core (Phase 2e-3, H14) | correct |  |
| 2026-03-14 | correct | PR #15 PR #15 feat: wire escalation API auth + pipeline agent integration | correct |  |
| 2026-03-14 | correct | PR #14 PR #14 feat: Gmail integration for escalation emails | correct |  |
| 2026-03-14 | correct | PR #13 PR #13 feat: Escalation state machine (Phase 2f) | correct |  |
| 2026-03-14 | correct | PR #12 PR #12 feat: add Notion projects integration | correct |  |
| 2026-03-14 | correct | PR #11 PR #11 feat: add periodic stale branch cleanup to ATC | correct |  |
| 2026-03-14 | correct | PR #7 PR #7 feat: queue management + auto-dispatch | correct |  |
| 2026-03-14 | correct | PR #10 PR #10 feat: Phase 2c multi-repo support | correct |  |
| 2026-03-13 | correct | PR #4 PR #4 feat: orchestrator dispatch engine | correct |  |

## Lessons Learned (last 15)

- PR #13: Shared files like lib/atc.ts and lib/escalation.ts are being modified across many PRs in rapid succession. Worth monitoring for integration issues.
- PR #1: Route handlers should include proper error logging from the start. TLM should flag API route files that lack try/catch or error logging patterns.
- PR #5: Core infrastructure PRs like the air traffic controller should be reviewed for completeness of the dispatch/scheduling interface before merge, anticipating near-term feature needs.
- PR #2: CI workflow changes should be scrutinized for shell script robustness (pipefail, set -e) and correct model/version references. The TLM's flag_for_human decision was directionally correct — this PR did have issues — but the human review apparently didn't catch them.
- PR #24: A PR that only modifies a handoff markdown doc causing orchestrate CI failures suggests the orchestrate job may have pre-existing instability, or the failures are unrelated to this PR's changes.
- PR #27: Workflow template additions should be validated against the orchestrator's expectations before merge.
- PR #25: PRs that combine fixes (dedup guard), cleanup (orphan removal), and deletions (debug endpoints) in one bundle increase risk. Consider splitting.
- PR #23: Environment variable renames should be coordinated with deployment config updates. TLM should flag env var renames as high-risk and verify deployment coordination.
- PR #22: New GitHub Actions workflows should be tested for cascade/recursion behavior before merge. The orchestrator triggering itself is a classic workflow anti-pattern that review should catch.
- PR #21: CI/workflow infrastructure changes should have their own validation step before merge.
- PR #18: lib/atc.ts is a high-churn file that accumulates changes from many PRs. Consider whether it needs modularization.
- PR #13: State machine implementations often need follow-up dedup guards when deployed in concurrent environments.
- PR #7: Queue management and auto-dispatch systems commonly need dedup guards added after initial deployment when real-world concurrency patterns emerge.

## Stats

- Total Assessed: 24
- Correct: 15
- Reversed: 0
- Caused Issues: 9
- Missed: 0
- Last Assessment: 2026-03-18
- Assessment Frequency: daily (9am UTC)
