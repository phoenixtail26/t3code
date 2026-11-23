// Fork feature: dictation. Registers the composer for mod+shift+u and the palette item
// and shows its pill while dictating; the footer mic button itself is behind
// SHOW_FORK_DICTATION_BUTTON. A dictation into another field still belongs to this
// composer (environment, fallback draft): the pill floats beside that field unless it has one.
import type { EnvironmentId } from "@t3tools/contracts";
import { MicIcon } from "lucide-react";
import { useEffect, useEffectEvent } from "react";

import { Button } from "../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { composerTargetKey, type ComposerThreadTarget } from "../composerDraftStore";
import { DictationPill } from "./DictationPill";
import { FloatingDictationPill } from "./FloatingDictationPill";
import { appendDictationToDraft } from "./draft";
import { SHOW_FORK_DICTATION_BUTTON } from "./upstreamSpeechButton";
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
  // latest insert/target through effect events so a re-render never unregisters.
  const insertAtCursor = useEffectEvent((text: string) =>
    props.insertTextAtCursor(text, { ensureLeadingBoundary: true }),
  );
  const appendToDraft = useEffectEvent((text: string) =>
    appendDictationToDraft(props.target, text),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- holds this composer's entry in the dictation registry until unmount
  useEffect(
    () =>
      dictation.registerComposer(ownerKey, {
        environmentId: props.environmentId,
        insertAtCursor,
        appendToDraft,
      }),
    [ownerKey, props.environmentId],
  );

  const recording = mine && state.phase === "recording";
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- capture-phase window keydown listener that exists only while recording
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
      {SHOW_FORK_DICTATION_BUTTON ? (
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
      ) : null}
      {mine && state.field !== undefined && !state.field.inline ? (
        <FloatingDictationPill anchor={state.field.target.element} state={state} onStop={stop} />
      ) : null}
    </>
  );
}
