# ATC Deprecation Audit

Generated as part of `feat/deprecate-atc-monolith-cron`.

## Coverage Map

| ATC Section | Description | Agent | File | Function(s) | Status |
|-------------|-------------|-------|------|-------------|--------|
| §0 | Index reconciliation | Dispatcher | `lib/atc/dispatcher.ts` | `runDispatcher` → PHASE 0 calls `reconcileWorkItemIndex()` | ✅ Covered |
| §1-2 | Dispatch logic (concurrency, conflict detection, auto-dispatch, standalone fast lane) | Dispatcher | `lib/atc/dispatcher.ts` | `runDispatcher` → PHASE 1 | ✅ Covered |
| §1.4 | Active-work-items.md updates | Dispatcher | `lib/atc/dispatcher.ts` | `runDispatcher` → section 1.4 | ✅ Covered |
| §2 | Monitoring (GitHub state polling, status transitions) | Health Monitor | `lib/atc/health-monitor.ts` | `runHealthMonitor` → PHASE 2 | ✅ Covered |
| §2.5 | Generating timeout detection | Health Monitor | `lib/atc/health-monitor.ts` | `runHealthMonitor` → section 2.5 | ✅ Covered |
| §2.7 | Merge conflict recovery + auto-rebase | Health Monitor | `lib/atc/health-monitor.ts` | `runHealthMonitor` → PR mergeability check | ✅ Covered |
| §2.8 | Failed item PR reconciliation | Health Monitor | `lib/atc/health-monitor.ts` | `runHealthMonitor` → failed PR reconciliation | ✅ Covered |
| §3 | Stall/timeout detection (stage-aware) | Health Monitor | `lib/atc/health-monitor.ts` | `runHealthMonitor` → timeout checks per status | ✅ Covered |
| §3.4 | Auto-cancel obsolete remediation items | Health Monitor | `lib/atc/health-monitor.ts` | `runHealthMonitor` → section 3.4 | ✅ Covered |
| §3.5 | Retry failed items (max retries, then park) | Health Monitor | `lib/atc/health-monitor.ts` | `runHealthMonitor` → section 3.5 | ✅ Covered |
| §3.6 | Re-evaluate failed items with resolved deps | Health Monitor | `lib/atc/health-monitor.ts` | `runHealthMonitor` → section 3.6 | ✅ Covered |
| §4 | Project retry processing | Project Manager | `lib/atc/project-manager.ts` | `runProjectManager` → §4 | ✅ Covered |
| §4.1 | Dependency block detection + dead dep auto-cancel | Health Monitor | `lib/atc/health-monitor.ts` | `runHealthMonitor` → section 4.1 | ✅ Covered |
| §4.5 | Plan quality gate + decomposition | Project Manager | `lib/atc/project-manager.ts` | `runProjectManager` → §4.5 | ✅ Covered |
| §9.5 | Blob-index reconciliation (hourly) | Supervisor | `lib/atc/supervisor.ts` | `runSupervisor` → §9.5 | ✅ Covered |
| §10 | Escalation timeout monitoring | Supervisor | `lib/atc/supervisor.ts` | `runSupervisor` → §10 | ✅ Covered |
| §11 | Gmail escalation reply polling | Supervisor | `lib/atc/supervisor.ts` | `runSupervisor` → §11 | ✅ Covered |
| §12 | Escalation reminders | Supervisor | `lib/atc/supervisor.ts` | `runSupervisor` → §12 | ✅ Covered |
| §13a | Stuck execution recovery | Project Manager | `lib/atc/project-manager.ts` | `runProjectManager` → §13a | ✅ Covered |
| §13b | Project completion detection | Project Manager | `lib/atc/project-manager.ts` | `runProjectManager` → §13b | ✅ Covered |
| §14 | PM Agent daily sweep | Supervisor | `lib/atc/supervisor.ts` | `runSupervisor` → `runPMAgentSweep()` | ✅ Covered |
| §15 | HLO lifecycle state polling | Supervisor | `lib/atc/supervisor.ts` | `runSupervisor` → `pollHLOStateFromOpenPRs()` | ✅ Covered |
| §16 | Periodic full re-index (stale repos >7d) | Supervisor | `lib/atc/supervisor.ts` | `runSupervisor` → §16 | ✅ Covered |
| Branch cleanup | Stale branch removal | Supervisor | `lib/atc/supervisor.ts` | `cleanupStaleBranches()` | ✅ Covered |
| Agent health | Agent staleness monitoring | Supervisor | `lib/atc/supervisor.ts` | `runSupervisor` → agent health check | ✅ Covered |
| CI failure | CI failure classification + code retry | Health Monitor | `lib/atc/health-monitor.ts` | `classifyCIFailure()`, `handleCodeCIFailure()` | ✅ Covered |

## Gaps (require separate work items)

_None. All ATC monolith sections have full agent coverage._

## Decision

All gaps documented above. ATC cron safe to disable: **YES**

All critical paths are covered:
- ✅ Dispatch of ready work items → Dispatcher agent
- ✅ Stall detection and recovery → Health Monitor agent
- ✅ Project completion detection → Project Manager agent
- ✅ Branch cleanup and supervision → Supervisor agent
