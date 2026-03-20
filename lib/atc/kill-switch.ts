import { loadJson, saveJson } from "@/lib/storage";

const KILL_SWITCH_KEY = "pipeline-kill-switch";

export interface KillSwitchState {
  enabled: boolean;
  toggledAt: string;
  toggledBy: string;
}

const DEFAULT_STATE: KillSwitchState = {
  enabled: false,
  toggledAt: "",
  toggledBy: "",
};

/**
 * Check if the pipeline kill switch is active.
 * Returns false if the key doesn't exist (default: pipeline runs).
 */
export async function isPipelineKilled(): Promise<boolean> {
  const state = await loadJson<KillSwitchState>(KILL_SWITCH_KEY);
  return state?.enabled ?? false;
}

/**
 * Read the full kill switch state.
 */
export async function getKillSwitchState(): Promise<KillSwitchState> {
  const state = await loadJson<KillSwitchState>(KILL_SWITCH_KEY);
  return state ?? DEFAULT_STATE;
}

/**
 * Toggle the kill switch on or off.
 */
export async function setKillSwitch(
  enabled: boolean,
  toggledBy: string = "ui"
): Promise<KillSwitchState> {
  const state: KillSwitchState = {
    enabled,
    toggledAt: new Date().toISOString(),
    toggledBy,
  };
  await saveJson(KILL_SWITCH_KEY, state);
  return state;
}
