import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { beforeEach, vi } from "vite-plus/test";

const { openExternalMock, openPathMock, showItemInFolderMock, writeTextMock } = vi.hoisted(() => ({
  openExternalMock: vi.fn(),
  openPathMock: vi.fn(),
  showItemInFolderMock: vi.fn(),
  writeTextMock: vi.fn(),
}));

vi.mock("electron", () => ({
  shell: {
    openExternal: openExternalMock,
    openPath: openPathMock,
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
    openPathMock.mockReset();
    showItemInFolderMock.mockReset();
    writeTextMock.mockReset();
  });

  it.effect("opens a path with the OS default handler", () =>
    Effect.gen(function* () {
      openPathMock.mockResolvedValue("");
      const electronShell = ElectronShell.make;
      const result = yield* electronShell.openPath("C:/Apollo/svn/unity/forsaken");

      assert.equal(result, true);
      assert.deepEqual(openPathMock.mock.calls, [["C:/Apollo/svn/unity/forsaken"]]);
    }),
  );

  it.effect("reports failure when the OS cannot open the path", () =>
    Effect.gen(function* () {
      openPathMock.mockResolvedValue("no application associated");
      const electronShell = ElectronShell.make;

      assert.equal(yield* electronShell.openPath("C:/nope"), false);
    }),
  );

  it.effect("reveals an item selected inside its parent", () =>
    Effect.gen(function* () {
      const electronShell = ElectronShell.make;
      const result = yield* electronShell.revealItemInFolder("C:/Apollo/setup.exe");

      assert.equal(result, true);
      assert.deepEqual(showItemInFolderMock.mock.calls, [["C:/Apollo/setup.exe"]]);
      assert.equal(openPathMock.mock.calls.length, 0);
    }),
  );

  it.effect("refuses a non-string or blank path", () =>
    Effect.gen(function* () {
      const electronShell = ElectronShell.make;

      assert.equal(yield* electronShell.revealItemInFolder("   "), false);
      assert.equal(yield* electronShell.openPath(42), false);
      assert.equal(showItemInFolderMock.mock.calls.length, 0);
      assert.equal(openPathMock.mock.calls.length, 0);
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

  it.effect("opens remote SSH editor URLs", () =>
    Effect.gen(function* () {
      openExternalMock.mockResolvedValue(undefined);

      const electronShell = yield* ElectronShell.ElectronShell;
      const result = yield* electronShell.openExternal(
        "vscode://vscode-remote/ssh-remote+example.com/home/user/project",
      );

      assert.equal(result, true);
      assert.deepEqual(openExternalMock.mock.calls, [
        ["vscode://vscode-remote/ssh-remote+example.com/home/user/project"],
      ]);
    }).pipe(Effect.provide(ElectronShell.layer)),
  );

  it.effect("does not open remote editor URLs with userinfo", () =>
    Effect.gen(function* () {
      openExternalMock.mockResolvedValue(undefined);

      const electronShell = yield* ElectronShell.ElectronShell;
      const results = yield* Effect.all([
        electronShell.openExternal(
          "vscode://user@vscode-remote/ssh-remote+example.com/home/user/project",
        ),
        electronShell.openExternal(
          "vscode://:secret@vscode-remote/ssh-remote+example.com/home/user/project",
        ),
      ]);

      assert.deepEqual(results, [false, false]);
      assert.equal(openExternalMock.mock.calls.length, 0);
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

  it.effect("does not open non-remote editor URLs", () =>
    Effect.gen(function* () {
      openExternalMock.mockResolvedValue(undefined);

      const electronShell = yield* ElectronShell.ElectronShell;
      const result = yield* electronShell.openExternal(
        "vscode://ms-python.python/some-command?argument=attacker",
      );

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
