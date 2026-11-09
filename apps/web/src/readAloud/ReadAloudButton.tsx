// Fork feature: read aloud. The speaker button beside a reply's copy button, mounted by
// TimelineAssistantRows. Shown only when the environment has a Hearsay URL, so T3 Code
// without one looks as upstream does; while this reply loads or plays it is the stop button.
import { Square, Volume2 } from "lucide-react";
import { use } from "react";

import { TimelineRowCtx } from "../components/chat/timelineRowContext";
import { Button } from "../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { useEnvironmentSettings } from "../hooks/useSettings";
import type { ChatMessage } from "../types";
import { startReadAloud, stopReadAloud } from "./player";
import { isReadingMessage, useReadAloudState } from "./store";

export function ReadAloudButton({ message }: { readonly message: ChatMessage }) {
  const ctx = use(TimelineRowCtx);
  const hearsayUrl = useEnvironmentSettings(
    ctx.activeThreadEnvironmentId,
    (settings) => settings.hearsaySpeech.url,
  );
  const state = useReadAloudState();
  const threadRef = ctx.threadRef;
  if (!hearsayUrl || !threadRef || message.streaming || !message.text?.trim()) return null;
  const reading = isReadingMessage(state, message.id);
  const label = reading ? "Stop reading" : "Read aloud";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="ghost-muted"
            aria-label={label}
            onClick={() =>
              reading
                ? stopReadAloud()
                : startReadAloud({
                    environmentId: threadRef.environmentId,
                    threadId: threadRef.threadId,
                    messageId: message.id,
                  })
            }
          />
        }
      >
        {reading ? <Square className="size-3" /> : <Volume2 className="size-3" />}
      </TooltipTrigger>
      <TooltipPopup>
        <p>{label}</p>
      </TooltipPopup>
    </Tooltip>
  );
}
