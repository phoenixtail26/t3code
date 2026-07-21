// Fork feature: force-remove flow for projects whose only threads are
// archived. Lives here rather than inline in Sidebar.tsx's remove-project
// callback so the fork's contact surface in that upstream-owned file stays
// at one import and one guarded call (see AGENTS.md, "Fork additions").
import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { isProjectNotEmptyInvariantMessage } from "@t3tools/shared/orchestrationErrors";

import { stackedThreadToast, toastManager } from "../ui/toast";

interface RemovableProjectMember {
  readonly id: string;
  readonly environmentId: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly environmentLabel?: string | null | undefined;
}

/**
 * Fallback for an unforced project delete rejected by the server's
 * "project not empty" invariant. The caller's thread count only sees threads
 * in the shell snapshot, which omits archived ones — so a project holding
 * nothing but archived threads reaches the failure branch and would
 * dead-end on an invariant message the user can't act on. Re-confirm naming
 * what is actually being destroyed, then retry with force.
 *
 * Returns true when the failure message was recognized and fully handled
 * (confirmed-and-forced, or declined); false when the caller should run its
 * normal failure reporting.
 */
export async function handleArchivedOnlyProjectRemoval(options: {
  readonly member: RemovableProjectMember;
  readonly failureMessage: string;
  readonly confirm: (message: string) => Promise<boolean>;
  readonly forceRemove: () => Promise<AtomCommandResult<unknown, unknown>>;
}): Promise<boolean> {
  const { member, failureMessage, confirm, forceRemove } = options;
  if (!isProjectNotEmptyInvariantMessage(failureMessage)) {
    return false;
  }

  const archivedConfirmed = await confirm(
    [
      `Remove project "${member.title}" and delete its archived threads?`,
      `Path: ${member.workspaceRoot}`,
      ...(member.environmentLabel ? [`Environment: ${member.environmentLabel}`] : []),
      "This project has no visible threads, but it still holds archived ones.",
      "This permanently clears conversation history for those threads.",
      "This action cannot be undone.",
    ].join("\n"),
  );
  if (!archivedConfirmed) {
    return true;
  }

  const forcedResult = await forceRemove();
  if (forcedResult._tag === "Failure" && !isAtomCommandInterrupted(forcedResult)) {
    const forcedError = squashAtomCommandFailure(forcedResult);
    console.error("Failed to remove project", {
      projectId: member.id,
      environmentId: member.environmentId,
      ...safeErrorLogAttributes(forcedError),
    });
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: `Failed to remove "${member.title}"`,
        description:
          forcedError instanceof Error ? forcedError.message : "Unknown error removing project.",
      }),
    );
  }
  return true;
}
