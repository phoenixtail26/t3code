import { PlayIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { playNotificationSound } from "../../lib/notificationSound";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";

interface NotificationSoundOption {
  readonly name: string;
  readonly path: string;
}

const BUILT_IN_VALUE = "";
const BUILT_IN_LABEL = "Built-in chime";

/**
 * Sound picker for desktop notifications: the OS sound set (Windows ships
 * short WAVs in %SystemRoot%\Media) plus the built-in chime, with a preview
 * button so a choice can be heard without contriving a notification.
 *
 * Where no desktop bridge exists (browser, phone PWA) the list is empty and
 * only the built-in chime is offered, which is what plays there anyway.
 */
export function NotificationSoundControl({
  value,
  disabled,
  onChange,
}: {
  readonly value: string;
  readonly disabled: boolean;
  readonly onChange: (soundPath: string) => void;
}) {
  const [options, setOptions] = useState<ReadonlyArray<NotificationSoundOption>>([]);

  useEffect(() => {
    let cancelled = false;
    const list = window.desktopBridge?.listNotificationSounds;
    if (!list) return;
    void list()
      .then((sounds) => {
        if (!cancelled) setOptions(sounds);
      })
      .catch(() => {
        // Leaving the list empty falls back to the built-in chime.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedLabel =
    value === BUILT_IN_VALUE
      ? BUILT_IN_LABEL
      : (options.find((option) => option.path === value)?.name ?? BUILT_IN_LABEL);

  return (
    <div className="flex items-center gap-2">
      <Select value={value} onValueChange={(next) => onChange(next as string)}>
        <SelectTrigger className="w-44" aria-label="Notification sound" disabled={disabled}>
          <SelectValue>{selectedLabel}</SelectValue>
        </SelectTrigger>
        <SelectPopup align="end" alignItemWithTrigger={false}>
          <SelectItem value={BUILT_IN_VALUE}>{BUILT_IN_LABEL}</SelectItem>
          {options.map((option) => (
            <SelectItem key={option.path} value={option.path}>
              {option.name}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() => {
          void playNotificationSound(value).then((played) => {
            if (played) return;
            toastManager.add({
              type: "warning",
              title: "Could not play that sound",
              description: "Fell back to the built-in chime.",
            });
          });
        }}
        aria-label="Preview notification sound"
      >
        <PlayIcon className="size-3.5" />
        Preview
      </Button>
    </div>
  );
}
