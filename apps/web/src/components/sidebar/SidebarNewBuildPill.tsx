import { RotateCwIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { fetchServedBuildId, isNewBuildAvailable, runningBuildId } from "./newBuildAvailable.logic";

const POLL_INTERVAL_MS = 60_000;

/**
 * Sidebar pill that appears when a newer build has been written to disk under
 * the running app (see newBuildAvailable.logic.ts for why this happens). Click
 * to do a full reload, which loads the fresh shell and chunks so toast
 * navigation and lazy routes resolve again. Nothing auto-reloads — in-progress
 * threads run on the server and keep going until the user chooses to reload.
 */
export function SidebarNewBuildPill() {
  const [newBuildAvailable, setNewBuildAvailable] = useState(false);

  useEffect(() => {
    // Only meaningful for the built app served from disk; the dev server owns
    // its own reloads via HMR and has no version.json to poll.
    if (!import.meta.env.PROD) return;
    const running = runningBuildId();
    if (running.length === 0) return;

    let cancelled = false;
    const check = async () => {
      const served = await fetchServedBuildId();
      if (cancelled) return;
      // Latch on: once a new build is seen, keep the pill up even if a later
      // poll transiently fails — a reload is the only resolution.
      if (isNewBuildAvailable(running, served)) setNewBuildAvailable(true);
    };
    void check();
    const interval = setInterval(() => void check(), POLL_INTERVAL_MS);
    const handleFocus = () => void check();
    window.addEventListener("focus", handleFocus);
    return () => {
      cancelled = true;
      clearInterval(interval);
      window.removeEventListener("focus", handleFocus);
    };
  }, []);

  const handleReload = useCallback(() => {
    window.location.reload();
  }, []);

  if (!newBuildAvailable) return null;

  return (
    <div className="flex flex-col gap-1">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label="Reload to load the new build"
              className="flex h-7 w-full cursor-pointer items-center gap-2 rounded-lg bg-primary/15 px-2 text-xs font-medium text-primary transition-colors hover:bg-primary/22"
              onClick={handleReload}
            >
              <RotateCwIcon className="size-3.5" />
              <span>New build available</span>
            </button>
          }
        />
        <TooltipPopup align="start" side="top">
          <div className="w-56 text-left text-xs leading-4">
            A newer build is on disk (the app was rebuilt). Reload to load it — running threads keep
            going on the server.
          </div>
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}
