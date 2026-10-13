// Fork feature: dictation. The command palette's "Dictate into composer"
// action, pushed by CommandPalette with one line while a thread is active.
import { MicIcon } from "lucide-react";

import type { CommandPaletteActionItem } from "../components/CommandPalette.logic";
import { toggleDictation } from "./useDictation";

export function dictationPaletteItem(iconClass: string): CommandPaletteActionItem {
  return {
    kind: "action",
    value: "action:dictate",
    title: "Dictate into composer",
    searchTerms: ["dictate", "voice", "speech", "microphone", "record", "talk"],
    icon: <MicIcon className={iconClass} />,
    shortcutCommand: "composer.dictate",
    run: async () => {
      toggleDictation();
    },
  };
}
