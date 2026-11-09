import { RegistryContext } from "@effect/atom-react";
import {
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "@t3tools/client-runtime/connection";
import { DEFAULT_SERVER_SETTINGS, EnvironmentId, type ServerSettings } from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../../test/render";

const state = vi.hoisted(() => ({ settings: new Map<string, unknown>() }));

vi.mock("../../../state/server", () => ({
  serverEnvironment: { settingsValueAtom: (id: string) => state.settings.get(id) },
}));

import { useHearsayKeyedConnection } from "./useHearsayKeyedConnection";

function Probe(props: { prepared: PreparedConnection; seen: Array<PreparedConnection | null> }) {
  props.seen.push(useHearsayKeyedConnection(props.prepared));
  return null;
}

function setup() {
  state.settings.clear();
  const target = new PrimaryConnectionTarget({
    environmentId: EnvironmentId.make("hearsay-keyed"),
    label: "Test environment",
    httpBaseUrl: window.location.origin,
    wsBaseUrl: "ws://localhost",
  });
  const prepared = { ...target, target, socketUrl: target.wsBaseUrl, httpAuthorization: null };
  const settings = Atom.make<ServerSettings | null>(DEFAULT_SERVER_SETTINGS);
  state.settings.set(prepared.environmentId, settings);
  const seen: Array<PreparedConnection | null> = [];
  const ui = (registry: AtomRegistry.AtomRegistry) => (
    <RegistryContext.Provider value={registry}>
      <Probe prepared={prepared} seen={seen} />
    </RegistryContext.Provider>
  );
  return { prepared, settings, seen, ui };
}

it("re-keys the connection only when the saved Hearsay URL changes", async () => {
  const { prepared, settings, seen, ui } = setup();
  await using stack = new AsyncDisposableStack();
  const registry = stack.adopt(AtomRegistry.make(), (made) => made.dispose());
  // A hook probe with no links or navigation.
  await using screen = await render(ui(registry), { router: false });
  expect(seen.at(-1)).toBe(prepared);

  await screen.rerender(ui(registry));
  expect(seen.at(-1)).toBe(prepared);

  await act(() =>
    registry.set(settings, { ...DEFAULT_SERVER_SETTINGS, speechAcceleration: "cpu" }),
  );
  expect(seen.at(-1)).toBe(prepared);

  const withUrl = {
    ...DEFAULT_SERVER_SETTINGS,
    hearsaySpeech: { url: "http://127.0.0.1:47700", token: "" },
  };
  await act(() => registry.set(settings, withUrl));
  const keyed = seen.at(-1);
  expect(keyed).not.toBe(prepared);
  expect(keyed).toEqual(prepared);

  await act(() => registry.set(settings, { ...withUrl, speechAcceleration: "cpu" }));
  expect(seen.at(-1)).toBe(keyed);

  await act(() => registry.set(settings, DEFAULT_SERVER_SETTINGS));
  expect(seen.at(-1)).not.toBe(keyed);
  expect(seen.at(-1)).toEqual(prepared);
});
