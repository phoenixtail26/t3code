// Fork feature: dictation. Model state for the Voice settings section. The one
// timer polling `GET /api/dictation/status` runs only while a download is
// running, so an idle settings page makes no requests.
import type { DictationStatus, EnvironmentId } from "@t3tools/contracts";

import type { DictationApi } from "./api";

export interface DictationModelStatusState {
  readonly status: DictationStatus | null;
  /** The last status read or remove/download request that failed, cleared by the next one that succeeds. */
  readonly error: string | null;
  /** A download request from this store is in flight. */
  readonly downloading: boolean;
  /** A remove request is in flight. Remove stays available while downloading, since it cancels the download. */
  readonly removing: boolean;
}

export interface DictationModelStatusDeps {
  readonly api: Pick<DictationApi, "status" | "downloadModel" | "removeModel">;
  readonly pollMs?: number;
}

const INITIAL: DictationModelStatusState = {
  status: null,
  error: null,
  downloading: false,
  removing: false,
};
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
  #cancelledDownload = false;

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

  /** Deletes the model, cancelling a download in progress. */
  async removeModel(environmentId: EnvironmentId): Promise<void> {
    if (this.#state.removing) return;
    this.#cancelledDownload = this.#state.downloading;
    this.#setState({ ...this.#state, removing: true });
    const result = await this.#deps.api.removeModel(environmentId);
    if (this.#disposed) return;
    this.#actionError = result.ok ? null : result.error;
    this.#setState({ ...this.#state, removing: false, error: this.#error() });
    await this.refresh(environmentId);
  }

  /**
   * The route answers when the download is complete, so the status is
   * re-read right away to pick up the `downloading` state and its polling.
   */
  async downloadModel(environmentId: EnvironmentId): Promise<void> {
    if (this.#state.downloading || this.#state.removing) return;
    this.#cancelledDownload = false;
    this.#setState({ ...this.#state, downloading: true });
    const request = this.#deps.api.downloadModel(environmentId);
    void this.refresh(environmentId);
    const result = await request;
    if (this.#disposed) return;
    // A remove issued mid-download makes the route fail as cancelled; that
    // is the outcome the user asked for, not an error to show.
    if (!this.#cancelledDownload) this.#actionError = result.ok ? null : result.error;
    this.#cancelledDownload = false;
    this.#setState({ ...this.#state, downloading: false, error: this.#error() });
    await this.refresh(environmentId);
  }

  dispose(): void {
    this.#disposed = true;
    this.#clearPoll();
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
