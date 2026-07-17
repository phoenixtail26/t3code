// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const WINDOWS_PATH_DELIMITER = ";";

export interface ClaudeSdkExecutableProbe {
  readonly isFile: (candidate: string) => boolean;
}

function isFileWithNode(candidate: string): boolean {
  try {
    return NodeFS.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function readEnvPath(env: NodeJS.ProcessEnv): string {
  return env.PATH ?? env.Path ?? env.path ?? "";
}

function stripWrappingQuotes(value: string): string {
  return value.replace(/^"+|"+$/g, "");
}

/**
 * Resolve the configured Claude binary into a path the Claude Agent SDK can
 * spawn. The SDK stats `pathToClaudeCodeExecutable` directly instead of
 * searching PATH, so the default bare `claude` only works where `spawn` falls
 * back to a PATH lookup (macOS/Linux). On Windows, npm installs expose
 * `claude` as `.ps1`/`.cmd` shims that neither the SDK nor `spawn` can
 * execute, which made the capability probe and every Claude session fail with
 * "Claude Code native binary not found at claude" — surfaced to users as
 * "Could not verify Claude authentication status" even though `claude` itself
 * was signed in and working.
 *
 * The shim launches the real executable from the npm package installed next
 * to it, so resolve to that executable (or a native `claude.exe` on PATH)
 * when it can be found. Otherwise return the configured value unchanged so
 * explicit user paths and existing error reporting are preserved.
 */
export function resolveClaudeSdkExecutablePath(
  binaryPath: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  probe: ClaudeSdkExecutableProbe = { isFile: isFileWithNode },
): string {
  if (platform !== "win32") return binaryPath;
  if (binaryPath.includes("/") || binaryPath.includes("\\")) return binaryPath;

  for (const rawEntry of readEnvPath(env).split(WINDOWS_PATH_DELIMITER)) {
    const entry = stripWrappingQuotes(rawEntry.trim());
    if (entry.length === 0) continue;

    const nativeExecutable = NodePath.win32.join(entry, `${binaryPath}.exe`);
    if (probe.isFile(nativeExecutable)) return nativeExecutable;

    const cmdShim = NodePath.win32.join(entry, `${binaryPath}.cmd`);
    const ps1Shim = NodePath.win32.join(entry, `${binaryPath}.ps1`);
    if (!probe.isFile(cmdShim) && !probe.isFile(ps1Shim)) continue;

    const packageRoot = NodePath.win32.join(entry, "node_modules", "@anthropic-ai", "claude-code");
    const packagedExecutable = NodePath.win32.join(packageRoot, "bin", "claude.exe");
    if (probe.isFile(packagedExecutable)) return packagedExecutable;
    const packagedCli = NodePath.win32.join(packageRoot, "cli.js");
    if (probe.isFile(packagedCli)) return packagedCli;
  }

  return binaryPath;
}
