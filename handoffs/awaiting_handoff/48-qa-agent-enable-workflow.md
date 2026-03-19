# Handoff 48: qa-agent-enable-workflow

## Metadata
- Branch: `feat/qa-agent-enable-workflow`
- Priority: high
- Model: opus
- Type: feature
- Max Budget: $2
- Risk Level: low
- Complexity: simple
- Depends On: None
- Date: 2026-03-19
- Executor: Claude Code (GitHub Actions)

## Context

Handoff A (PR #298) merged — the QA Agent orchestrator, Playwright baseline tests, and API health tests are on main. This handoff re-enables the workflow so the QA Agent fires on every Vercel preview deployment.

The workflow file at .github/workflows/tlm-qa-agent.yml has `if: false` on the qa-agent job that needs to be removed. The warmup logic needs longer timeouts (Vercel previews can take 60-90s). The action.yml needs a default for the repo input.

IMPORTANT: This is a simple wiring change. Do NOT modify any test files, orchestrator code, or action logic. Only touch the workflow YAML and action.yml.

## Pre-flight Self-Check

- [ ] Verify `if: false` is removed from qa-agent job
- [ ] Verify warmup has 6 retries and 15s interval
- [ ] Verify timeout-minutes: 5 is set on the job
- [ ] Verify repo input is passed to Run QA Agent step
- [ ] Verify NO changes to test files, run-qa.ts, or any src/ files

## Step 0: Branch, commit handoff, push

Create branch `feat/qa-agent-enable-workflow` from `main`. Commit this handoff file. Push.

## Step 1: In `.github/workflows/tlm-qa-agent.yml`: (1) Remove the `if: false` condition from the qa-agent job. (2) Add `repo: ${{ github.repository }}` to the 'Run QA Agent' step inputs. (3) Change warmup retry count from 3 to 6 and interval from 10 to 15 (total 90s warmup instead of 30s). (4) Add `timeout-minutes: 5` to the qa-agent job.

## Step 2: In `.github/actions/tlm-qa-agent/action.yml`: Make the `repo` input optional by adding `default: ''` and `required: false`. The orchestrator should handle empty repo by defaulting to GITHUB_REPOSITORY env var.

## Session Abort Protocol

If you cannot complete execution:
1. Commit current work as WIP
2. Push the branch and open a draft PR
3. Output structured abort JSON