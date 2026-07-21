import { EnvironmentId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { ExternalSessionView } from "../components/ExternalSessionView";
import { SidebarInset } from "../components/ui/sidebar";

/**
 * Read-only transcript route for an external Claude Code session ("the
 * radar"). Fork-local — deliberately kept out of `threadRoutes.ts` /
 * `MessagesTimeline`'s thread-key machinery; see
 * `apps/web/src/components/ExternalSessionView.tsx`.
 */
function ExternalSessionRouteView() {
  const { environmentId: rawEnvironmentId, sessionId } = Route.useParams();
  const environmentId = EnvironmentId.make(rawEnvironmentId);

  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
      <ExternalSessionView environmentId={environmentId} sessionId={sessionId} />
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/$environmentId/external/$sessionId")({
  component: ExternalSessionRouteView,
});
