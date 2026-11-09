import { useEffect } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { installReadAloudTurnEnd } from "./turnEnd";

/** Keeps the turn-end watcher installed for the life of the app root. */
export function useReadAloudTurnEnd(): void {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- watches thread projections outside React for the turns this client sent, which no render can express
  useEffect(() => installReadAloudTurnEnd(appAtomRegistry), []);
}
