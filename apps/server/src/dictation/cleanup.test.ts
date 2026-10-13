import { describe, expect, it } from "vite-plus/test";

import { applyDictionary, cleanTranscript, parseDictionary, removeFillers } from "./cleanup.ts";

const clean = (raw: string, dictionary = "", fillerCleanup = true) =>
  cleanTranscript(raw, { fillerCleanup, dictionary });

describe("removeFillers", () => {
  it("drops a filler at the start and capitalises the next word", () => {
    expect(removeFillers("Um, so I think we should ship it.")).toBe(
      "So I think we should ship it.",
    );
    expect(removeFillers("Uh the build is green.")).toBe("The build is green.");
  });

  it("drops a filler in the middle without leaving stray commas", () => {
    expect(removeFillers("I think, uh, we should ship it.")).toBe("I think we should ship it.");
    expect(removeFillers("Run the er tests now.")).toBe("Run the tests now.");
    expect(removeFillers("Then umm add a test.")).toBe("Then add a test.");
  });

  it("moves sentence-ending punctuation from a final filler to the word before", () => {
    expect(removeFillers("It works, uh.")).toBe("It works.");
    expect(removeFillers("Does it work, ah?")).toBe("Does it work?");
    expect(removeFillers("It works. Um.")).toBe("It works.");
  });

  it("capitalises the word after a filler that started a later sentence", () => {
    expect(removeFillers("That failed. Ah, try again.")).toBe("That failed. Try again.");
  });

  it("keeps a lowercase transcript lowercase", () => {
    expect(removeFillers("um so we ship")).toBe("so we ship");
  });

  it("drops 'you know' only when punctuation or the edges set it off", () => {
    expect(removeFillers("It's, you know, fine.")).toBe("It's fine.");
    expect(removeFillers("You know, it compiles.")).toBe("It compiles.");
    expect(removeFillers("It compiles, you know.")).toBe("It compiles.");
    expect(removeFillers("Do you know the way?")).toBe("Do you know the way?");
    expect(removeFillers("You know the drill.")).toBe("You know the drill.");
  });

  it("collapses doubled words, keeping the first word's case and the last word's punctuation", () => {
    expect(removeFillers("Open the the file.")).toBe("Open the file.");
    expect(removeFillers("The the the file is open.")).toBe("The file is open.");
    expect(removeFillers("Fix it it.")).toBe("Fix it.");
    expect(removeFillers("I I think so.")).toBe("I think so.");
  });

  it("collapses words doubled across a removed filler", () => {
    expect(removeFillers("Open the, uh, the file.")).toBe("Open the file.");
  });

  it("keeps grammatical doubles and repeats split by punctuation", () => {
    expect(removeFillers("I knew that that was wrong.")).toBe("I knew that that was wrong.");
    expect(removeFillers("She had had enough.")).toBe("She had had enough.");
    expect(removeFillers("Yes. Yes, that works.")).toBe("Yes. Yes, that works.");
  });

  it("leaves words that only contain a filler alone", () => {
    expect(removeFillers("Umbrella, erase, ahead, hum.")).toBe("Umbrella, erase, ahead, hum.");
  });

  it("returns an empty string for a transcript of fillers only", () => {
    expect(removeFillers("Um, uh.")).toBe("");
  });
});

describe("parseDictionary", () => {
  it("reads heard => wanted lines and ignores malformed ones", () => {
    expect(
      parseDictionary(
        [
          "tee three => T3",
          "",
          "no arrow here",
          " => missing heard",
          "missing wanted =>",
          "  effect  =>  Effect  ",
        ].join("\r\n"),
      ),
    ).toEqual([
      { heard: "tee three", wanted: "T3" },
      { heard: "effect", wanted: "Effect" },
    ]);
  });

  it("returns nothing for an empty dictionary", () => {
    expect(parseDictionary("")).toEqual([]);
  });
});

describe("applyDictionary", () => {
  const entries = parseDictionary("tee three => T3\ntee => T");

  it("replaces case-insensitively", () => {
    expect(applyDictionary("Tee three is great. I like TEE THREE.", entries)).toBe(
      "T3 is great. I like T3.",
    );
  });

  it("matches whole words only", () => {
    expect(applyDictionary("Fourteen tests and fourtee three.", entries)).toBe(
      "Fourteen tests and fourtee three.",
    );
    expect(applyDictionary("Tee threes are not T3.", parseDictionary("tee three => T3"))).toBe(
      "Tee threes are not T3.",
    );
  });

  it("matches a multi-word entry across any whitespace and keeps punctuation", () => {
    expect(applyDictionary("Open tee  three, then tee.", entries)).toBe("Open T3, then T.");
  });

  it("treats the replacement literally", () => {
    expect(applyDictionary("cost", parseDictionary("cost => $1 & $&"))).toBe("$1 & $&");
  });
});

describe("cleanTranscript", () => {
  it("applies the dictionary after the filler pass", () => {
    // The entry only matches once the filler between its words is gone.
    expect(clean("Tee, uh, three is great.", "tee three => T3")).toBe("T3 is great.");
    // An entry that maps to a filler is not undone by the filler pass.
    expect(clean("Say hmm now.", "hmm => um")).toBe("Say um now.");
  });

  it("skips the filler pass when it is off", () => {
    expect(clean("Um, tee three is great.", "tee three => T3", false)).toBe("Um, T3 is great.");
  });

  it("returns the raw text when the dictionary is empty and there are no fillers", () => {
    expect(clean("Tee three is great.")).toBe("Tee three is great.");
  });
});
