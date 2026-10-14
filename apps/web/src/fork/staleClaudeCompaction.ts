// Fork: makes upstream's Compact chip for stale Claude threads a choice.
// "always" is upstream's behavior (the chip starts on, Enter compacts first),
// "ask" shows the chip but starts it on Full, "never" hides it. ChatView reads
// the mode through this hook so its own diff stays at a few lines.
import type { ClientSettings } from "@t3tools/contracts/settings";

import { useClientSettings } from "~/hooks/useSettings";

export type StaleClaudeCompaction = ClientSettings["staleClaudeCompaction"];

const selectStaleClaudeCompaction = (settings: ClientSettings) => settings.staleClaudeCompaction;

export function useStaleClaudeCompaction(): StaleClaudeCompaction {
  return useClientSettings(selectStaleClaudeCompaction);
}

// Upstream hides the chip for good, per environment and Claude instance, once
// Claude's own resume prompt is answered "Don't ask again". Picking a mode
// that shows the chip clears those flags so the setting is the way back.
const RESUME_COMPACTION_DISMISSED_PREFIX = "t3code:resume-compaction-dismissed:";

export function clearResumeCompactionDismissals(): void {
  try {
    const storage = window.localStorage;
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter(
      (key): key is string => key?.startsWith(RESUME_COMPACTION_DISMISSED_PREFIX) ?? false,
    );
    for (const key of keys) storage.removeItem(key);
  } catch (error) {
    console.error("[stale-claude-compaction] Could not clear dismissals.", error);
  }
}
