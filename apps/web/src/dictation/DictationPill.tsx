// Fork feature: dictation. The pill shown while a model downloads, the mic is
// open, or a transcription is in flight. DictationButton and
// DictationFieldButton render it in place of their button; FloatingDictationPill
// renders it beside a field that has no button.
import { SquareIcon } from "lucide-react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { observeVisibleAnimation } from "../lib/visibleAnimation";
import type { DictationState } from "./controller";
import "./dictation.css";

export type ActiveDictationState = Exclude<DictationState, { phase: "idle" }>;

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

export function DictationPill({
  state,
  onStop,
}: {
  state: ActiveDictationState;
  onStop: () => void;
}) {
  if (state.phase === "recording") {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              onPointerDown={(event) => event.preventDefault()}
              onClick={onStop}
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
