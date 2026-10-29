// Fork feature: dictation. Feedback for a dictation into a field that has no
// mic button of its own: the pill, fixed above the field's top-right corner.
// The position is read once on mount and again on scroll or resize only, so
// nothing repaints while the user is simply speaking.
import { useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";

import type { ActiveDictationState } from "./DictationPill";
import { DictationPill } from "./DictationPill";

const GAP_PX = 4;
/** The pill goes below the field when there is no room above it. */
const MIN_TOP_PX = 40;

interface Placement {
  readonly top: number;
  readonly left: number;
  readonly below: boolean;
}

function placementOf(anchor: HTMLElement): Placement {
  const rect = anchor.getBoundingClientRect();
  const below = rect.top < MIN_TOP_PX;
  return { top: below ? rect.bottom + GAP_PX : rect.top - GAP_PX, left: rect.right, below };
}

export function FloatingDictationPill({
  anchor,
  state,
  onStop,
}: {
  anchor: HTMLElement;
  state: ActiveDictationState;
  onStop: () => void;
}) {
  const [placement, setPlacement] = useState<Placement>(() => placementOf(anchor));

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window scroll/resize listeners that re-measure the anchor element
  useLayoutEffect(() => {
    const update = () => {
      const next = placementOf(anchor);
      setPlacement((current) =>
        current.top === next.top && current.left === next.left && current.below === next.below
          ? current
          : next,
      );
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [anchor]);

  return createPortal(
    <div
      data-testid="dictation-floating-pill"
      className="pointer-events-auto fixed z-50"
      style={{
        top: placement.top,
        left: placement.left,
        transform: placement.below ? "translateX(-100%)" : "translate(-100%, -100%)",
      }}
    >
      <DictationPill state={state} onStop={onStop} />
    </div>,
    document.body,
  );
}
