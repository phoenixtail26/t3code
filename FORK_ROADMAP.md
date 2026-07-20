# Fork roadmap

Where this fork is going. Read `FORK_ORCHESTRATOR.md` first for why the fork
exists and what has already changed; companion docs: `FORK_REMOTES.md` (remotes,
branch model, upstream sync), `RUN_FORK_WINDOWS.md` (how to run/build here).

## 1. External session pickup (next major feature — the "radar")

**Goal:** t3code shows ALL Claude Code sessions on the machine — including ones
started in Rider terminals or plain CLI — not just threads it spawned, with at
minimum read visibility and ideally one-click resume.

Full implementation plan with phase/task/delegation breakdown:
`FORK_PLAN_RADAR.md` (2026-07-20). Sketch below kept for context:

- **Discovery:** watch `~/.claude/projects/<project-slug>/*.jsonl` (every
  surface writes there; slug maps to cwd). Tail the newest entries for state:
  working / waiting-on-permission / idle / ended. Incremental, mtime-driven —
  no rescans (see AGENTS.md performance priorities).
- **Representation:** a read-only "External sessions" section per project in
  the sidebar (project matching by cwd), showing title/state/last activity;
  transcript rendering can reuse the JSONL format (same format the SDK emits).
- **Resume:** `claude --resume <sessionId>` in a t3code-owned session adopts
  the conversation into a real thread. The Agent SDK supports `resume`; the
  session id is the JSONL filename. Only offer resume for idle sessions —
  resuming a session another live process owns must be guarded (two writers).
- **Prior art in-tree:** the capabilities probe (`ClaudeProvider.ts`) already
  spawns SDK sessions; `ClaudeHome.ts` already resolves the config dir.
- Owner context: this replaces the earlier "session radar" plan that predated
  choosing t3code (see forsaken `.claude/docs/claudeCommandCenterSetup.md`).

## 2. Phone access (DONE 2026-07-18 — merged to `g3code`)

**Goal:** drive t3code threads from the phone while away from the PC, and be
_told_ when a thread needs attention rather than polling.

Decisions (reviewed 2026-07-18; an earlier draft had HTTPS as optional polish
and no notification story — both were wrong):

- **Transport: Tailscale**, not T3 Connect. A tailnet gives a private mesh with
  no cloud account, no third party seeing thread data, and the phone gets _this
  fork's_ web UI — every feature we add appears there for free. It is also
  general infrastructure (RDP/SSH/files from anywhere), not single-purpose.
  T3 Connect (their relay + Cloudflare tunnel + hosted accounts, alpha) stays a
  watch-item: it is their eventual mobile story and their repo already carries
  an APNs/live-activity model a browser cannot match.
- **HTTPS is v1, not polish.** `t3 serve --tailscale-serve` (or the desktop
  Tailscale HTTPS row) yields `https://machine.tailnet.ts.net`, which is what
  makes the phone experience installable (PWA via `app.t3.codes` pairing) and
  is a hard prerequisite for Web Push later. Plain-HTTP LAN pairing is a
  throwaway you would redo.
- **Notifications are the missing half of "control from my phone".** A web page
  cannot tap you on the shoulder; without push you are back to polling — the
  exact habit this project exists to kill.
- **Boundary:** every self-hosted option needs the PC awake with the app
  running. "Away" meaning "PC asleep" is cloud territory (Claude Code on the
  web / Remote Control), out of scope here.

Implementation status:

- **Done — ntfy notification bridge** (`apps/server/src/notifications/`).
  Subscribes to `orchestrationEngine.streamDomainEvents`, projects each thread
  through the SHARED awareness ladder (`@t3tools/shared/agentAwareness` — the
  same one the relay uses, so both transports agree on "needs attention"), and
  POSTs to an ntfy topic on phase transitions. Opt-in via
  `settings.pushNotifications`: an empty `topicUrl` sends nothing and no thread
  data leaves the machine. Per-phase toggles mirror upstream's
  `RelayAgentAwarenessPreferences` (approval/input/failure/completion), and
  notifications carry a click-through to `publicBaseUrl` + the thread route.
- **Done — host setup, verified end to end.** Tailnet `tailae8de0.ts.net`; PC
  `viki`; Tailscale Serve proxies `https://viki.tailae8de0.ts.net` →
  127.0.0.1:3773 (tailnet only, real cert). Pixel paired in Chrome and
  installed as a PWA; a notification rendered by the shipped code arrived on
  the phone and its click-through opened the deep-linked thread route. Settings
  live in `~\.t3\userdata\settings.json`. Step-by-step and the four traps this
  cost (Tailscale cert enablement, restart-after-install PATH detection, the
  "This environment" section name, camera-app QR eating the pairing cookie) are
  in `RUN_FORK_WINDOWS.md`.
- **Todo — rotate the ntfy topic if it ever leaks**: the topic name is the only
  credential on that channel. Change `topicUrl` and re-subscribe on the phone.
  Self-hosting ntfy on the tailnet is the fully-private upgrade.

## 3. Notification channels (DONE 2026-07-18 — branch `feat/desktop-notifications`)

Phone push alone left the common case uncovered: t3code on another monitor or
behind the IDE, with no signal at all until you happened to look. Now:

- **Desktop/browser notifications** (`useThreadAttentionNotifications`) fire on
  awareness phase transitions, only while the client is unfocused, only once
  per transition, and never for state that already existed at startup. Clicking
  one opens that thread. Implemented in the renderer, so Electron delivers a
  native system notification and the phone PWA gets the same behaviour free.
- **Windows taskbar attention** (overlay dot + frame flash) via the
  `setAttentionState` IPC method, cleared the moment the window regains focus.
- **Per-device preferences** in ClientSettings with Settings rows
  (notifications on/off, sound on/off — sound synthesized, no asset). Device
  preferences belong to the client, unlike the server-side phone push config.
- **Phone suppression**: clients POST `/api/presence`; the ntfy bridge skips
  the push when presence is recent (`suppressWhenPresentSeconds`, default 300,
  0 disables). Presence means focused OR recent OS input (Electron
  `powerMonitor` via `getSystemIdleSeconds`), so working in another app on the
  same machine still counts. Browsers report focus only, failing safe toward
  notifying.

Net effect: at the desk you get a toast; away, the phone; never both.

## 4. Notification settings UI for the phone/push fields (DONE 2026-07-20)

`ServerSettings.pushNotifications` is now editable in Settings → General under
a "Phone push" section: topic URL, click-through base URL, the four per-phase
toggles, the presence-suppression window, and a "Send test" button backed by a
new `server.sendTestPushNotification` RPC (bypasses presence suppression by
design; delivery problems come back inline as values, not errors). The write
path needed no new plumbing — `ServerSettingsPatch` already exposed
`pushNotifications` and `server.updateSettings` deep-merges.

Verification note: in an isolated browser-paired dev environment
(`vp run dev` + pairing token), server-settings writes from the web UI never
reached the server — for the new section AND for long-shipped settings like
"Add project starts in" (optimistic UI updates, no RPC sent, no error
surfaced). Pre-existing behavior, not a regression; the Electron daily driver
uses the local bootstrap grant and is the real test. If phone-PWA sessions
show the same silent read-only behavior, that silent drop deserves its own
fix — surfacing it belongs with roadmap #5's honesty work.

## 5. Surface a stale connection instead of rendering old data

**Goal:** a client that has lost its live connection says so, rather than
silently displaying whatever snapshot it last received.

Motivating incident (2026-07-19): the phone showed an old thread list for hours
while the PC was current. Everything downstream was healthy — Tailscale up,
TLS valid, session authenticating minutes earlier — the client simply held a
stale render with no indication anything was wrong. The user's only clue was
noticing the content looked old, and diagnosis took far longer than the fix
(reset the PWA's storage and re-pair; see RUN_FORK_WINDOWS.md).

The failure mode matters more than that one incident: this fork exists so the
owner can trust a glance at a screen. A surface that can lie about being current
undermines every feature built on top of it — usage meter, notifications, the
session radar — because none of them are worth anything if the view is silently
frozen.

Sketch:

- **Connection state in the UI.** The client already knows when its socket
  drops; show it (a subtle banner or sidebar indicator), including a "last
  updated" time so staleness is legible even mid-reconnect.
- **Reconnect with visible backoff**, and a manual retry. Verify the client
  actually retries indefinitely after a long sleep — a phone that gives up
  after N attempts and never says so is exactly this bug.
- **Treat a snapshot older than a threshold as stale** even if the socket
  claims healthy: a wedged-but-open socket looks identical to a working one.
- **Cheap server-side check** for triage, already documented: a mobile
  session's `lastConnectedAt` from `/api/auth/clients` localises fault to
  client-vs-transport in one step.

## 6. Web Push from the PWA (drops the ntfy dependency)

Now unblocked by real HTTPS on the tailnet. A service worker plus VAPID keys
would let the server push straight to the installed PWA, removing the ntfy app
and the public relay from the path entirely — the fully self-hosted endpoint of
this line of work. Keep ntfy until this is proven; it is the fallback for
platforms where Web Push is unreliable.

## 7. Default base branch for new threads

**Goal:** a new thread in a project starts from that project's intended base
branch, instead of silently inheriting whatever the previous thread was using.

Today there is no project-level default base at all. New draft threads copy the
previous draft's `worktreePath` (`composerDraftStore.ts:1331`), and the same
carry-forward applies to `branch` (:1337) and `startFromOrigin` (:1343). The
reset only fires on `projectChanged` (:1327), which compares `environmentId` /
`projectId` — so switching threads _within_ a project never clears it. The
branch picker then renders that inherited value: `BranchToolbar.tsx:224` reads
`draftThread?.worktreePath`, so the `currentGitBranch` fallback in
`resolveBranchToolbarValue` (`BranchToolbar.logic.ts:94`) is unreachable in
practice.

Observed 2026-07-19: a brand-new thread in this project defaulted to the
`t3code-ba6550be` worktree on `fix/project-bootstrap-duplication` while the
main working tree sat on `g3code`. The recorded merge bases show the drift
accumulating — `git config --get-regexp 'branch\..*\.gh-merge-base'` returns
three worktree branches with three different bases (`g3code`,
`fix/windows-claude-sdk-executable`, `fix/project-bootstrap-duplication`),
because each inherited from whatever preceded it.

Stickiness is a reasonable default when consecutive threads are related, and a
trap when they are not: for this fork nearly all work should branch from
`g3code`, so the inherited value is usually wrong and has to be corrected by
hand on every new thread — easy to forget, and the mistake is only visible
later as a bad merge base.

Sketch: a per-project default base ref in project settings, consulted when a
draft thread is created with no explicit override, falling back to current
behaviour when unset. `createWorktree` needs no change — it already takes the
base as `input.refName` (`GitVcsDriverCore.ts:2267`) and hardcodes nothing.
Worth pairing with the existing `startFromOrigin` path (`ws.ts:840`) so the
default can be "always cut from `origin/g3code`", avoiding stale local bases.

## 8. Fork a thread into a new thread (split work off a big one)

**Goal:** take a thread that has built up real context and branch it into a new
thread that inherits that context, so a side-task can be split off without
re-explaining the problem. Prior art: AgentCraft's "fork a hero".

The provider side is already solved for Claude. The SDK exposes
`forkSession(sessionId, { upToMessageId, title })`, which copies the transcript
into a new session file, remaps every message UUID and preserves the
`parentUuid` chain (`@anthropic-ai/claude-agent-sdk`, `sdk.d.ts:686`); there is
also a `forkSession: boolean` option to use with `resume` (:1465). Note forks
start without undo history — file-history snapshots are not copied.

t3code already persists what a fork needs. Each provider session carries an
opaque `resumeCursor` (`packages/contracts/src/provider.ts:45`), and the Claude
adapter writes `{ resume: <sessionId>, resumeSessionAt: <lastAssistantUuid> }`
into it (`ClaudeAdapter.ts:1456`) and reads it back on start (`:564`, consumed
at `:3094`). A fork is therefore: create a thread, seed its `resumeCursor` from
the parent's, and start with fork semantics. Because `upToMessageId` /
`resumeSessionAt` take a specific message UUID, fork-from-any-point is available
for free — the natural UI is a per-message action, not just "fork from tip".

**The worktree question is the hard part.** `worktreePath` is a plain nullable
string on the thread (`orchestration.ts:354`) with no uniqueness constraint, so
two threads sharing one worktree is already representable, and cleanup already
understands sharing: `getOrphanedWorktreePathForThread` only offers to delete a
worktree when no _other_ thread still references it (`worktreeCleanup.ts:25`).
So the data model needs no change. The options:

- **Share the parent's worktree** — cheapest, and the inherited context stays
  true, because the files the transcript describes are the files that are
  there. Hazard: two agents writing one tree concurrently.
- **New worktree cut from the parent's branch** — isolation, but the fork
  inherits a transcript describing uncommitted edits that do not exist in the
  new tree. The context and the filesystem silently disagree, which is worse
  than no context.
- **New worktree plus carrying the uncommitted changes over** — correct but the
  most work, and needs a story for dirty/conflicting state.

Suggested v1: make it an explicit choice at fork time, defaulting to sharing,
and only offer the fork when the parent thread is idle. That two-writers guard
is the same one roadmap #1 flags for adopting external sessions — worth solving
once for both rather than twice.

Scope note: Claude-first. The Codex/Cursor/Grok adapters keep their own
`resumeCursor` shapes and have no equivalent fork primitive, so the action
should be gated on provider capability rather than assumed universal.

## 9. Smaller candidates

- Usage meter: per-model breakdown when upstream adds more scoped limits;
  optional statusline-style compact mode.
- Custom `CLAUDE_CONFIG_DIR`/homePath support in the usage proxy
  (`claudeUsage.ts` documents the limitation), plus macOS keychain credentials.
- Notification history: a list of recent attention events, so a toast missed
  while the machine was locked is still discoverable in the app.
