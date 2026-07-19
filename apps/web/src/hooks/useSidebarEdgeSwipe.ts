import { useEffect } from "react";

/**
 * Edge-swipe gestures for the mobile sidebar: drag in from the left edge to
 * open the thread list, drag left to dismiss it. This is the one navigation
 * affordance phones expect and the desktop-first layout never had — reaching
 * the toggle button in the top-left corner one-handed is awkward.
 *
 * Fork-local and deliberately self-contained: it attaches its own listeners
 * rather than threading gesture state through the sidebar's render, so it
 * stays a single additive block against an upstream file.
 */

/** Only a drag starting this close to the left edge opens the sidebar. */
const EDGE_ZONE_PX = 28;
/** Horizontal travel before a drag counts as a swipe. */
const TRIGGER_DISTANCE_PX = 56;
/** Beyond this much vertical travel it is a scroll, not a swipe. */
const MAX_VERTICAL_DRIFT_PX = 40;

export function useSidebarEdgeSwipe(input: {
  readonly enabled: boolean;
  readonly isOpen: boolean;
  readonly setOpen: (open: boolean) => void;
}): void {
  const { enabled, isOpen, setOpen } = input;

  useEffect(() => {
    if (!enabled) return;

    let startX: number | null = null;
    let startY: number | null = null;
    let handled = false;

    const handleTouchStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      // Multi-touch is a pinch or a gesture we should stay out of.
      if (!touch || event.touches.length > 1) {
        startX = null;
        return;
      }
      // Opening is edge-initiated so it cannot fight horizontal scrolling in
      // code blocks; closing can start anywhere over the open sheet.
      if (!isOpen && touch.clientX > EDGE_ZONE_PX) {
        startX = null;
        return;
      }
      startX = touch.clientX;
      startY = touch.clientY;
      handled = false;
    };

    const handleTouchMove = (event: TouchEvent) => {
      if (startX === null || startY === null || handled) return;
      const touch = event.touches[0];
      if (!touch) return;

      const deltaX = touch.clientX - startX;
      const deltaY = touch.clientY - startY;
      if (Math.abs(deltaY) > MAX_VERTICAL_DRIFT_PX) {
        startX = null;
        return;
      }
      if (!isOpen && deltaX > TRIGGER_DISTANCE_PX) {
        handled = true;
        setOpen(true);
        return;
      }
      if (isOpen && deltaX < -TRIGGER_DISTANCE_PX) {
        handled = true;
        setOpen(false);
      }
    };

    const handleTouchEnd = () => {
      startX = null;
      startY = null;
    };

    // Passive: this never calls preventDefault, so scrolling stays smooth.
    const options = { passive: true } as const;
    document.addEventListener("touchstart", handleTouchStart, options);
    document.addEventListener("touchmove", handleTouchMove, options);
    document.addEventListener("touchend", handleTouchEnd, options);
    document.addEventListener("touchcancel", handleTouchEnd, options);
    return () => {
      document.removeEventListener("touchstart", handleTouchStart);
      document.removeEventListener("touchmove", handleTouchMove);
      document.removeEventListener("touchend", handleTouchEnd);
      document.removeEventListener("touchcancel", handleTouchEnd);
    };
  }, [enabled, isOpen, setOpen]);
}
