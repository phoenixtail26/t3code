// Fork feature: Hearsay behind upstream's voice input. Two rows on the Voice
// panel hold the transcribing environment's Hearsay URL and token, and a
// section wrapper disables upstream's dictionary and cleanup controls while the
// URL is set, since Hearsay's settings window owns them. Mounted by VoiceSettingsPanel.
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

const HEARSAY_MANAGED_NOTE =
  "Dictionary and cleanup are managed by Hearsay. Change them in Hearsay's settings window.";

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
            placeholder="http://127.0.0.1:47700"
            value={hearsay.url}
            onCommit={(url) => updateSettings({ hearsaySpeech: { url } })}
            className="max-w-72"
          />
        }
      />
      <SettingsRow
        title="Hearsay token"
        description="Hearsay's config token. Needed only when Hearsay is bound to an address other than loopback."
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

type SectionProps = ComponentProps<typeof SettingsSection>;

/** A settings section whose controls are untouched until the environment's Hearsay URL is set. */
export function HearsayManagedSection({
  environmentId,
  children,
  ...section
}: SectionProps & { environmentId: EnvironmentId | null }) {
  return (
    <SettingsSection {...section}>
      {environmentId === null ? (
        children
      ) : (
        <ManagedByHearsay environmentId={environmentId}>{children}</ManagedByHearsay>
      )}
    </SettingsSection>
  );
}

function ManagedByHearsay({
  environmentId,
  children,
}: {
  environmentId: EnvironmentId;
  children: ReactNode;
}) {
  const url = useEnvironmentSettings(environmentId, (settings) => settings.hearsaySpeech.url);
  if (!url) return children;
  return (
    <SettingsUnavailableGroup message={HEARSAY_MANAGED_NOTE}>
      {/* `disabled` reaches native controls only; `inert` also stops the custom ones. */}
      <fieldset disabled inert className="contents">
        {children}
      </fieldset>
    </SettingsUnavailableGroup>
  );
}
