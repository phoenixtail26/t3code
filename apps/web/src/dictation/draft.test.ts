import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { appendDictationToDraft } from "./draft";

const threadRef = {
  environmentId: EnvironmentId.make("env-1"),
  threadId: ThreadId.make("thread-1"),
};

beforeEach(() => {
  useComposerDraftStore.setState({
    rewindingThreadKeys: new Set(),
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });
});

describe("appendDictationToDraft", () => {
  it("starts an empty draft with the text", () => {
    expect(appendDictationToDraft(threadRef, "hello world")).toBe(true);
    expect(useComposerDraftStore.getState().getComposerDraft(threadRef)?.prompt).toBe(
      "hello world",
    );
  });

  it("separates from existing text with one space", () => {
    useComposerDraftStore.getState().setPrompt(threadRef, "Fix the build");
    appendDictationToDraft(threadRef, "then run the tests");
    expect(useComposerDraftStore.getState().getComposerDraft(threadRef)?.prompt).toBe(
      "Fix the build then run the tests",
    );
  });

  it("does not double a trailing space or newline", () => {
    useComposerDraftStore.getState().setPrompt(threadRef, "First line\n");
    appendDictationToDraft(threadRef, "second line");
    expect(useComposerDraftStore.getState().getComposerDraft(threadRef)?.prompt).toBe(
      "First line\nsecond line",
    );
  });

  it("accumulates across dictations into a draft session", () => {
    const draftId = DraftId.make("draft-1");
    appendDictationToDraft(draftId, "first");
    appendDictationToDraft(draftId, "second");
    expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt).toBe("first second");
  });
});
