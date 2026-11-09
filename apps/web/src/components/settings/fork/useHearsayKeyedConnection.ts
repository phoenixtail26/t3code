// Fork feature: Hearsay behind upstream's voice input. Re-keys a connection on
// the environment's saved Hearsay URL. Mounted by VoiceSettingsPanel.
import { useAtomValue } from "@effect/atom-react";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import type { ServerSettings } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useState } from "react";

import { serverEnvironment } from "../../../state/server";

const noEnvironmentSettingsAtom = Atom.make<ServerSettings | null>(null);

/**
 * The connection under a new identity whenever the environment's saved Hearsay URL changes, so
 * what loads per connection (the model list and status) reloads. Unchanged until then.
 */
export function useHearsayKeyedConnection(prepared: PreparedConnection | null) {
  const settings = useAtomValue(
    prepared
      ? serverEnvironment.settingsValueAtom(prepared.environmentId)
      : noEnvironmentSettingsAtom,
  );
  const url = settings?.hearsaySpeech.url ?? "";
  const [keyed, setKeyed] = useState({ prepared, url, connection: prepared });
  if (keyed.prepared !== prepared) {
    setKeyed({ prepared, url, connection: prepared });
    return prepared;
  }
  // The copy is made inside the updater: made in render, React Compiler would cache it per
  // connection and hand the same object back on the next URL change.
  if (keyed.url !== url)
    setKeyed(() => ({ prepared, url, connection: prepared && { ...prepared } }));
  return keyed.connection;
}
