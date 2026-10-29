// Fork feature: dictation. The "Voice" section of the General settings page:
// cleanup toggle and dictionary, model state with Download/Remove, and the
// last transcription raw beside cleaned. Mounted by SettingsPanels.
import { DEFAULT_UNIFIED_SETTINGS, type DictationStatus } from "@t3tools/contracts";
import { useEffect, useState, useSyncExternalStore } from "react";

import {
  SettingResetButton,
  SettingsRow,
  SettingsSection,
} from "../components/settings/settingsLayout";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { Button } from "../components/ui/button";
import { Switch } from "../components/ui/switch";
import { Textarea } from "../components/ui/textarea";
import { usePrimarySettings, useUpdatePrimarySettings } from "../hooks/useSettings";
import { formatBytes } from "../lib/formatBytes";
import { usePrimaryEnvironment } from "../state/environments";
import { dictationApi } from "./api";
import { DictationModelStatusStore } from "./modelStatus";
import { dictation } from "./useDictation";

const DICTIONARY_PLACEHOLDER = "tee three => T3\nclaude => Claude";

export function VoiceSettingsSection() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const environmentId = usePrimaryEnvironment()?.environmentId ?? null;
  const voice = settings.dictation;
  const defaults = DEFAULT_UNIFIED_SETTINGS.dictation;

  const [store] = useState(() => new DictationModelStatusStore({ api: dictationApi }));
  const model = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- disposes the store's poll timer when the section unmounts
  useEffect(() => () => store.dispose(), [store]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts the store's fetch (and its download poll timer) for this environment
  useEffect(() => {
    if (environmentId !== null) void store.refresh(environmentId);
  }, [environmentId, store]);
  // The composer's mic button drives downloads and transcriptions; re-read
  // when one starts a download or finishes (back to idle), so the percent and
  // the last transcription are current without the section polling.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscription to the external dictation store
  useEffect(() => {
    if (environmentId === null) return;
    let previous = dictation.getState().phase;
    return dictation.subscribe(() => {
      const next = dictation.getState().phase;
      if (next !== previous && (next === "idle" || next === "downloading")) {
        void store.refresh(environmentId);
      }
      previous = next;
    });
  }, [environmentId, store]);

  const [confirmRemove, setConfirmRemove] = useState(false);
  const status = model.status;

  return (
    <SettingsSection id="voice" title="Voice">
      <SettingsRow
        serverScoped
        settingKeys={["dictation"]}
        title="Filler cleanup"
        description="Drop um, uh, er, ah, a set-off “you know” and doubled words from dictated text."
        resetAction={
          voice.fillerCleanup !== defaults.fillerCleanup ? (
            <SettingResetButton
              label="filler cleanup"
              onClick={() =>
                updateSettings({ dictation: { fillerCleanup: defaults.fillerCleanup } })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={voice.fillerCleanup}
            onCheckedChange={(checked) =>
              updateSettings({ dictation: { fillerCleanup: Boolean(checked) } })
            }
            aria-label="Filler cleanup"
          />
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["dictation"]}
        title="Dictionary"
        description="Corrections applied after transcription, one per line as heard => wanted. Whole words, case-insensitive, in order."
        resetAction={
          voice.dictionary !== defaults.dictionary ? (
            <SettingResetButton
              label="dictionary"
              onClick={() => updateSettings({ dictation: { dictionary: defaults.dictionary } })}
            />
          ) : null
        }
      >
        <div className="pb-2">
          <DictionaryEditor
            value={voice.dictionary}
            onCommit={(dictionary) => updateSettings({ dictation: { dictionary } })}
          />
        </div>
      </SettingsRow>
      <SettingsRow
        title="Transcription model"
        description={modelDescription(status)}
        status={
          model.error !== null ? (
            <span className="text-destructive">{model.error}</span>
          ) : status !== null ? (
            <span className="font-mono break-all">{status.file.path}</span>
          ) : null
        }
        control={
          environmentId === null || status === null ? null : status.model.state === "missing" ? (
            <Button
              size="sm"
              variant="outline"
              disabled={model.downloading || model.removing}
              onClick={() => void store.downloadModel(environmentId)}
            >
              Download
            </Button>
          ) : (
            <Button
              size="sm"
              variant="destructive-outline"
              disabled={model.removing}
              onClick={() => setConfirmRemove(true)}
            >
              Remove
            </Button>
          )
        }
      />
      <SettingsRow
        title="Last transcription"
        description="What the model heard beside what was inserted, to judge the cleanup and dictionary. Kept in memory until the server restarts."
      >
        <div className="pb-2">
          {status?.last ? (
            <TranscriptPair raw={status.last.raw} text={status.last.text} />
          ) : (
            <p className="text-xs text-muted-foreground">No dictation since the server started.</p>
          )}
        </div>
      </SettingsRow>
      <AlertDialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove the transcription model?</AlertDialogTitle>
            <AlertDialogDescription>
              {status !== null
                ? `Deletes ${formatBytes(status.file.sizeBytes)} from disk and cancels any download in progress. The next dictation downloads it again.`
                : "The next dictation downloads it again."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmRemove(false);
                if (environmentId !== null) void store.removeModel(environmentId);
              }}
            >
              Remove
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsSection>
  );
}

function modelDescription(status: DictationStatus | null): string {
  if (status === null) return "English Parakeet model, run locally on this server.";
  const size = formatBytes(status.file.sizeBytes);
  switch (status.model.state) {
    case "missing":
      return `English Parakeet model (${size}), not downloaded. The first dictation fetches it.`;
    case "downloading":
      return `Downloading the English Parakeet model (${size}): ${status.model.percent}%.`;
    case "ready":
      return `English Parakeet model (${size}), ready.`;
  }
}

/**
 * Commits on blur, like DraftInput, but keeps Enter for new lines. The draft
 * resynchronises from the saved value only while unfocused, so another
 * client's save never clobbers an edit in progress.
 */
function DictionaryEditor({
  value,
  onCommit,
}: {
  readonly value: string;
  readonly onCommit: (next: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <Textarea
      size="sm"
      value={draft ?? value}
      placeholder={DICTIONARY_PLACEHOLDER}
      spellCheck={false}
      aria-label="Dictionary"
      onFocus={() => setDraft(value)}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        const next = draft ?? value;
        setDraft(null);
        if (next !== value) onCommit(next);
      }}
    />
  );
}

function TranscriptPair({ raw, text }: { readonly raw: string; readonly text: string }) {
  return (
    <dl className="grid gap-2 text-xs sm:grid-cols-2">
      <div className="min-w-0 space-y-1">
        <dt className="text-muted-foreground">Raw</dt>
        <dd className="whitespace-pre-wrap wrap-anywhere rounded-md bg-muted/40 px-2 py-1.5 text-foreground">
          {raw}
        </dd>
      </div>
      <div className="min-w-0 space-y-1">
        <dt className="text-muted-foreground">Cleaned{raw === text ? " (unchanged)" : ""}</dt>
        <dd className="whitespace-pre-wrap wrap-anywhere rounded-md bg-muted/40 px-2 py-1.5 text-foreground">
          {text}
        </dd>
      </div>
    </dl>
  );
}
