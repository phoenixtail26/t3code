// Fork feature: dictation. The microphone button in the composer footer and
// the pill that replaces it while a model downloads, the mic is open, or a
// transcription is in flight. Mounted by ChatComposer with one JSX element.
// A dictation into another field still belongs to this composer (it supplies
// the environment and the fallback draft); the button then stays a button and
// the pill floats beside that field unless the field has its own button.
import type { EnvironmentId } from "@t3tools/contracts";
import { MicIcon } from "lucide-react";
import { useEffect, useRef } from "react";

import { Button } from "../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { composerTargetKey, type ComposerThreadTarget } from "../composerDraftStore";
import { DictationPill } from "./DictationPill";
import { FloatingDictationPill } from "./FloatingDictationPill";
import { appendDictationToDraft } from "./draft";
import { dictation, useDictationState } from "./useDictation";

export interface DictationButtonProps {
  target: ComposerThreadTarget;
  environmentId: EnvironmentId;
  insertTextAtCursor: (text: string, options?: { ensureLeadingBoundary?: boolean }) => boolean;
}

export function DictationButton(props: DictationButtonProps) {
  const ownerKey = composerTargetKey(props.target);
  const state = useDictationState();
  const mine = state.phase !== "idle" && state.ownerKey === ownerKey;

  // The composer re-renders often; register once per thread and read the
  // latest insert/target through a ref so a re-render never unregisters.
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });
  useEffect(
    () =>
      dictation.registerComposer(ownerKey, {
        environmentId: props.environmentId,
        insertAtCursor: (text) =>
          latest.current.insertTextAtCursor(text, { ensureLeadingBoundary: true }),
        appendToDraft: (text) => appendDictationToDraft(latest.current.target, text),
      }),
    [ownerKey, props.environmentId],
  );

  const recording = mine && state.phase === "recording";
  useEffect(() => {
    if (!recording) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      dictation.cancel();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [recording]);

  const stop = () => dictation.toggle(ownerKey);

  if (mine && state.field === undefined) {
    return <DictationPill state={state} onStop={stop} />;
  }

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => dictation.toggle(ownerKey)}
              aria-label="Dictate"
              data-testid="dictation-button"
            />
          }
        >
          <MicIcon />
        </TooltipTrigger>
        <TooltipPopup>Dictate</TooltipPopup>
      </Tooltip>
      {mine && state.field !== undefined && !state.field.inline ? (
        <FloatingDictationPill anchor={state.field.target.element} state={state} onStop={stop} />
      ) : null}
    </>
  );
}
