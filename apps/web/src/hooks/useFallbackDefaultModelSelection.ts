import { useMemo } from "react";
import { usePrimaryEnvironment } from "../state/environments";
import { resolveDefaultNewProjectModelSelection } from "../modelSelection";

/**
 * Default model selection for draft threads whose project default is missing,
 * derived from the primary environment's enabled providers rather than a
 * hardcoded Codex pair (see resolveDefaultNewProjectModelSelection).
 *
 * Fork-owned file: this exists so the fork's footprint inside ChatView.tsx
 * stays a single call, keeping upstream churn there from conflicting with the
 * fix on every sync (FORK_REMOTES.md, "Cadence and responsibility").
 */
export function useFallbackDefaultModelSelection() {
  const primaryEnvironment = usePrimaryEnvironment();
  return useMemo(
    () => resolveDefaultNewProjectModelSelection(primaryEnvironment?.serverConfig?.providers ?? []),
    [primaryEnvironment?.serverConfig?.providers],
  );
}
