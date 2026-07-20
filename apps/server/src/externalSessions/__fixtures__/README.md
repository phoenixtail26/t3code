# Claude Code session JSONL fixtures

Sanitized captures from Claude Code ~2026-07; structure real, content fake.

- `short-session.jsonl` — a minimal complete session: one user turn, one plain-text
  assistant reply, no tool calls. Shows the `mode` / `permission-mode` / `bridge-session`
  state records (present at both the start and end of a file), `file-history-snapshot`,
  `ai-title`, and `last-prompt`, in a finished/idle end state.
- `tool-use.jsonl` — a session that reads a file and runs a shell command. Shows
  `thinking` and `tool_use` content blocks, matching `tool_result` blocks in the
  following `user` record, and the two `toolUseResult` shapes seen in the wild (a
  `{filePath, content, numLines}` object for `Read` and a `{stdout, stderr, interrupted}`
  object for `Bash`).
- `title-records.jsonl` — shows both title mechanisms: the auto-generated `ai-title`
  record (written after the first turn) and a `custom-title` record (written when a
  user renames the session), both standalone lines keyed only by `sessionId`, not part
  of the `parentUuid`/`uuid` conversation chain.
- `sidechain-main.jsonl` + `sidechain-main/subagents/agent-fakeagent0001.jsonl` +
  `sidechain-main/subagents/agent-fakeagent0001.meta.json` — a session that spawns a
  subagent via the `Agent` tool. Mirrors the real on-disk layout: the main transcript
  has a normal `tool_use`/`tool_result` pair (the subagent's _final_ answer is inlined
  in the `tool_result`), while the subagent's full turn-by-turn transcript lives in a
  sibling `<session-uuid>/subagents/agent-<id>.jsonl` file with `isSidechain:true` and
  an `agentId` field on every record, plus an `agent-<id>.meta.json` sidecar
  (`agentType`, `description`, `toolUseId` linking back to the parent's `tool_use.id`,
  `spawnDepth`). Root record of the subagent file has `parentUuid:null`, same as a
  top-level session.
- `truncated-tail.jsonl` — a valid session whose final line was cut off mid-JSON-string
  (no trailing newline), simulating a crash/kill before a write was flushed. Every line
  up to the last parses; the last line throws on `JSON.parse`. Parsers must tolerate
  this without discarding the rest of the file.

All fixtures use fake UUIDs (freshly generated, internally consistent within each
file — `parentUuid` chains resolve, `sessionId` matches the filename concept, subagent
`toolUseId` matches the parent's `tool_use.id`), a fake `cwd` of `C:\fake\project`, a
fake model id (`claude-sonnet-5`), and placeholder prose/commands/output in place of
real content.
