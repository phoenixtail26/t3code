// Fork-owned settings UI (notifications + external-session radar). Lives here
// rather than inline in SettingsPanels.tsx so the fork's contact surface in
// that upstream-owned file stays at one import and a few one-line mounts
// (see AGENTS.md, "Fork additions").
import { LoaderIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_UNIFIED_SETTINGS,
  type PushNotificationSettings,
  type UnifiedSettings,
} from "@t3tools/contracts/settings";

import {
  clearResumeCompactionDismissals,
  type StaleClaudeCompaction,
} from "../../../fork/staleClaudeCompaction";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../../hooks/useSettings";
import { useWebPushDevice } from "../../../hooks/useWebPush";
import { usePrimaryEnvironment } from "../../../state/environments";
import { serverEnvironment } from "../../../state/server";
import { useAtomCommand } from "../../../state/use-atom-command";
import { hasNotificationSound } from "../../../threadNotifications";
import { Button } from "../../ui/button";
import { DraftInput } from "../../ui/draft-input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { Switch } from "../../ui/switch";
import { NotificationSoundControl } from "../NotificationSoundControl";
import { SettingResetButton, SettingsRow, SettingsSection } from "../settingsLayout";

/** Fork entries for useSettingsRestore's dirty-settings summary. */
export function forkSettingsDirtyLabels(settings: UnifiedSettings): ReadonlyArray<string> {
  return settings.desktopNotificationSoundPath !==
    DEFAULT_UNIFIED_SETTINGS.desktopNotificationSoundPath
    ? ["Notification sound choice"]
    : [];
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

const STALE_CLAUDE_COMPACTION_LABELS: Record<StaleClaudeCompaction, string> = {
  ask: "Ask",
  always: "Always",
  never: "Never",
};

/**
 * Fork feature: whether a stale Claude thread compacts before the next send.
 * Mounted under the follow-up behavior row.
 */
export function StaleClaudeCompactionSettingRow() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const setMode = (mode: StaleClaudeCompaction) => {
    if (mode !== "never") clearResumeCompactionDismissals();
    updateSettings({ staleClaudeCompaction: mode });
  };
  return (
    <SettingsRow
      title="Compact stale Claude threads"
      description="When a Claude thread over 100k tokens has sat long enough for its prompt cache to expire, the composer offers to summarize the history before sending. Ask starts that offer off, Always starts it on, Never hides it."
      resetAction={
        settings.staleClaudeCompaction !== DEFAULT_UNIFIED_SETTINGS.staleClaudeCompaction ? (
          <SettingResetButton
            label="stale Claude thread compaction"
            onClick={() => setMode(DEFAULT_UNIFIED_SETTINGS.staleClaudeCompaction)}
          />
        ) : null
      }
      control={
        <Select
          value={settings.staleClaudeCompaction}
          onValueChange={(value) => {
            if (value === "ask" || value === "always" || value === "never") setMode(value);
          }}
        >
          <SelectTrigger
            size="sm"
            className="w-auto min-w-0"
            aria-label="Compact stale Claude threads"
          >
            <SelectValue>
              {STALE_CLAUDE_COMPACTION_LABELS[settings.staleClaudeCompaction]}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem value="ask">Ask</SelectItem>
            <SelectItem value="always">Always</SelectItem>
            <SelectItem value="never">Never</SelectItem>
          </SelectPopup>
        </Select>
      }
    />
  );
}

/**
 * Fork feature: pick which OS sound plays for upstream's thread notifications.
 * Sits under the upstream notification mode row; only meaningful when that
 * mode includes sound.
 */
export function NotificationSoundRow() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  return (
    <SettingsRow
      title="Notification sound choice"
      description="Which sound plays for thread notifications on this device. System sounds come from your OS; the default is the bundled sound."
      resetAction={
        settings.desktopNotificationSoundPath !==
        DEFAULT_UNIFIED_SETTINGS.desktopNotificationSoundPath ? (
          <SettingResetButton
            label="notification sound choice"
            onClick={() =>
              updateSettings({
                desktopNotificationSoundPath: DEFAULT_UNIFIED_SETTINGS.desktopNotificationSoundPath,
              })
            }
          />
        ) : null
      }
      control={
        <NotificationSoundControl
          value={settings.desktopNotificationSoundPath}
          disabled={!hasNotificationSound(settings.notificationMode)}
          onChange={(soundPath) => updateSettings({ desktopNotificationSoundPath: soundPath })}
        />
      }
    />
  );
}

/**
 * Server-side phone push configuration (ntfy + Web Push), mostly in
 * ServerSettings. The "Web Push on this device" row is the exception: it
 * registers THIS browser/PWA with the server.
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

  // Only the server knows whether ANY device receives Web Push. Re-queried when
  // this device's registration changes, and retried because a cold navigation
  // can fire before the environment connection is ready.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- retries a server RPC on a timer while the environment connection comes up; the result is external server state
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
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A change in this device's registration re-queries the server-wide count.
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
        description="Full topic URL, e.g. https://ntfy.sh/your-secret-topic. Empty disables the ntfy channel; Web Push devices keep working. The topic name is the only credential, so treat it like a secret."
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
                ? "This device receives pushes directly from the server, no ntfy app needed."
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
        description="Skip the phone push if you were active at this machine within this many seconds (you already got the desktop notification). 0 always pushes."
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
