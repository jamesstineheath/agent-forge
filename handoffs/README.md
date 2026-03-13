# Handoffs Directory

This directory contains handoff files -- structured markdown execution plans that Claude Code follows to implement changes.

## How It Works

1. A handoff file is committed to a branch under `handoffs/`
2. The TLM Spec Reviewer triggers and may improve the handoff
3. The Execute Handoff workflow runs Claude Code to execute it
4. A PR is opened with the results
5. The TLM Code Reviewer reviews the PR
6. Low-risk changes auto-merge; others await human review

## Handoff Format (v3)

```markdown
# Title
Budget: $N | Model: opus | Risk: low/medium/high

## Pre-flight
- Verification checks

## Steps
0. Create branch, commit handoff, push
1. First implementation step
2. Second implementation step
...

## Verification
- Build passes
- Tests pass
- Specific acceptance criteria

## Abort Protocol
If stuck: commit + push what works, output structured status.
```

## Subdirectories

- `awaiting_handoff/` -- Handoffs queued for execution
- `handed_off/` -- Completed handoff files (archived)
