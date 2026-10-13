// Fork feature: dictation. The microphone button in the composer footer and
// the pill that replaces it while a model downloads, the mic is open, or a
// transcription is in flight. Mounted by ChatComposer with one JSX element.
import type { EnvironmentId } from "@t3tools/contracts";
import { MicIcon, SquareIcon } from "lucide-react";
import { useEffect, useRef } from "react";

import { Button } from "../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { composerTargetKey, type ComposerThreadTarget } from "../composerDraftStore";
import { observeVisibleAnimation } from "../lib/visibleAnimation";
import { appendDictationToDraft } from "./draft";
import { dictation, useDictationState } from "./useDictation";
import "./dictation.css";

export interface DictationButtonProps {
  target: ComposerThreadTarget;
  environmentId: EnvironmentId;
  insertTextAtCursor: (text: string, options?: { ensureLeadingBoundary?: boolean }) => boolean;
}

/** Relative heights of the meter bars, so the middle one peaks first. */
const METER_BARS = [
  { key: "outer-left", shape: 0.45 },
  { key: "inner-left", shape: 0.75 },
  { key: "centre", shape: 1 },
  { key: "inner-right", shape: 0.75 },
  { key: "outer-right", shape: 0.45 },
] as const;
const METER_MAX_PX = 14;

// Keyframes live in dictation.css; the element exists only while transcribing.
const INDETERMINATE_STYLE = {
  animation: "dictation-slide 1.1s ease-in-out infinite",
  animationPlayState: "var(--visible-animation-state, running)",
} as const;

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

  if (!mine) {
    return (
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
    );
  }

  if (state.phase === "recording") {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => dictation.toggle(ownerKey)}
              aria-label="Stop dictating and transcribe"
              data-testid="dictation-pill"
              data-dictation-phase="recording"
              className="inline-flex h-8 shrink-0 items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-2 text-xs text-foreground tabular-nums sm:h-7"
            />
          }
        >
          <SquareIcon className="size-3 fill-destructive text-destructive" />
          <span aria-hidden="true" className="flex h-3.5 items-end gap-px">
            {METER_BARS.map((bar) => (
              <span
                key={bar.key}
                className="w-0.5 rounded-sm bg-destructive"
                style={{
                  height: `${Math.max(2, Math.round(state.level * bar.shape * METER_MAX_PX))}px`,
                }}
              />
            ))}
          </span>
          <span>{formatElapsed(state.elapsedSeconds)}</span>
        </TooltipTrigger>
        <TooltipPopup>Stop and transcribe. Esc cancels.</TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <div
      role="status"
      data-testid="dictation-pill"
      data-dictation-phase={state.phase}
      className="inline-flex h-8 w-32 shrink-0 flex-col justify-center gap-1 rounded-md border border-border bg-muted px-2 text-2xs text-muted-foreground sm:h-7"
    >
      <span className="truncate leading-none">
        {state.phase === "downloading" ? `Downloading model ${state.percent}%` : "Transcribing"}
      </span>
      <div className="relative h-1 w-full overflow-hidden rounded-full bg-primary/20">
        {state.phase === "downloading" ? (
          <div className="h-full rounded-full bg-primary" style={{ width: `${state.percent}%` }} />
        ) : (
          <div
            ref={observeVisibleAnimation}
            className="absolute inset-y-0 left-0 w-2/5 rounded-full bg-primary"
            style={INDETERMINATE_STYLE}
          />
        )}
      </div>
    </div>
  );
}

function formatElapsed(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${rest < 10 ? "0" : ""}${rest}`;
}
