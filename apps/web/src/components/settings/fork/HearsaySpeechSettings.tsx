// Fork feature: Hearsay behind upstream's voice input. Two rows on the Voice
// panel hold the transcribing environment's Hearsay URL and token, and wrappers
// disable the upstream controls Hearsay takes over while the URL is set.
// Mounted by VoiceSettingsPanel.
import { DEFAULT_UNIFIED_SETTINGS, type EnvironmentId } from "@t3tools/contracts";
import type { ComponentProps, ReactNode } from "react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../../hooks/useSettings";
import { DraftInput } from "../../ui/draft-input";
import {
  SettingResetButton,
  SettingsRow,
  SettingsSection,
  SettingsUnavailableGroup,
} from "../settingsLayout";

const HEARSAY_OPTIONS_NOTE =
  "Hearsay transcribes here, so these options are not used. The dictionary and filler words are set in Hearsay's settings window.";
const HEARSAY_ENGINE_NOTE = "Hearsay runs the model, so this does not apply.";

export function HearsaySpeechSettingsRows({ environmentId }: { environmentId: EnvironmentId }) {
  const hearsay = useEnvironmentSettings(environmentId, (settings) => settings.hearsaySpeech);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const defaults = DEFAULT_UNIFIED_SETTINGS.hearsaySpeech;
  return (
    <>
      <SettingsRow
        title="Hearsay URL"
        description="Send recordings to a Hearsay speech service on this environment instead of the bundled engine, for example http://127.0.0.1:47700. Leave empty to use the bundled engine."
        resetAction={
          hearsay.url !== defaults.url ? (
            <SettingResetButton
              label="Hearsay URL"
              onClick={() => updateSettings({ hearsaySpeech: { url: defaults.url } })}
            />
          ) : null
        }
        control={
          <DraftInput
            size="sm"
            type="url"
            aria-label="Hearsay URL"
            value={hearsay.url}
            onCommit={(url) => updateSettings({ hearsaySpeech: { url } })}
            className="max-w-72"
          />
        }
      />
      <SettingsRow
        title="Hearsay token"
        description="Needed when Hearsay's config sets a token, which it must for any address other than loopback."
        resetAction={
          hearsay.token !== defaults.token ? (
            <SettingResetButton
              label="Hearsay token"
              onClick={() => updateSettings({ hearsaySpeech: { token: defaults.token } })}
            />
          ) : null
        }
        control={
          <DraftInput
            size="sm"
            type="password"
            autoComplete="off"
            aria-label="Hearsay token"
            value={hearsay.token}
            onCommit={(token) => updateSettings({ hearsaySpeech: { token } })}
            className="max-w-72"
          />
        }
      />
    </>
  );
}

/** A settings section whose controls are untouched until the environment's Hearsay URL is set. */
export function HearsayManagedSection({
  environmentId,
  children,
  ...section
}: ComponentProps<typeof SettingsSection> & { environmentId: EnvironmentId | null }) {
  return (
    <SettingsSection {...section}>
      {environmentId === null ? (
        children
      ) : (
        <ManagedByHearsay environmentId={environmentId} note={HEARSAY_OPTIONS_NOTE}>
          {children}
        </ManagedByHearsay>
      )}
    </SettingsSection>
  );
}

/** A row about the bundled engine: untouched until the environment's Hearsay URL is set. */
export function HearsayEngineRow({
  environmentId,
  ...row
}: ComponentProps<typeof SettingsRow> & { environmentId: EnvironmentId }) {
  const url = useEnvironmentSettings(environmentId, (settings) => settings.hearsaySpeech.url);
  if (!url) return <SettingsRow {...row} />;
  // `managed` is the row's own way to turn a control off: inert, dimmed, the reason in a tooltip.
  return <SettingsRow {...row} description={HEARSAY_ENGINE_NOTE} managed={HEARSAY_ENGINE_NOTE} />;
}

function ManagedByHearsay({
  environmentId,
  note,
  children,
}: {
  environmentId: EnvironmentId;
  note: string;
  children: ReactNode;
}) {
  const url = useEnvironmentSettings(environmentId, (settings) => settings.hearsaySpeech.url);
  if (!url) return children;
  return (
    <SettingsUnavailableGroup message={note}>
      {/* `disabled` reaches native controls only; `inert` also stops the custom ones. The
          group already dims titles and descriptions, so those are reset to dim once, not twice. */}
      <fieldset
        disabled
        inert
        className="min-w-0 opacity-50 [&_h3]:opacity-100! [&_p]:opacity-100! [&>*+*]:border-t [&>*+*]:border-border/50 [&>[data-slot=settings-row]]:rounded-none"
      >
        {children}
      </fieldset>
    </SettingsUnavailableGroup>
  );
}

export { useHearsayKeyedConnection } from "./useHearsayKeyedConnection";
