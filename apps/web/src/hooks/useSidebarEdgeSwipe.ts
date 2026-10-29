import { useEffect } from "react";

/**
 * Swipe-right anywhere opens the mobile sidebar; swipe left dismisses it. Not
 * edge-gated, because Android's back gesture owns the screen edges. A swipe
 * defers to a scrollable ancestor only when it can consume it (a right-swipe
 * needs `scrollLeft > 0`).
 */

/** Horizontal travel before a drag counts as a swipe. */
const TRIGGER_DISTANCE_PX = 56;
/** Beyond this much vertical travel it is a scroll, not a swipe. */
const MAX_VERTICAL_DRIFT_PX = 40;

/** True when the touch begins in a context that owns horizontal drags. */
function touchOwnsHorizontalDrag(target: EventTarget | null, deltaRight: boolean): boolean {
  let element = target instanceof Element ? target : null;
  while (element !== null && element !== document.body) {
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      (element instanceof HTMLElement && element.isContentEditable)
    ) {
      return true;
    }
    // Clipped-but-not-scrollable elements (e.g. `truncate` text) also report
    // scrollWidth > clientWidth; only real scroll containers may claim the drag.
    const overflowX = window.getComputedStyle(element).overflowX;
    const isScrollContainer =
      overflowX === "auto" || overflowX === "scroll" || overflowX === "overlay";
    const canScrollX = isScrollContainer && element.scrollWidth > element.clientWidth + 1;
    if (canScrollX) {
      // A right-swipe needs scrollLeft > 0 to be consumable; a left-swipe
      // needs room remaining on the right.
      const consumable = deltaRight
        ? element.scrollLeft > 0
        : element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
      if (consumable) return true;
    }
    element = element.parentElement;
  }
  return false;
}

export function useSidebarEdgeSwipe(input: {
  readonly enabled: boolean;
  readonly isOpen: boolean;
  readonly setOpen: (open: boolean) => void;
}): void {
  const { enabled, isOpen, setOpen } = input;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- touch listeners on document drive the sidebar open/closed; no React event surface covers a swipe anywhere on the page
  useEffect(() => {
    if (!enabled) return;

    let startX: number | null = null;
    let startY: number | null = null;
    let startTarget: EventTarget | null = null;
    let handled = false;

    const handleTouchStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      // Multi-touch is a pinch or a gesture we should stay out of.
      if (!touch || event.touches.length > 1) {
        startX = null;
        return;
      }
      startX = touch.clientX;
      startY = touch.clientY;
      startTarget = event.target;
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
      if (Math.abs(deltaX) < TRIGGER_DISTANCE_PX) return;

      const deltaRight = deltaX > 0;
      if (touchOwnsHorizontalDrag(startTarget, deltaRight)) {
        startX = null;
        return;
      }
      if (!isOpen && deltaRight) {
        handled = true;
        setOpen(true);
        return;
      }
      if (isOpen && !deltaRight) {
        handled = true;
        setOpen(false);
      }
    };

    const handleTouchEnd = () => {
      startX = null;
      startY = null;
      startTarget = null;
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
