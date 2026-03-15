import { NextResponse } from "next/server";
import { loadJson, saveJson } from "@/lib/storage";

/**
 * Temporary endpoint to test storage reads + dump pipeline state.
 * DELETE AFTER DEBUGGING.
 */
export async function GET() {
  const results: Record<string, unknown> = {};
  const token = process.env.BLOB_READ_WRITE_TOKEN;

  results["env_BLOB_READ_WRITE_TOKEN"] = token ? "set" : "MISSING";

  // Test 1: Write + read (cache hit, should always work)
  try {
    const testValue = { ok: true, ts: Date.now() };
    await saveJson("_debug/roundtrip", testValue);
    const readBack = await loadJson("_debug/roundtrip");
    results["test1_roundtrip"] = {
      success: JSON.stringify(readBack) === JSON.stringify(testValue),
      wrote: testValue,
      readBack,
    };
  } catch (err) {
    results["test1_roundtrip"] = { success: false, error: String(err) };
  }

  // Test 2: Read repos/index via storage module
  try {
    const reposIndex = await loadJson("repos/index");
    results["test2_repos_index"] = {
      success: true,
      value: reposIndex,
      isNull: reposIndex === null,
    };
  } catch (err) {
    results["test2_repos_index"] = { success: false, error: String(err) };
  }

  // Test 3: ATC state
  try {
    const atcState = await loadJson("atc/state");
    results["atc_state"] = atcState;
  } catch (err) {
    results["atc_state"] = { error: String(err) };
  }

  // Test 4: ATC events (last 20)
  try {
    const atcEvents = await loadJson<unknown[]>("atc/events");
    results["atc_events_count"] = atcEvents ? atcEvents.length : 0;
    results["atc_events_recent"] = atcEvents ? atcEvents.slice(-10) : [];
  } catch (err) {
    results["atc_events"] = { error: String(err) };
  }

  // Test 5: Work items index
  try {
    const wiIndex = await loadJson("work-items/index");
    results["work_items_index"] = wiIndex;
  } catch (err) {
    results["work_items_index"] = { error: String(err) };
  }

  return NextResponse.json(results);
}
