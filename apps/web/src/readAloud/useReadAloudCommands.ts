import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";

import { installReadAloudCommands } from "./commands";

/** Keeps the read-aloud key and Escape registered for the life of the app root. */
export function useReadAloudCommands(): void {
  const router = useRouter();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers window-level shortcuts with the dispatcher, which no render can express
  useEffect(() => installReadAloudCommands(router), [router]);
}
