# Handoff 13: Pipeline Agent Wiring + E2E

## Metadata
- **Branch:** `feat/pipeline-escalation-wiring`
- **Priority:** high
- **Model:** opus
- **Type:** feature
- **Max Budget:** $6
- **Risk Level:** low
- **Depends On:** Handoff 11 (Escalation State Machine), Handoff 12 (Gmail Integration)
- **Date:** 2026-03-14
- **Executor:** Claude Code (GitHub Actions)

## Context

Agent Forge's escalation capability (Handoff 11) and Gmail integration (Handoff 12) are now in place. However, the pipeline agents running in target repos (personal-assistant, rez-sniper) cannot yet call the escalation API because:

1. The `/api/escalations` POST endpoint has no authentication
2. The pipeline agents don't know when or how to escalate
3. No test exists to verify the escalation auth flow

This handoff wires the escalation capability into the pipeline by:
- Adding Bearer token authentication to the escalation POST endpoint
- Embedding escalation instructions in handoff metadata/execution context
- Creating a GitHub API script to update target repo workflows
- Adding an auth-level test and an E2E test script

**Assumption:** Handoff 11 and Handoff 12 have already merged. This means:
- `lib/escalation.ts` exists with `createEscalation()`, `resolveEscalation()`, `getEscalations()`
- `lib/gmail.ts` exists with email send/poll
- `/api/escalations` route exists with POST and GET handlers
- WorkItem supports "blocked" status

## Pre-flight Self-Check

Before starting any code changes, verify ALL of these exist. If any are missing, **abort immediately** and report which dependency is missing.
