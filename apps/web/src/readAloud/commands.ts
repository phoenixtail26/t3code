// Fork feature: read aloud. The `chat.readAloud` key and Escape, registered with upstream's
// shortcut dispatcher: the key speaks the open thread's last finished reply, or stops what
// is being read; Escape stops reading when nothing else took it.
import type { EnvironmentId, MessageId, ScopedThreadRef } from "@t3tools/contracts";
import type { AnyRouter } from "@tanstack/react-router";

import { isCommandPaletteOpen } from "../commandPaletteBus";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { registerCommands } from "../shortcuts/dispatcher";
import { serverEnvironment } from "../state/server";
import { environmentThreadDetails } from "../state/threads";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { startReadAloud, stopReadAloud } from "./player";
import { readReadAloudState } from "./store";
import { stopReadAloudWhenTheMicrophoneOpens } from "./stopOnVoiceInput";

function hearsayUrlFor(environmentId: EnvironmentId): string {
  return (
    appAtomRegistry.get(serverEnvironment.settingsValueAtom(environmentId))?.hearsaySpeech.url ?? ""
  );
}

/** The last reply that finished streaming, as the open thread shows it. */
function lastCompletedAssistantMessageId(threadRef: ScopedThreadRef): MessageId | null {
  const items = appAtomRegistry.get(environmentThreadDetails.visibleTurnItemsAtom(threadRef));
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!.item;
    if (item.type === "assistant_message" && !item.streaming && item.text.trim())
      return item.messageId;
  }
  return null;
}

// Thread find dismisses Escape in a listener that runs after the dispatcher, and an open
// dialog, menu or picker owns Escape, so reading yields to any of them on the page.
const ESCAPE_OWNERS =
  '[data-thread-find-bar], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';

function escapeBelongsElsewhere(): boolean {
  return document.querySelector(ESCAPE_OWNERS) !== null;
}

export function installReadAloudCommands(router: AnyRouter): () => void {
  stopReadAloudWhenTheMicrophoneOpens();
  const readRouteThreadRef = () => {
    const target = resolveThreadRouteTarget(router.state.matches.at(-1)?.params ?? {});
    return target?.kind === "server" ? target.threadRef : null;
  };
  return registerCommands(
    {
      "chat.readAloud": (event) => {
        if (readReadAloudState().state !== "idle") {
          event.preventDefault();
          stopReadAloud();
          return;
        }
        const threadRef = readRouteThreadRef();
        if (!threadRef || !hearsayUrlFor(threadRef.environmentId)) return false;
        const messageId = lastCompletedAssistantMessageId(threadRef);
        if (messageId === null) return false;
        event.preventDefault();
        startReadAloud({ ...threadRef, messageId });
      },
    },
    {
      when: () => !isCommandPaletteOpen(),
      onKeyDown: (event) => {
        if (event.key !== "Escape" || readReadAloudState().state === "idle") return false;
        if (escapeBelongsElsewhere()) return false;
        event.preventDefault();
        stopReadAloud();
      },
    },
  );
}
