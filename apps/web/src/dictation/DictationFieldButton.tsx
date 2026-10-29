// Fork feature: dictation. A mic button for a text field outside the
// composer, mounted with one JSX element beside that field (the quote-comment
// popover). It dictates into the nearest field in its ancestry and shows the
// pill in place of the button while that dictation runs.
import { MicIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";

import { Button } from "../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { DictationPill } from "./DictationPill";
import { findNearestField, type DictationField } from "./field";
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
      ) : (
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
