import { createEnvironmentExternalSessionsAtoms } from "@t3tools/client-runtime/state/external-sessions";

import { connectionAtomRuntime } from "../connection/runtime";

/**
 * External Claude Code sessions ("the radar") — fork feature. Wires the
 * per-environment state factory from client-runtime to the web app's
 * connection runtime, mirroring `apps/web/src/state/shell.ts`.
 */
export const environmentExternalSessions =
  createEnvironmentExternalSessionsAtoms(connectionAtomRuntime);
