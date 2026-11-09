// Fork feature: Hearsay behind upstream's voice input. Two rows on the Voice
// panel hold the transcribing environment's Hearsay URL and token, and wrappers
// disable the upstream controls Hearsay takes over while the URL is set.
// Mounted by VoiceSettingsPanel.
import { useAtomValue } from "@effect/atom-react";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import {
  DEFAULT_UNIFIED_SETTINGS,
  type EnvironmentId,
  type ServerSettings,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useState, type ComponentProps, type ReactNode } from "react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../../hooks/useSettings";
import { serverEnvironment } from "../../../state/server";
import { DraftInput } from "../../ui/draft-input";
import {
  SettingResetButton,
  SettingsRow,
  SettingsSection,
  SettingsUnavailableGroup,
} from "../settingsLayout";

const HEARSAY_DICTIONARY_NOTE =
  "Hearsay handles the dictionary and filler words. Change them in Hearsay's settings window.";
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

const noEnvironmentSettingsAtom = Atom.make<ServerSettings | null>(null);

/**
 * The connection under a new identity whenever the environment's saved Hearsay URL changes, so
 * what loads per connection (the model list and status) reloads. Unchanged until then.
 */
export function useHearsayKeyedConnection(prepared: PreparedConnection | null) {
  const settings = useAtomValue(
    prepared
      ? serverEnvironment.settingsValueAtom(prepared.environmentId)
      : noEnvironmentSettingsAtom,
  );
  const url = settings?.hearsaySpeech.url ?? "";
  const [keyed, setKeyed] = useState({ prepared, url, connection: prepared });
  if (keyed.prepared !== prepared) {
    setKeyed({ prepared, url, connection: prepared });
    return prepared;
  }
  if (keyed.url !== url) {
    const connection = prepared && { ...prepared };
    setKeyed({ prepared, url, connection });
    return connection;
  }
  return keyed.connection;
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
        <ManagedByHearsay environmentId={environmentId} note={HEARSAY_DICTIONARY_NOTE}>
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
  return (
    <SettingsRow
      {...row}
      description={HEARSAY_ENGINE_NOTE}
      control={
        <fieldset disabled inert className="contents opacity-64">
          {row.control}
        </fieldset>
      }
    />
  );
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
      {/* `disabled` reaches native controls only; `inert` also stops the custom ones. */}
      <fieldset disabled inert className="contents [&>*+*]:border-t [&>*+*]:border-border/50">
        {children}
      </fieldset>
    </SettingsUnavailableGroup>
  );
}
