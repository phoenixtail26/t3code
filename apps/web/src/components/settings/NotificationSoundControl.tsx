import { PlayIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { playNotificationSound } from "../../lib/notificationSound";
import { Button } from "../ui/button";

interface NotificationSoundOption {
  readonly name: string;
  readonly path: string;
}

const BUILT_IN_VALUE = "";

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

  return (
    <div className="flex items-center gap-2">
      <select
        className="h-8 rounded-md border border-input bg-transparent px-2 text-xs disabled:opacity-50"
        disabled={disabled}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label="Notification sound"
      >
        <option value={BUILT_IN_VALUE}>Built-in chime</option>
        {options.map((option) => (
          <option key={option.path} value={option.path}>
            {option.name}
          </option>
        ))}
      </select>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() => void playNotificationSound(value)}
        aria-label="Preview notification sound"
      >
        <PlayIcon className="size-3.5" />
        Preview
      </Button>
    </div>
  );
}
