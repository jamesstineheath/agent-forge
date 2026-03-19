import type { Episode } from "./episode-compat";
import { BlobEpisodeStore, syncMemoryWindow } from "./episode-compat";
import { saveJson } from "./storage";

export const MEMORY_COMPAT_KEY = "tlm-memory-compat";

/**
 * Records an episode and regenerates the tlm-memory.md compatibility file.
 */
export async function recordEpisode(
  store: BlobEpisodeStore,
  episode: Episode
): Promise<void> {
  await store.save(episode);

  // Regenerate compatibility file (non-fatal)
  try {
    const memoryMarkdown = await syncMemoryWindow(store);
    await saveJson(MEMORY_COMPAT_KEY, { markdown: memoryMarkdown });
  } catch (err) {
    console.error("[episode-recorder] Failed to sync memory window:", err);
  }
}
