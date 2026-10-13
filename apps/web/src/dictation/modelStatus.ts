// Fork feature: dictation. Model state for the Voice settings section. The
// section reads it through useSyncExternalStore; the store owns the one
// timer that polls `GET /api/dictation/status` while a download is running
// and lets it lapse the moment the state is anything else, so an idle
// settings page makes no requests.
import type { DictationStatus, EnvironmentId } from "@t3tools/contracts";

import type { DictationApi } from "./api";

export interface DictationModelStatusState {
  readonly status: DictationStatus | null;
  /** The last status read or remove/download request that failed, cleared by the next one that succeeds. */
  readonly error: string | null;
  /** A remove or download request is in flight. */
  readonly busy: boolean;
}

export interface DictationModelStatusDeps {
  readonly api: Pick<DictationApi, "status" | "downloadModel" | "removeModel">;
  readonly pollMs?: number;
}

const INITIAL: DictationModelStatusState = { status: null, error: null, busy: false };
const DEFAULT_POLL_MS = 1_000;

export class DictationModelStatusStore {
  readonly #deps: DictationModelStatusDeps;
  readonly #listeners = new Set<() => void>();
  #state: DictationModelStatusState = INITIAL;
  #poll: ReturnType<typeof setTimeout> | null = null;
  #disposed = false;
  // A failed remove must outlive the status re-read that follows it.
  #actionError: string | null = null;
  #statusError: string | null = null;

  constructor(deps: DictationModelStatusDeps) {
    this.#deps = deps;
  }

  getState = (): DictationModelStatusState => this.#state;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** Fetches the status once; keeps fetching only while the model is downloading. */
  async refresh(environmentId: EnvironmentId): Promise<void> {
    this.#clearPoll();
    const result = await this.#deps.api.status(environmentId);
    if (this.#disposed) return;
    if (!result.ok) {
      this.#statusError = result.error;
      this.#setState({ ...this.#state, error: this.#error() });
      return;
    }
    this.#statusError = null;
    this.#setState({ ...this.#state, status: result.value, error: this.#error() });
    if (result.value.model.state === "downloading") this.#schedule(environmentId);
  }

  async removeModel(environmentId: EnvironmentId): Promise<void> {
    await this.#request(environmentId, () => this.#deps.api.removeModel(environmentId));
  }

  /**
   * The route answers when the download is complete, so the status is
   * re-read right away to pick up the `downloading` state and its polling.
   */
  async downloadModel(environmentId: EnvironmentId): Promise<void> {
    await this.#request(environmentId, () => {
      const request = this.#deps.api.downloadModel(environmentId);
      void this.refresh(environmentId);
      return request;
    });
  }

  dispose(): void {
    this.#disposed = true;
    this.#clearPoll();
  }

  async #request(
    environmentId: EnvironmentId,
    send: () => Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }>,
  ): Promise<void> {
    if (this.#state.busy) return;
    this.#setState({ ...this.#state, busy: true });
    const result = await send();
    if (this.#disposed) return;
    this.#actionError = result.ok ? null : result.error;
    this.#setState({ ...this.#state, busy: false, error: this.#error() });
    await this.refresh(environmentId);
  }

  #error(): string | null {
    return this.#actionError ?? this.#statusError;
  }

  #schedule(environmentId: EnvironmentId): void {
    if (this.#poll !== null) return;
    this.#poll = setTimeout(() => {
      this.#poll = null;
      void this.refresh(environmentId);
    }, this.#deps.pollMs ?? DEFAULT_POLL_MS);
  }

  #clearPoll(): void {
    if (this.#poll === null) return;
    clearTimeout(this.#poll);
    this.#poll = null;
  }

  #setState(next: DictationModelStatusState): void {
    this.#state = next;
    for (const listener of this.#listeners) listener();
  }
}
