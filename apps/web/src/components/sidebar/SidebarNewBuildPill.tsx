import { RotateCwIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { fetchServedBuildId, isNewBuildAvailable, runningBuildId } from "./newBuildAvailable.logic";

const POLL_INTERVAL_MS = 60_000;

/**
 * Sidebar pill that appears when a newer build has been written to disk under
 * the running app (see newBuildAvailable.logic.ts for why this happens). Click
 * to fully restart the desktop app, which loads the rebuilt server/main code
 * and re-authorizes internal MCP servers as well as the renderer bundle — a
 * plain page reload would only refresh the renderer. Outside the desktop app
 * (browser) it degrades to a page reload. Nothing auto-restarts — in-progress
 * threads are persisted and resume after the restart, on the user's timing.
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

  const handleRestart = useCallback(() => {
    // Prefer a full process restart via the desktop bridge so rebuilt
    // server/main code and internal MCP re-auth are picked up. Fall back to a
    // renderer reload in the browser, where no such bridge exists.
    const bridge = window.desktopBridge;
    if (bridge?.relaunchApp) {
      void bridge.relaunchApp();
      return;
    }
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
              aria-label="Restart to load the new build"
              className="flex h-7 w-full cursor-pointer items-center gap-2 rounded-lg bg-primary/15 px-2 text-xs font-medium text-primary transition-colors hover:bg-primary/22"
              onClick={handleRestart}
            >
              <RotateCwIcon className="size-3.5" />
              <span>New build available</span>
            </button>
          }
        />
        <TooltipPopup align="start" side="top">
          <div className="w-56 text-left text-xs leading-4">
            A newer build is on disk (the app was rebuilt). Restart to load it fully — server and
            MCP changes too, not just the UI. In-progress threads are saved and resume after the
            restart.
          </div>
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}
