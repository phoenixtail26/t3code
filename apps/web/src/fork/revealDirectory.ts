// Fork: a directory mention in chat opens that folder in the OS file manager
// (desktop app only), since a folder has nothing to preview or edit. Mounted
// in chat/MarkdownFileLink.tsx behind its `isDirectory` prop.
import { readLocalApi } from "../localApi";
import { reportMarkdownActionFailure } from "../components/chat/markdownActionFailure";
import { stackedThreadToast, toastManager } from "../components/ui/toast";

export function openDirectoryInFileManager(directoryPath: string): void {
  void (async () => {
    try {
      const api = readLocalApi();
      if (!api) {
        throw new Error("Revealing a folder requires the desktop app.");
      }
      await api.shell.revealPath(directoryPath.replace(/\/+$/, ""));
    } catch (cause) {
      reportMarkdownActionFailure({ operation: "reveal-path", target: directoryPath }, cause);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to reveal folder",
          description: cause instanceof Error ? cause.message : "An error occurred.",
        }),
      );
    }
  })();
}
