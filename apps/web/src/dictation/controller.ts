// Fork feature: dictation. One recording at a time for the whole client: the
// controller owns the active recording, the model download that may precede
// it, and the transcription that follows, and delivers the text to the
// composer it started in or to that thread's draft once the user has moved on.
import {
  DICTATION_MAX_SECONDS,
  DICTATION_SAMPLE_RATE,
  type EnvironmentId,
} from "@t3tools/contracts";

import type { DictationApi } from "./api";
import type { ActiveRecorder, StartRecorder } from "./recorder";
import { int16ToBytes } from "./resample";

export type DictationState =
  | { readonly phase: "idle" }
  | { readonly phase: "downloading"; readonly ownerKey: string; readonly percent: number }
  | {
      readonly phase: "recording";
      readonly ownerKey: string;
      readonly elapsedSeconds: number;
      readonly level: number;
    }
  | { readonly phase: "transcribing"; readonly ownerKey: string };

/** A mounted composer that can receive dictated text. */
export interface DictationComposer {
  readonly environmentId: EnvironmentId;
  /** Inserts at the caret of the live composer; false when it refused. */
  readonly insertAtCursor: (text: string) => boolean;
  /** Appends to the thread's stored draft when the composer is gone. */
  readonly appendToDraft: (text: string) => boolean;
}

export interface DictationControllerDeps {
  readonly api: DictationApi;
  readonly startRecorder: StartRecorder;
  readonly notifyError: (title: string, description: string) => void;
  readonly maxSeconds?: number;
}

const IDLE: DictationState = { phase: "idle" };
/** About 15 meter updates a second while the microphone is open. */
const LEVEL_INTERVAL_MS = 66;
const STATUS_POLL_MS = 1_000;
/** Shorter than this is a stray click, not speech; nothing is uploaded. */
const MIN_SAMPLES = DICTATION_SAMPLE_RATE / 4;

interface Owner {
  readonly key: string;
  readonly composer: DictationComposer;
}

export class DictationController {
  readonly #deps: DictationControllerDeps;
  readonly #composers = new Map<string, DictationComposer>();
  readonly #listeners = new Set<() => void>();
  #state: DictationState = IDLE;
  #owner: Owner | null = null;
  #recorder: ActiveRecorder | null = null;
  #timers: Array<ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>> = [];
  /** Bumped whenever the active attempt ends so stale async steps bail out. */
  #generation = 0;

  constructor(deps: DictationControllerDeps) {
    this.#deps = deps;
  }

  getState = (): DictationState => this.#state;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** Mounted composers, newest last; the keybinding targets the newest. */
  registerComposer(key: string, composer: DictationComposer): () => void {
    this.#composers.delete(key);
    this.#composers.set(key, composer);
    return () => {
      if (this.#composers.get(key) === composer) {
        this.#composers.delete(key);
        this.composerLeft(key);
      }
    };
  }

  /** The owning composer navigated away: finish the recording for its draft. */
  composerLeft(key: string): void {
    if (this.#owner?.key !== key) return;
    if (this.#state.phase === "recording") {
      void this.stopAndTranscribe();
    } else if (this.#state.phase === "downloading") {
      this.#finish();
    }
  }

  toggle(key: string | null = this.#newestKey()): void {
    switch (this.#state.phase) {
      case "idle":
        if (key !== null) void this.#start(key);
        return;
      case "recording":
        void this.stopAndTranscribe();
        return;
      default:
        return;
    }
  }

  /** Escape: drop the recording without transcribing it. */
  cancel(): void {
    if (this.#state.phase !== "recording") return;
    this.#recorder?.cancel();
    this.#finish();
  }

  async stopAndTranscribe(): Promise<void> {
    if (this.#state.phase !== "recording" || this.#owner === null || this.#recorder === null) {
      return;
    }
    const owner = this.#owner;
    const pcm = this.#recorder.stop();
    this.#clearTimers();
    this.#recorder = null;
    if (pcm.length < MIN_SAMPLES) {
      this.#finish();
      return;
    }
    const generation = this.#generation;
    this.#setState({ phase: "transcribing", ownerKey: owner.key });
    const result = await this.#deps.api.transcribe(owner.composer.environmentId, int16ToBytes(pcm));
    if (result.ok) {
      this.#deliver(owner, result.value.text);
    } else {
      this.#deps.notifyError("Dictation failed", result.error);
    }
    if (this.#generation === generation) this.#finish();
  }

  #newestKey(): string | null {
    let newest: string | null = null;
    for (const key of this.#composers.keys()) newest = key;
    return newest;
  }

  async #start(key: string): Promise<void> {
    const composer = this.#composers.get(key);
    if (composer === undefined) return;
    const owner: Owner = { key, composer };
    const generation = ++this.#generation;
    const stale = () => this.#generation !== generation;
    const environmentId = composer.environmentId;
    this.#owner = owner;

    const status = await this.#deps.api.status(environmentId);
    if (stale()) return;
    if (!status.ok) {
      this.#deps.notifyError("Dictation unavailable", status.error);
      this.#finish();
      return;
    }
    if (status.value.model.state !== "ready") {
      const initial = status.value.model.state === "downloading" ? status.value.model.percent : 0;
      this.#setState({ phase: "downloading", ownerKey: key, percent: initial });
      const poll = setInterval(() => {
        void this.#deps.api.status(environmentId).then((polled) => {
          if (stale() || !polled.ok || this.#state.phase !== "downloading") return;
          if (polled.value.model.state === "downloading") {
            this.#setState({ ...this.#state, percent: polled.value.model.percent });
          }
        });
      }, STATUS_POLL_MS);
      this.#timers.push(poll);
      const download = await this.#deps.api.downloadModel(environmentId);
      clearInterval(poll);
      if (stale()) return;
      if (!download.ok) {
        this.#deps.notifyError("Model download failed", download.error);
        this.#finish();
        return;
      }
    }

    let recorder: ActiveRecorder;
    try {
      recorder = await this.#deps.startRecorder();
    } catch (error) {
      if (stale()) return;
      this.#deps.notifyError("Microphone unavailable", describeError(error));
      this.#finish();
      return;
    }
    if (stale()) {
      recorder.cancel();
      return;
    }
    this.#recorder = recorder;
    this.#clearTimers();
    this.#setState({ phase: "recording", ownerKey: key, elapsedSeconds: 0, level: 0 });
    this.#timers.push(
      setInterval(() => {
        if (this.#state.phase !== "recording") return;
        this.#setState({ ...this.#state, elapsedSeconds: this.#state.elapsedSeconds + 1 });
      }, 1_000),
      setInterval(() => {
        if (this.#state.phase !== "recording") return;
        this.#setState({ ...this.#state, level: recorder.readLevel() });
      }, LEVEL_INTERVAL_MS),
      setTimeout(
        () => void this.stopAndTranscribe(),
        (this.#deps.maxSeconds ?? DICTATION_MAX_SECONDS) * 1_000,
      ),
    );
  }

  #deliver(owner: Owner, text: string): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    const live = this.#composers.get(owner.key);
    if (live !== undefined && live.insertAtCursor(trimmed)) return;
    if (owner.composer.appendToDraft(trimmed)) return;
    this.#deps.notifyError("Dictated text could not be placed", trimmed);
  }

  #finish(): void {
    this.#generation++;
    this.#clearTimers();
    this.#recorder = null;
    this.#owner = null;
    this.#setState(IDLE);
  }

  #clearTimers(): void {
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers = [];
  }

  #setState(next: DictationState): void {
    this.#state = next;
    for (const listener of this.#listeners) listener();
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.name && error.name !== "Error" ? `${error.name}: ${error.message}` : error.message;
  }
  return String(error);
}
