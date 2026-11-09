// Fork feature: read aloud. The summary is pinned to Claude Haiku whatever the server's text
// generation model is; without an enabled Claude instance the server's own model is used.
import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  ProviderInstanceId,
  resolveProjectProviderInstanceEnabled,
  type ModelSelection,
  type ServerSettings,
} from "@t3tools/contracts";

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
export const READ_ALOUD_SUMMARY_MODEL = "claude-haiku-5-5";

export function readAloudSummaryModelSelection(
  settings: Pick<
    ServerSettings,
    "providerInstances" | "projectSettingsOverrides" | "textGenerationModelSelection"
  >,
): ModelSelection {
  const candidates = [
    defaultInstanceIdForDriver(CLAUDE_DRIVER),
    ...Object.entries(settings.providerInstances).flatMap(([instanceId, instance]) =>
      instance.driver === CLAUDE_DRIVER ? [ProviderInstanceId.make(instanceId)] : [],
    ),
  ];
  const instanceId = candidates.find((candidate) =>
    resolveProjectProviderInstanceEnabled(settings, null, candidate),
  );
  return instanceId === undefined
    ? settings.textGenerationModelSelection
    : { instanceId, model: READ_ALOUD_SUMMARY_MODEL };
}
