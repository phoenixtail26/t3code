# Fork roadmap

Where this fork is going. Read `FORK_ORCHESTRATOR.md` first for why the fork
exists and what has already changed; companion docs: `FORK_REMOTES.md` (remotes,
branch model, upstream sync), `RUN_FORK_WINDOWS.md` (how to run/build here).

## 1. External session pickup (the "radar") — PHASES 1–4 SHIPPED 2026-07-21

**Goal:** t3code shows ALL Claude Code sessions on the machine — including ones
started in Rider terminals or plain CLI — not just threads it spawned, with at
minimum read visibility and ideally one-click resume.

**Status:** the sidebar radar (phases 1–3, 2-day recency horizon,
working/idle/waiting states, fs-integration harness) AND the Phase-4
read-only transcript view (clickable radar rows → fork-local route rendering
the existing timeline read-only, live-refreshing) are merged to `g3code` and
browser-verified. Phase 5 landed 2026-07-31 as the fork/adopt server stack
(`FORK_PLAN_FORKING.md`, "How it actually landed"): `threads.forkThread` and
`threads.adoptExternalSession` RPCs fork the CLI session file (never extend
it) and create a cursor-seeded thread; adopt derives the project from the
session cwd. **Remaining: the web UI actions + a live integrated pass.**
Plan, per-task delegation, and current status line: `FORK_PLAN_RADAR.md` /
`FORK_PLAN_FORKING.md`; module internals:
`apps/server/src/externalSessions/DESIGN.md`. Original sketch kept below for
context:

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

Post-ship fixes (2026-07-21), after live testing found "Send test" failing and
toggles not sticking:

- **Send test defected server-side**: every rpc served over the WebSocket must
  be registered in `RPC_REQUIRED_SCOPE` (apps/server/src/ws.ts) or
  `requiredScopeForMethod` throws at request time — a third registration point
  beyond the contracts group and the handler. Fixed; `wsRpcScopes.test.ts` now
  asserts the map covers every rpc in `WsRpcGroup`.
- **Toggles persisted but the UI didn't reflect them**: the config projection
  stalls after a reconnect (see #5 below for the diagnosis). Settings writes
  now apply the server's acked response via an overlay in
  `apps/web/src/hooks/useSettings.ts`, so the UI shows committed state in any
  connection state; a fresh projection value clears the overlay.
- Correction to the earlier verification note: the "silent write drop" seen in
  browser-paired dev environments was a test-harness artifact, not an app
  behavior — a hidden preview webview never fires focus/blur events, so
  commit-on-blur inputs never commit. Writes from real browser sessions work.

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

Root cause found (2026-07-21, while debugging the #4 toggle bug; reproduced
deterministically in an isolated env by restarting the dev server under a
paired browser): after a WebSocket reconnect, **durable RPC subscriptions
(`subscribeServerConfig`, `subscribeShell`, `subscribeServerLifecycle`) resume
late or not at all until the next reconnect**, while unary commands recover
immediately. Observed via a `WebSocket.prototype.send` tap: after one restart
the client sent only `server.getConfig` and no re-subscribes for the session's
entire ~74s lifetime; the re-subscribes for all three streams went out together
only after a _second_ restart. During the stall the projection atom keeps
serving its last value (`Success`, source `"live"`) with no error anywhere —
`resolveServerConfigValue` then prefers that stale "live" projection over the
freshly re-fetched `initialConfig`. Suspect: the durable `subscribe()` in
`packages/client-runtime/src/rpc/client.ts` switchMaps over
`SubscriptionRef.changes(supervisor.session)`, and the switch away from the
dead session's inner stream appears to block (teardown against a dead
transport?) until the next session churn — `supervisor.session` itself
transitions correctly (generation bumps, commands work). A page reload always
heals. Fix belongs here: make the switch non-blocking or watchdog the
subscription (no event + session generation changed → resubscribe), and stop
preferring a stale "live" projection over newer `initialConfig`.

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

**Implemented 2026-07-21** (branch `t3code/webpush`) and **verified live the
same day**: the owner enabled Web Push from the phone PWA over the tailnet and
delivery worked. Both channels share the phase/toggle/presence gating, so
nothing double-fires differently.

**ntfy decision (2026-07-21): retire the usage, keep the code.** Web Push is
now strictly more private than public ntfy — the payload is end-to-end
encrypted (aes128gcm), so FCM relays only ciphertext, whereas ntfy.sh saw
plaintext titles/bodies. Plan: run Web Push–only for a trial week (clear
`topicUrl` in Settings, which also retires the topic credential; uninstall the
ntfy app), then delete the topic if nothing goes missing. The ntfy code stays
as a dormant fallback — inert with an empty `topicUrl`, near-zero upkeep, and
an escape hatch for devices where Web Push is flaky (iOS Safari). This also
obsoletes #2's "self-host ntfy" upgrade path.

**Doze fix (2026-07-21), after pushes stopped arriving on an idle phone:**
FCM only wakes a dozing device for `Urgency: high`, and the original 1-hour
TTL meant a deferred message was silently dropped before the phone woke — the
push then never arrived at all. Every push now goes out `high` (presence
suppression already guarantees a push only fires when the user is away, so
every push is wake-worthy) with a 24-hour TTL. Chrome does NOT need the
battery-unrestricted exemption for this.

**Known gap (follow-up): `pushsubscriptionchange` is unhandled.** Chrome/FCM
can rotate a push subscription; when that happens pushes stop silently until
the device is re-enabled by hand in Settings. Fixing it properly means the
service worker re-subscribes and re-registers itself — which needs a plain
HTTP re-register endpoint, because the RPCs are WebSocket-only and a service
worker cannot hold the WS session. Watch-signals during the trial week:
notifications quietly stop arriving, or "Send test" starts reporting a stale
device being pruned.

How it works:

- **Server** (`apps/server/src/notifications/`): `WebPushStore` keeps the
  VAPID keypair (generated on first use) and the per-device subscriptions in
  the `ServerSecretStore` secrets dir (`web-push-store.bin`) — deliberately
  NOT in `settings.json`, so the private key and the endpoint capabilities
  never ride the settings RPCs or `getConfig`. `WebPushSender` uses the
  `web-push` npm package for crypto only (VAPID JWT + aes128gcm via
  `generateRequestDetails`) and posts through the same Effect `HttpClient`
  stack as ntfy, so tests intercept it with a local HTTP stub. 404/410
  responses prune the subscription. `resolvePushNotification` is now
  channel-agnostic; `PushNotifierService.deliver` fans out to ntfy (if
  `topicUrl`) and all Web Push subscriptions.
- **RPCs**: `server.webPushGetPublicKey` / `server.webPushSubscribe` (upsert
  by endpoint) / `server.webPushUnsubscribe`, registered at all four points
  (contracts group, ws handler, `RPC_REQUIRED_SCOPE`, client-runtime
  commands). `server.sendTestPushNotification` now tests every configured
  channel and reports per-channel detail inline.
- **Web** (`apps/web`): `public/sw.js` renders pushes and deep-links on tap
  (payload shape: `WebPushMessagePayload` in contracts — kept in sync by
  hand, the SW cannot import workspace code); registered at bootstrap
  (browser/PWA only, never Electron). Settings → Phone push gained a
  "Web Push on this device" row (`useWebPushDevice`): permission →
  `pushManager.subscribe` with the server key → register RPC, with rollback
  if the server rejects.

Verified in an isolated env: SW registration, key generation + persistence,
subscribe/test-send/unsubscribe round-trips over the live WS, and the inline
error path (the Electron preview webview has no push service — real browsers
do). Real delivery needs a real push service: enable it from the phone PWA at
`https://viki.tailae8de0.ts.net` → Settings → "Web Push on this device", then
"Send test". Unit tests cover the sender against a local stub with real
crypto (delivery, 410 pruning) and the store roundtrip.

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

**Status (2026-07-31):** server stack landed — `threads.forkThread` forks the
whole session via the SDK's standalone `forkSession` and creates a
cursor-seeded thread sharing the parent's tree (`FORK_PLAN_FORKING.md`).
Remaining from the sketch below: web UI (in flight), fork-from-message
(needs a t3-message → transcript-UUID mapping), fresh-worktree-on-fork, and
the idle-only guard.

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

## 9. Click a file mention in chat to view it — SHIPPED 2026-07-22 (`g3code`)

**Status:** inline-code file mentions render as clickable `MarkdownFileLink`
chips (in-app preview on click, Ctrl/⌘-click and right-click → open in editor).
Shipped decisions that diverge from the sketch below:

- **Inline-code auto-linking requires a path separator** (`/` or `\`), not just
  a known extension. A bare filename (`claudeUsage.ts`) has no directory, so it
  can only (mis)resolve to the workspace root and render a chip that fails to
  open — the file usually lives in a subtree, and may be ambiguous (two
  `claudeUsage.ts`). Bare names stay plain code; explicit markdown links keep
  the liberal href path. See `isInlineFileMentionCandidate` in `markdown-links.ts`.
- **Bug found + fixed during impl:** `renderSkillInlineMarkdownChildren`'s
  skip-guard matched overridden tags by `child.type` string, so the new
  component-overridden `code`/`a` elements had their children rewrapped —
  breaking text extraction (the chip silently never rendered) and letting skill
  tokens render inside code spans. Now matches `props.node.tagName`; the `code`
  override reads span text via `plainHastText(node)`. Regression-tested in
  `ChatMarkdown.inlineFileMentions.test.tsx`.
- **Chip weight** tuned in `fork.css` (solid `--muted` fill, full border,
  monospace label) so a chip reads as a distinct token, not faded prose.
- **Related follow-ups shipped same day:** markdown preview defaults to the
  rendered view (`resolveRenderMarkdown`), and Ctrl/⌘-click on a chip opens the
  external editor.

The bare-paths-in-prose scanner (below) remains deliberately unshipped.

**Goal:** when an agent names a file in the conversation — `.claude/docs/foo.md`,
`apps/server/src/ws.ts:840`, a bare relative path in prose — clicking it opens
the file's contents in t3code, both as an in-app read-only view (rendered
markdown / syntax-highlighted source) and via "open in external editor"
(Rider/VS Code). Today the only way to see a mentioned file is to track it down
in Explorer and open it by hand — the exact manual step this fork exists to
kill.

**The machinery already exists; the trigger is too narrow.** A file mention is
fully clickable _only when it arrives as markdown-link syntax_ `[text](path)`
(or a `file://` URI). In that case `ChatMarkdown`'s `a` override resolves it
(`apps/web/src/markdown-links.ts:191`, `resolveMarkdownFileLinkMeta`) and
renders a `MarkdownFileLink` chip (`ChatMarkdown.tsx:1013`) with icon, full-path
tooltip, click-to-open, and a right-click menu (Open in editor / Open in
integrated browser / Copy relative/full path). Click →
`rightPanelStore.openFile(threadRef, relativePath, line)`
(`rightPanelStore.ts:262`) → `FilePreviewPanel.tsx` fetches contents over the
`projects.readFile` RPC (`contracts/src/rpc.ts:162`, served by
`WorkspaceFileSystem.readFile`, 1MB-capped and path-escape-guarded) and renders
with syntax highlighting, a rendered-vs-source markdown toggle, and
scroll-to-line. "Open in preferred editor" is already wired
(`editorPreferences.ts`, `useOpenInPreferredEditor`). This is the "properly
rendered markdown in a readable format" the owner has reached before but can't
summon on demand.

**The gap:** agents almost never emit markdown links — they write bare paths or
wrap them in single backticks (`` `.claude/docs/foo.md` ``). `ChatMarkdown` has
**no inline-`code` override and no bare-path autolinker** (only `p`, `li`,
`input`, `a`, `table`, `details`, `pre` are customized; remark plugins are
gfm/normalize/preserve-meta only), so those mentions render as inert text. The
fix feeds the existing chip → panel pipeline from two new entry points:

- **Inline code spans (the feature).** Add a `code` component override in
  `ChatMarkdown.tsx` that runs the span's text through
  `resolveMarkdownFileLinkMeta`; on a hit, render a `MarkdownFileLink` instead
  of a plain `<code>`. Cheap and bounded — code spans are already delimited AST
  nodes, so this only touches text the author explicitly backticked (a regex
  per span, nothing new scanned), and agents habitually backtick paths. Low
  false-positive risk. This alone covers the common case.
- **Bare paths in prose (speculative, must justify its cost).** A remark/text
  pass that autolinks path-like tokens (optional `:line[:col]` / `#L123`
  suffix, which the resolver already parses) is where the perf cost lives, and
  it's real: (1) chat messages re-parse on every streaming token delta, so a
  text-node visitor is O(text length) per tick across a live conversation, and
  (2) a path-_shaped_ token isn't a real file — validating it to avoid dead
  chips means a stat/`readFile` per candidate on the render path, exactly the
  kind of per-token fs/RPC work to keep off a hot render loop. Do NOT ship this
  by default. If attempted: match only high-confidence shapes (contains `/`,
  has a known extension), memoize resolver results by token string, and never
  block render on existence — render the chip optimistically and let the click
  fail soft, or resolve out-of-band and upgrade the node after. Likely not
  worth it once inline-code covers the habit; kept here so the tradeoff is on
  record, not rediscovered.

Scope note: resolution must stay workspace-relative to the thread's worktree
and reuse the existing path-escape guard — never widen `projects.readFile`.
Since both the in-app viewer and the "open in editor" action already hang off
`MarkdownFileLink`, wiring the inline-code trigger into that one component
delivers both surfaces the owner asked for at once.

## 10. Smaller candidates

- Usage meter: per-model breakdown when upstream adds more scoped limits;
  optional statusline-style compact mode.
- Custom `CLAUDE_CONFIG_DIR`/homePath support in the usage proxy
  (`claudeUsage.ts` documents the limitation), plus macOS keychain credentials.
- Notification history: a list of recent attention events, so a toast missed
  while the machine was locked is still discoverable in the app.
