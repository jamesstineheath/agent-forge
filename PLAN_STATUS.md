# Plan Status: PR Check Deduplication

## AC-1: Orchestrator skips main-branch triggers — DONE
- Added job-level `if` to skip when workflow_run.head_branch is main/master

## AC-2: TLM Code Review triggers only after CI passes — DONE
- Removed `pull_request` trigger, kept `check_suite` + `workflow_dispatch`
- Added `conclusion == 'success'` check so reviews only run after CI passes
- Changed `cancel-in-progress` to true (no more dual-trigger conflict)

## AC-3: QA Agent skips production deployments — DONE
- Added job-level `if` to skip production environment and main/master refs

## AC-4: Remove close/reopen CI trigger hack — DONE
- Removed the "Trigger CI on bot-created PR" step entirely
- GH_PAT is used for PR creation, so CI triggers naturally

## AC-5: CI push-to-main runs only for direct pushes — DONE
- Removed `push` trigger entirely; branch protection requires PR CI check
- `workflow_dispatch` preserved for manual runs on any ref
