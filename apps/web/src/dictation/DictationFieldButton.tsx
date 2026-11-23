// Fork feature: dictation. Mounted with one JSX element beside a text field outside
// the composer (the quote-comment popover): registers the nearest field in its ancestry
// for mod+shift+u and shows the pill in place while that dictation runs. The mic button
// itself is behind SHOW_FORK_DICTATION_BUTTON.
import { MicIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";

import { Button } from "../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { DictationPill } from "./DictationPill";
import { findNearestField, type DictationField } from "./field";
import { SHOW_FORK_DICTATION_BUTTON } from "./forkDictationButton";
import { dictation, useDictationState } from "./useDictation";

export function DictationFieldButton() {
  const state = useDictationState();
  const hostRef = useRef<HTMLSpanElement>(null);
  const [field, setField] = useState<DictationField | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the field from the mounted DOM and holds its button registration until unmount
  useLayoutEffect(() => {
    const found = findNearestField(hostRef.current);
    setField(found);
    if (found === null) return;
    return dictation.registerFieldButton(found.element);
  }, []);

  const mine = state.phase !== "idle" && state.field?.target.element === field?.element;

  return (
    <span ref={hostRef} className="inline-flex">
      {mine ? (
        <DictationPill state={state} onStop={() => dictation.toggle(state.ownerKey)} />
      ) : !SHOW_FORK_DICTATION_BUTTON ? null : (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                disabled={field === null}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => {
                  if (field !== null) dictation.toggleField(field);
                }}
                aria-label="Dictate"
                data-testid="dictation-field-button"
              />
            }
          >
            <MicIcon />
          </TooltipTrigger>
          <TooltipPopup>Dictate</TooltipPopup>
        </Tooltip>
      )}
    </span>
  );
}
