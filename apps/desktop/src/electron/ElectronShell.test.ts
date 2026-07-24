import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { beforeEach, vi } from "vite-plus/test";

const { openExternalMock, showItemInFolderMock, writeTextMock } = vi.hoisted(() => ({
  openExternalMock: vi.fn(),
  showItemInFolderMock: vi.fn(),
  writeTextMock: vi.fn(),
}));

vi.mock("electron", () => ({
  shell: {
    openExternal: openExternalMock,
    showItemInFolder: showItemInFolderMock,
  },
  clipboard: {
    writeText: writeTextMock,
  },
}));

import * as ElectronShell from "./ElectronShell.ts";

describe("ElectronShell", () => {
  beforeEach(() => {
    openExternalMock.mockReset();
    showItemInFolderMock.mockReset();
    writeTextMock.mockReset();
  });

  it.effect("reveals a path in the OS file manager", () =>
    Effect.gen(function* () {
      const electronShell = ElectronShell.make;
      const result = yield* electronShell.revealPath("C:/Apollo/logs/138396");

      assert.equal(result, true);
      assert.deepEqual(showItemInFolderMock.mock.calls, [["C:/Apollo/logs/138396"]]);
    }),
  );

  it.effect("refuses to reveal a non-string or blank path", () =>
    Effect.gen(function* () {
      const electronShell = ElectronShell.make;

      assert.equal(yield* electronShell.revealPath("   "), false);
      assert.equal(yield* electronShell.revealPath(42), false);
      assert.equal(showItemInFolderMock.mock.calls.length, 0);
    }),
  );

  it.effect("opens safe external URLs", () =>
    Effect.gen(function* () {
      openExternalMock.mockResolvedValue(undefined);

      const electronShell = yield* ElectronShell.ElectronShell;
      const result = yield* electronShell.openExternal("https://example.com/path");

      assert.equal(result, true);
      assert.deepEqual(openExternalMock.mock.calls, [["https://example.com/path"]]);
    }).pipe(Effect.provide(ElectronShell.layer)),
  );

  it.effect("does not open unsafe external URLs", () =>
    Effect.gen(function* () {
      const electronShell = yield* ElectronShell.ElectronShell;
      const result = yield* electronShell.openExternal("file:///etc/passwd");

      assert.equal(result, false);
      assert.equal(openExternalMock.mock.calls.length, 0);
    }).pipe(Effect.provide(ElectronShell.layer)),
  );

  it.effect("returns false when Electron rejects openExternal", () =>
    Effect.gen(function* () {
      openExternalMock.mockRejectedValue(new Error("open failed"));

      const electronShell = yield* ElectronShell.ElectronShell;
      const result = yield* electronShell.openExternal("https://example.com/path");

      assert.equal(result, false);
    }).pipe(Effect.provide(ElectronShell.layer)),
  );
});
