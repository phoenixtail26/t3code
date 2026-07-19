/**
 * `project.delete` is rejected without `force` while the project still owns
 * undeleted threads. Clients can't reliably predict that rejection: the shell
 * snapshot filters archived threads out, so a project whose only threads are
 * archived looks empty in the sidebar but is not empty to the decider.
 *
 * The detail string is built and recognised here so the two sides can't drift.
 */
export function projectNotEmptyInvariantDetail(projectId: string): string {
  return `Project '${projectId}' is not empty and cannot be deleted without force=true.`;
}

const PROJECT_NOT_EMPTY_INVARIANT_PATTERN = /is not empty and cannot be deleted without force=true/;

export function isProjectNotEmptyInvariantMessage(message: string): boolean {
  return PROJECT_NOT_EMPTY_INVARIANT_PATTERN.test(message);
}
