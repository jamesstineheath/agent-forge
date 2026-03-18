/**
 * ATC Agent Architecture — barrel export
 *
 * Four agents, each with a dedicated cron route:
 *   1. Dispatcher      — dispatch work items to target repos
 *   2. Health Monitor   — monitor active executions via GitHub API
 *   3. Project Manager  — move projects from planning to completion
 *   4. Supervisor       — ensure all agents are healthy and system is learning
 */

export { runProjectManager } from "./project-manager";
export { runSupervisor } from "./supervisor";
export type { HLOStateEntry } from "./supervisor";
export {
  makeEvent,
  recordAgentRun,
  getAgentLastRun,
  getAllAgentHealth,
} from "./utils";
export type { CycleContext } from "./utils";
