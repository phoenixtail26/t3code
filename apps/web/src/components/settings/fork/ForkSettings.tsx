// Fork-owned settings UI (notifications + external-session radar). Lives here
// rather than inline in SettingsPanels.tsx so the fork's contact surface in
// that upstream-owned file stays at one import and a few one-line mounts
// (see AGENTS.md, "Fork additions").
import { LoaderIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_UNIFIED_SETTINGS,
  type PushNotificationSettings,
  type UnifiedSettings,
} from "@t3tools/contracts/settings";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../../hooks/useSettings";
import { useWebPushDevice } from "../../../hooks/useWebPush";
import { usePrimaryEnvironment } from "../../../state/environments";
import { serverEnvironment } from "../../../state/server";
import { useAtomCommand } from "../../../state/use-atom-command";
import { Button } from "../../ui/button";
import { DraftInput } from "../../ui/draft-input";
import { Switch } from "../../ui/switch";
import { NotificationSoundControl } from "../NotificationSoundControl";
import { SettingResetButton, SettingsRow, SettingsSection } from "../settingsLayout";

/**
 * Fork entries for useSettingsRestore's dirty-settings summary. Computed in
 * its own memo so the upstream hook only spreads the result and adds one dep.
 */
export function useForkSettingsDirtyLabels(settings: UnifiedSettings): ReadonlyArray<string> {
  return useMemo(
    () => [
      ...(settings.desktopNotificationsEnabled !==
      DEFAULT_UNIFIED_SETTINGS.desktopNotificationsEnabled
        ? ["Desktop notifications"]
        : []),
      ...(settings.desktopNotificationSound !== DEFAULT_UNIFIED_SETTINGS.desktopNotificationSound
        ? ["Notification sound"]
        : []),
      ...(settings.desktopNotificationSoundPath !==
      DEFAULT_UNIFIED_SETTINGS.desktopNotificationSoundPath
        ? ["Notification sound choice"]
        : []),
    ],
    [
      settings.desktopNotificationsEnabled,
      settings.desktopNotificationSound,
      settings.desktopNotificationSoundPath,
    ],
  );
}

/** Fork feature ("the radar"): toggle external Claude Code sessions in the sidebar. */
export function ExternalSessionsSettingRow() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  return (
    <SettingsRow
      title="External sessions"
      description="Show Claude Code sessions running outside T3 (CLI, IDE terminals) under each project in the sidebar."
      resetAction={
        settings.showExternalSessions !== DEFAULT_UNIFIED_SETTINGS.showExternalSessions ? (
          <SettingResetButton
            label="external sessions"
            onClick={() =>
              updateSettings({
                showExternalSessions: DEFAULT_UNIFIED_SETTINGS.showExternalSessions,
              })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={settings.showExternalSessions}
          onCheckedChange={(checked) => updateSettings({ showExternalSessions: Boolean(checked) })}
          aria-label="Show external Claude Code sessions in the sidebar"
        />
      }
    />
  );
}

/** Fork feature: desktop notification toggles (enable, sound, sound choice). */
export function DesktopNotificationSettingRows() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  return (
    <>
      <SettingsRow
        title="Desktop notifications"
        description="Show a system notification when a thread needs approval, asks a question, or fails. Only fires while this app is not focused."
        resetAction={
          settings.desktopNotificationsEnabled !==
          DEFAULT_UNIFIED_SETTINGS.desktopNotificationsEnabled ? (
            <SettingResetButton
              label="desktop notifications"
              onClick={() =>
                updateSettings({
                  desktopNotificationsEnabled: DEFAULT_UNIFIED_SETTINGS.desktopNotificationsEnabled,
                })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={settings.desktopNotificationsEnabled}
            onCheckedChange={(checked) =>
              updateSettings({ desktopNotificationsEnabled: Boolean(checked) })
            }
            aria-label="Enable desktop notifications"
          />
        }
      />

      <SettingsRow
        title="Notification sound"
        description="Play a short sound with desktop notifications."
        resetAction={
          settings.desktopNotificationSound !==
          DEFAULT_UNIFIED_SETTINGS.desktopNotificationSound ? (
            <SettingResetButton
              label="notification sound"
              onClick={() =>
                updateSettings({
                  desktopNotificationSound: DEFAULT_UNIFIED_SETTINGS.desktopNotificationSound,
                })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={settings.desktopNotificationSound}
            disabled={!settings.desktopNotificationsEnabled}
            onCheckedChange={(checked) =>
              updateSettings({ desktopNotificationSound: Boolean(checked) })
            }
            aria-label="Enable notification sound"
          />
        }
      />

      <SettingsRow
        title="Notification sound choice"
        description="Pick which sound plays, and preview it. System sounds come from your OS; the built-in chime is used elsewhere."
        resetAction={
          settings.desktopNotificationSoundPath !==
          DEFAULT_UNIFIED_SETTINGS.desktopNotificationSoundPath ? (
            <SettingResetButton
              label="notification sound choice"
              onClick={() =>
                updateSettings({
                  desktopNotificationSoundPath:
                    DEFAULT_UNIFIED_SETTINGS.desktopNotificationSoundPath,
                })
              }
            />
          ) : null
        }
        control={
          <NotificationSoundControl
            value={settings.desktopNotificationSoundPath}
            disabled={!settings.desktopNotificationsEnabled || !settings.desktopNotificationSound}
            onChange={(soundPath) => updateSettings({ desktopNotificationSoundPath: soundPath })}
          />
        }
      />
    </>
  );
}

/**
 * Server-side phone push configuration (ntfy + Web Push). Unlike the
 * per-device desktop notification toggles, most of these live in
 * ServerSettings — one config for the machine, edited from any client. The
 * "Web Push on this device" row is the exception: it registers THIS
 * browser/PWA with the server so pushes arrive without the ntfy app.
 */
export function PushNotificationSettingsSection() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const primaryEnvironmentId = usePrimaryEnvironment()?.environmentId ?? null;
  const sendTestPush = useAtomCommand(
    serverEnvironment.sendTestPushNotification,
    "send test push notification",
  );
  const webPushDevice = useWebPushDevice(primaryEnvironmentId);
  const webPushStatus = useAtomCommand(serverEnvironment.webPushStatus, "web push status");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ sent: boolean; detail: string } | null>(null);
  const [serverWebPush, setServerWebPush] = useState<{
    subscriptionCount: number;
    deviceLabels: ReadonlyArray<string>;
  } | null>(null);

  // The server, not this client, knows whether ANY device receives Web Push —
  // e.g. the desktop app must not grey out "Send test" when only the phone is
  // registered. Re-queried when this device's own registration changes, and
  // retried because a cold navigation straight to settings can fire before
  // the environment connection is ready.
  useEffect(() => {
    if (primaryEnvironmentId === null) return;
    let cancelled = false;
    let attempt = 0;
    const query = () => {
      void webPushStatus({ environmentId: primaryEnvironmentId, input: {} }).then((result) => {
        if (cancelled) return;
        if (result._tag === "Success") {
          setServerWebPush(result.value);
          return;
        }
        attempt += 1;
        if (attempt < 5) {
          setTimeout(query, 2000);
        }
      });
    };
    query();
    return () => {
      cancelled = true;
    };
  }, [primaryEnvironmentId, webPushStatus, webPushDevice.status.state]);

  const push = settings.pushNotifications;
  const pushDefaults = DEFAULT_UNIFIED_SETTINGS.pushNotifications;
  const webPushActive =
    webPushDevice.status.state === "registered" || (serverWebPush?.subscriptionCount ?? 0) > 0;
  const disabled = push.topicUrl.length === 0 && !webPushActive;
  const updatePush = (patch: Partial<PushNotificationSettings>) =>
    updateSettings({ pushNotifications: { ...push, ...patch } });

  const runTest = () => {
    if (primaryEnvironmentId === null || testing) return;
    setTesting(true);
    setTestResult(null);
    void (async () => {
      const settled = await settlePromise(() =>
        sendTestPush({ environmentId: primaryEnvironmentId, input: {} }),
      );
      const outcome = settled._tag === "Success" ? settled.value : settled;
      setTesting(false);
      setTestResult(
        outcome._tag === "Success"
          ? outcome.value
          : { sent: false, detail: "Request failed. Check the server log." },
      );
    })();
  };

  const phaseToggle = (
    key: "notifyOnApproval" | "notifyOnInput" | "notifyOnFailure" | "notifyOnCompletion",
    title: string,
    description: string,
  ) => (
    <SettingsRow
      title={title}
      description={description}
      resetAction={
        push[key] !== pushDefaults[key] ? (
          <SettingResetButton
            label={title.toLowerCase()}
            onClick={() => updatePush({ [key]: pushDefaults[key] })}
          />
        ) : null
      }
      control={
        <Switch
          checked={push[key]}
          disabled={disabled}
          onCheckedChange={(checked) => updatePush({ [key]: Boolean(checked) })}
          aria-label={title}
        />
      }
    />
  );

  return (
    <SettingsSection title="Phone push">
      <SettingsRow
        title="ntfy topic URL"
        description="Full topic URL, e.g. https://ntfy.sh/your-secret-topic. Empty disables the ntfy channel; Web Push devices keep working. The topic name is the only credential — treat it like a secret."
        resetAction={
          push.topicUrl !== pushDefaults.topicUrl ? (
            <SettingResetButton
              label="ntfy topic URL"
              onClick={() => updatePush({ topicUrl: pushDefaults.topicUrl })}
            />
          ) : null
        }
        control={
          <DraftInput
            className="w-full sm:w-72"
            value={push.topicUrl}
            onCommit={(next) => updatePush({ topicUrl: next.trim() })}
            placeholder="https://ntfy.sh/your-secret-topic"
            spellCheck={false}
            aria-label="ntfy topic URL"
          />
        }
      />
      <SettingsRow
        title="Click-through base URL"
        description="Public URL of this server used to build notification links, e.g. https://machine.tailnet.ts.net. Empty omits the link."
        resetAction={
          push.publicBaseUrl !== pushDefaults.publicBaseUrl ? (
            <SettingResetButton
              label="click-through base URL"
              onClick={() => updatePush({ publicBaseUrl: pushDefaults.publicBaseUrl })}
            />
          ) : null
        }
        control={
          <DraftInput
            className="w-full sm:w-72"
            value={push.publicBaseUrl}
            onCommit={(next) => updatePush({ publicBaseUrl: next.trim() })}
            placeholder="https://machine.tailnet.ts.net"
            spellCheck={false}
            aria-label="Click-through base URL"
          />
        }
      />
      {webPushDevice.status.state !== "unsupported" ? (
        <SettingsRow
          title="Web Push on this device"
          description={
            webPushDevice.error !== null
              ? webPushDevice.error
              : webPushDevice.status.state === "registered"
                ? "This device receives pushes directly from the server — no ntfy app needed."
                : webPushDevice.status.state === "permission-denied"
                  ? "Notifications are blocked for this site. Allow them in the browser settings, then retry."
                  : "Deliver pushes straight to this browser or installed PWA, without the ntfy app."
          }
          control={
            <Button
              size="xs"
              variant="outline"
              disabled={
                primaryEnvironmentId === null ||
                webPushDevice.status.state === "busy" ||
                webPushDevice.status.state === "permission-denied"
              }
              onClick={
                webPushDevice.status.state === "registered"
                  ? webPushDevice.disable
                  : webPushDevice.enable
              }
            >
              {webPushDevice.status.state === "busy" ? (
                <LoaderIcon className="size-3.5 animate-spin" />
              ) : null}
              {webPushDevice.status.state === "busy"
                ? webPushDevice.status.operation === "enabling"
                  ? "Enabling…"
                  : "Disabling…"
                : webPushDevice.status.state === "registered"
                  ? "Disable"
                  : "Enable"}
            </Button>
          }
        />
      ) : null}
      {serverWebPush !== null && serverWebPush.subscriptionCount > 0 ? (
        <SettingsRow
          title="Registered Web Push devices"
          description={`${serverWebPush.subscriptionCount === 1 ? "This device receives" : `These ${serverWebPush.subscriptionCount} devices receive`} pushes directly from the server: ${serverWebPush.deviceLabels.join(", ")}. Manage a device's registration from that device.`}
        />
      ) : null}
      {phaseToggle(
        "notifyOnApproval",
        "Push on approval",
        "A thread is waiting for permission approval.",
      )}
      {phaseToggle(
        "notifyOnInput",
        "Push on question",
        "A thread asked a question and is waiting.",
      )}
      {phaseToggle("notifyOnFailure", "Push on failure", "A thread failed.")}
      {phaseToggle("notifyOnCompletion", "Push on completion", "A thread finished its work.")}
      <SettingsRow
        title="Suppress while at the computer"
        description="Skip the phone push if you were active at this machine within this many seconds — you already got the desktop notification. 0 always pushes."
        resetAction={
          push.suppressWhenPresentSeconds !== pushDefaults.suppressWhenPresentSeconds ? (
            <SettingResetButton
              label="presence suppression window"
              onClick={() =>
                updatePush({ suppressWhenPresentSeconds: pushDefaults.suppressWhenPresentSeconds })
              }
            />
          ) : null
        }
        control={
          <DraftInput
            className="w-full sm:w-24 text-right"
            value={String(push.suppressWhenPresentSeconds)}
            onCommit={(next) => {
              const parsed = Number(next.trim());
              if (!Number.isFinite(parsed) || parsed < 0) return;
              updatePush({ suppressWhenPresentSeconds: Math.round(parsed) });
            }}
            inputMode="numeric"
            spellCheck={false}
            aria-label="Presence suppression window in seconds"
          />
        }
      />
      <SettingsRow
        title="Send a test notification"
        description={
          testResult === null
            ? "Send a test push over every configured channel right now. Ignores the presence suppression above."
            : testResult.detail
        }
        control={
          <Button size="xs" variant="outline" disabled={disabled || testing} onClick={runTest}>
            {testing ? <LoaderIcon className="size-3.5 animate-spin" /> : null}
            {testing ? "Sending…" : "Send test"}
          </Button>
        }
      />
    </SettingsSection>
  );
}
