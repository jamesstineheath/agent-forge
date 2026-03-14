# Agent Memory: TLM Code Reviewer

*Maintained by the TLM Outcome Tracker. Read by the Code Reviewer and Spec Reviewer.*

## Hot Patterns (max 10)
<!-- Maintained by Outcome Tracker. Items here should influence every review. -->
<!-- Format: - [YYYY-MM-DD] Pattern description. -->

- [2026-03-14] lib/atc.ts is modified in nearly every PR (PRs #5, #7, #8, #11, #12, #13, #14, #15) making it a high-churn file and potential fragility hotspot. (high): TLM should apply extra scrutiny to any PR modifying lib/atc.ts, particularly checking for interface stability, backward compatibility, and whether the change is additive vs. restructuring. Consider recommending the team decompose this module.
- [2026-03-14] The execute-handoff workflow (.github/workflows/execute-handoff.yml) required two follow-up fixes after PR #2 merged. CI/workflow files are a recurring source of subtle bugs. (medium): TLM should enforce a checklist for CI workflow changes: shell scripts should use 'set -euo pipefail', model/version references should be validated, and failure modes should be explicitly tested.
- [2026-03-14] All 14 PRs were merged within approximately 10 hours, representing an extremely rapid development pace. This cadence increases the risk of integration issues and makes it hard to distinguish fix commits from normal feature iteration. (medium): TLM should account for development velocity when assessing risk. When many PRs touch overlapping files in rapid succession, integration review becomes more critical. Consider recommending staging/batching for related changes.
- [2026-03-14] PR #1 shipped API route handlers without proper error logging, requiring a follow-up fix commit. This is a basic quality issue that automated review should catch. (medium): TLM should check that API route handlers include try/catch blocks with error logging as a standard pattern. Consider adding this to the review checklist for any route.ts file.

## Recent Outcomes (last 20)
<!-- Each entry: Date | Action | Entity | Outcome (Correct/Reversed/Caused Issues/Missed) | Notes -->
| Date | Action | Entity | Outcome | Notes |
|---|---|---|---|---|
| 2026-03-14 | premature | PR #15 feat: wire escalation API auth + pipeline agent integration | premature |  |
| 2026-03-14 | premature | PR #14 feat: Gmail integration for escalation emails | premature |  |
| 2026-03-14 | premature | PR #13 feat: Escalation state machine (Phase 2f) | premature |  |
| 2026-03-14 | premature | PR #12 feat: add Notion projects integration | premature |  |
| 2026-03-14 | premature | PR #11 feat: add periodic stale branch cleanup to ATC | premature |  |
| 2026-03-13 | caused_issues | PR #1 feat: work item store + repo registry | caused_issues | Assessed 2026-03-14 |
| 2026-03-14 | premature | PR #7 feat: queue management + auto-dispatch | premature |  |
| 2026-03-14 | premature | PR #10 feat: Phase 2c multi-repo support | premature |  |
| 2026-03-14 | correct | PR #6 feat: dashboard UI | correct |  |
| 2026-03-14 | correct | PR #8 feat: conflict detection + failure handling | correct |  |
| 2026-03-14 | correct | PR #9 feat: ATC dashboard enhancement | correct |  |
| 2026-03-14 | caused_issues | PR #5 feat: air traffic controller | caused_issues |  |
| 2026-03-13 | caused_issues | PR #2 fix: handoff auto-detect uses git diff instead of filesystem mtime | caused_issues | Assessed 2026-03-14 |
| 2026-03-13 | premature | PR #4 feat: orchestrator dispatch engine | premature | Assessed 2026-03-14 |

## Lessons Learned (last 15)

- PR #13: Shared files like lib/atc.ts and lib/escalation.ts are being modified across many PRs in rapid succession. Worth monitoring for integration issues.
- PR #1: Route handlers should include proper error logging from the start. TLM should flag API route files that lack try/catch or error logging patterns.
- PR #5: Core infrastructure PRs like the air traffic controller should be reviewed for completeness of the dispatch/scheduling interface before merge, anticipating near-term feature needs.
- PR #2: CI workflow changes should be scrutinized for shell script robustness (pipefail, set -e) and correct model/version references. The TLM's flag_for_human decision was directionally correct — this PR did have issues — but the human review apparently didn't catch them.

## Stats

- Total Assessed: 6
- Correct: 3
- Reversed: 0
- Caused Issues: 3
- Missed: 0
- Last Assessment: 2026-03-14
- Assessment Frequency: daily (9am UTC)
