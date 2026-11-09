// Fork feature: read aloud. The per-device setting's row on Settings → Voice, rendered by the
// fork's Hearsay rows while the environment has a Hearsay URL.
import { SettingResetButton, SettingsRow } from "../components/settings/settingsLayout";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import {
  DEFAULT_READ_ALOUD_MODE,
  READ_ALOUD_MODES,
  setReadAloudMode,
  useReadAloudMode,
  type ReadAloudMode,
} from "./setting";

const LABELS: Record<ReadAloudMode, string> = {
  off: "Off",
  dictated: "After dictated messages",
  always: "After every message",
};

export function ReadAloudSettingRow() {
  const mode = useReadAloudMode();
  return (
    <SettingsRow
      title="Read replies aloud"
      description="When a turn you sent from this device ends, a short spoken summary of the reply plays here."
      resetAction={
        mode !== DEFAULT_READ_ALOUD_MODE ? (
          <SettingResetButton
            label="Read replies aloud"
            onClick={() => setReadAloudMode(DEFAULT_READ_ALOUD_MODE)}
          />
        ) : null
      }
      control={
        <Select
          value={mode}
          onValueChange={(value) => {
            if (value) setReadAloudMode(value as ReadAloudMode);
          }}
        >
          <SelectTrigger size="sm" aria-label="Read replies aloud" className="max-w-72">
            <SelectValue>{LABELS[mode]}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {READ_ALOUD_MODES.map((candidate) => (
              <SelectItem key={candidate} value={candidate}>
                {LABELS[candidate]}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}
