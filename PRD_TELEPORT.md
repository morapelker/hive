# PRD: Codex Session Teleport (laptop → VM)

## 1. Context & Motivation

Today a Hive session runs on the machine where it was started. When you leave your desk
and close your laptop, the session stops. The goal of **Teleport** is to move a
**running codex session** — with its full history, skills, MCP servers, code, and
uncommitted changes — onto an always-on VM that also runs Hive, and resume it there, so
you can close the laptop and the work keeps going.

This PRD covers **only the teleport mechanism**: package a codex session and all of its
dependencies, ship it to the VM, and resume it. The remote-viewing layer (an HTTP server
/ streamed UI to *watch* the VM session from the laptop) is **explicitly out of scope**
for this iteration and will be specified separately.

Hive has **no remote/SSH/export infrastructure** today (the `connection_id` field is
unrelated — it's worktree symlink-linking). Teleport is net-new, but it leans on existing
primitives: codex thread resume, the `CODEX_HOME` env lever, the git diff/patch/worktree
services, the SQLite `DatabaseService`, and the IPC handler pattern.

## 2. Scope & Decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | After teleport, the local copy | **Handoff** — stop + mark local; VM becomes source of truth (not a clone) |
| 2 | VM prerequisites | **Pre-provisioned**: runs Hive, has `codex` on PATH, already authenticated (`~/.codex/auth.json`). No credential transfer, no bootstrap |
| 3 | Transport for session data | **Direct SSH/rsync** from laptop Hive to VM |
| 4 | Code transfer | **Git** — push branch to a shared remote + ship an uncommitted-changes patch |
| 5 | Agent backend | **Codex only** for this iteration |

**Non-goals (this iteration):** HTTP/remote-viewing UI; non-codex agents
(claude-code/opencode); bidirectional sync; teleporting a *busy* (mid-turn) session
without first aborting.

## 3. What constitutes a codex session (the payload)

- **Hive DB rows** (`src/main/db/schema.ts`): `sessions` (codex thread id is stored in
  `opencode_session_id`, with `agent_sdk='codex'`, `mode`, `model_*`), its parent
  `worktrees` and `projects` rows, and the regenerable `session_activities` /
  `session_messages`.
- **Codex thread state** under `CODEX_HOME` (default `~/.codex`): the **rollout JSONL**
  (the transcript/history). Its path comes from the `thread/read` RPC `thread.path` field
  (see `hydrateTokenUsageFromThread`, `codex-implementer.ts:1838`). Codex's
  state-db→rollout mapping is **benign/recoverable** if missing — codex scans subdirs to
  locate the rollout (`BENIGN_ERROR_LOG_SNIPPETS` / `RECOVERABLE_THREAD_RESUME_ERROR_SNIPPETS`,
  `codex-app-server-manager.ts:206`). Dropping just the JSONL into the VM's
  `CODEX_HOME/sessions` tree is therefore sufficient for resume.
- **Codex MCP + skills** (codex-owned, not Hive-managed): MCP servers in
  `~/.codex/config.toml` `[mcp_servers.*]`; **user-scope** skills under `~/.codex/skills`;
  **repo-scope** skills + `AGENTS.md` live inside the worktree (travel via git). Scopes per
  `src/shared/codex-schemas/v2/SkillScope.ts` = `user|repo|system|admin`.
- **Code**: the git branch (push to shared remote) + uncommitted diff + untracked files.

## 4. Architecture

A staged orchestrator on the laptop builds a **session bundle**, ships it over SSH,
triggers an import on the VM, and **only on confirmed success** stops + marks the local
session. Nothing local is mutated until the VM reports success (clean rollback on failure).

### 4.1 New modules (follow existing patterns; keep minimal)

New service dir `src/main/services/teleport/`:
- `session-bundle.ts` — `buildSessionBundle(hiveSessionId)`: serialize DB rows + collect codex artifacts + git patch into a temp dir with a versioned `manifest.json`.
- `ssh-transport.ts` — `SshTransport { mkdirRemote, pushDir, runRemote }`: shell out to system `ssh`/`rsync` via the existing `LowLevelSpawn` facade (`codex-app-server-manager.ts:459`). **No new npm dependency.**
- `session-import.ts` — `importSessionBundle(bundleDir)`: VM-side reconstruction + resume.
- `teleport-orchestrator.ts` — `teleportSession(hiveSessionId, remoteId)`: idle-check → build → git push → rsync → trigger remote import → on success disconnect+mark local → on failure roll back. Also `teleport.remotes` CRUD.

New IPC `src/main/ipc/teleport-handlers.ts` (export `registerTeleportHandlers`, register in `src/main/ipc/index.ts`, follow the `defineHandler` style in `opencode-handlers.ts:68`):
- `teleport:listRemotes` / `teleport:saveRemote` / `teleport:deleteRemote`
- `teleport:start (hiveSessionId, remoteId)`
- `teleport:importBundle (bundleDir)` — the channel the VM's Hive invokes.

Small reused-code additions:
- `CodexImplementer.getThreadRolloutPath(threadId)` — factor out the `thread/read` → `thread.path` extraction (`codex-implementer.ts:1841`). Reuse existing `disconnect()` (`:660`) and `reconnect()` (`:577`).
- `GitService.getUncommittedPatch()` + `applyPatch(patch)` — thin wrappers over the Effect git layer (`src/main/effect/git/layers.ts`): `git diff HEAD --binary` for tracked changes, the `git stash create` + `git ls-files --others --exclude-standard` recipe already used by duplicate-worktree (`layers.ts:337`), and `applyPatchString` (`layers.ts:259`).

### 4.2 Bundle layout + manifest

```
manifest.json
db/{session,worktree,project,activities}.json
codex/rollout.jsonl                 # the thread transcript
codex/skills/...                    # user-scope skills (copy-if-absent on VM)
codex/mcp_servers.toml              # extracted [mcp_servers.*] subset of config.toml
git/uncommitted.patch               # staged+unstaged tracked (git diff HEAD --binary)
git/untracked/<files>               # untracked, non-ignored, copied verbatim
```

`manifest.json` carries: `bundleVersion`, `agentSdk:'codex'`, `threadId`,
`codexCliVersion` (`codex --version`), `source.{worktreePath,projectPath,host,codexHome}`,
`git.{branch,baseBranch,headSha,remoteUrl,hasUncommitted,untrackedFiles[]}`,
`model.{providerId,modelId,variant}`, `rolloutFilename` (preserve original basename).

### 4.3 Flow

**Laptop — export + send**
1. Reject unless the session is idle (`CodexSessionState.status !== 'running'`); otherwise prompt "abort then teleport".
2. `buildSessionBundle`: read rows via `DatabaseService.getSession/getWorktree/getProject/getSessionActivities`; copy the rollout JSONL via `getThreadRolloutPath`; extract `[mcp_servers]` + copy user skills from `CODEX_HOME`; build the git patch + untracked copies.
3. Git: `getRemoteUrl('origin')` (fail fast if no shared remote) → `GitService.push('origin', branch)`.
4. `SshTransport`: `rsync` the bundle dir to `<hiveDataDir>/teleport-inbox/<sessionId>/` on the VM (`rsync -e "ssh -i <key> -p <port>"`).
5. `runRemote` triggers the VM import and waits for its exit code/result.

**VM — import + resume (`importSessionBundle`)**
1. Project: `getProject` by path; if missing `createProject` from `project.json` (path becomes VM-local).
2. Worktree: `git fetch origin`, then reuse `createWorktreeFromBranch` (`git-service.ts:369` / `createWorktreeOp`) so it lands under the VM worktrees root with a proper `worktrees` row; then `applyPatch` (retry `git apply --3way` on conflict) and copy untracked files in.
3. Session row: `createSession({ worktree_id, project_id, agent_sdk:'codex', opencode_session_id:threadId, mode, model_* })`.
4. Codex artifacts: copy `rollout.jsonl` into `<codexHome>/sessions/` (preserve original date-sharded subpath if present; subdir-scan fallback finds it regardless); **merge-if-absent** the `[mcp_servers]` into the VM `config.toml` and user skills into `<codexHome>/skills` (never clobber).
5. Resume: `CodexImplementer.reconnect(vmWorktreePath, threadId, hiveSessionId)` → drives `thread/resume` and auto-runs `hydrateTokenUsageFromThread` (context bar repopulates). Return `{hiveSessionId, threadId}`.

**VM trigger mechanism:** prefer triggering the *already-running* VM Hive (so resume happens
in the live process) — e.g. `ssh` invokes a thin `hive teleport-import <dir>` that IPCs into
the running instance via `teleport:importBundle`. Fallback: an Electron `--teleport-import <dir>`
flag handled in `src/main/index.ts` that imports then exits.

**Laptop — handoff (only after VM success)**
1. `CodexImplementer.disconnect(worktreePath, threadId)` (`:660`) — kills the local `app-server`, flushes persistence.
2. `db.updateSession(hiveSessionId, { status:'teleported', teleport_state:'sent', teleport_remote:<remoteId>, completed_at:now })`.

### 4.4 Schema migration 28 (`src/main/db/schema.ts`, bump `CURRENT_SCHEMA_VERSION`→28)

```sql
ALTER TABLE sessions ADD COLUMN teleport_state TEXT DEFAULT NULL;   -- 'sent' | 'received'
ALTER TABLE sessions ADD COLUMN teleport_remote TEXT DEFAULT NULL;  -- remote id (sent) / source host (received)
```

`status='teleported'` needs no schema change (free-text). Renderer should render teleported
sessions read-only / non-resumable locally (light UI follow-up). Remote configs
(`{id,label,host,user,port,identityFile,hiveDataDir,codexHome}`) stored in the `settings`
table under key `teleport.remotes` (read/write via `db.getSetting/setSetting`, like `env-vars.ts:7`).

### 4.5 Path-rewriting policy (central risk)
- `worktrees.path` / `projects.path` get fresh VM-absolute values at insert (handled).
- The thread id is path-independent; `thread/resume` receives the **VM** worktree `cwd`, so new turns run in the right place.
- **Do not** rewrite paths inside the rollout JSONL (corruption risk > cosmetic gain); historical tool outputs keep laptop paths — cosmetic only. Optionally string-replace `sourceWorktreePath→vmWorktreePath` in re-inserted `session_activities.payload_json`.

## 5. Critical files
- `src/main/services/codex-implementer.ts` — `reconnect` (:577), `disconnect` (:660), rollout path (:1838); add `getThreadRolloutPath`.
- `src/main/services/codex-app-server-manager.ts` — `startSession`/`thread/resume` (:430), `CODEX_HOME` lever (:130,:465), recoverable-error snippets (:206).
- `src/main/services/codex-cli-env.ts` — `getCodexCliEnv({codexHomePath})`.
- `src/main/effect/git/layers.ts` — `applyPatchString` (:259), uncommitted/untracked recipe (:337), diff helpers; surfaced via `git-service.ts` (`push`/`getRemoteUrl`/`createWorktreeFromBranch`).
- `src/main/db/database.ts` — `getSession/getWorktree/getProject/getSessionActivities`, `createProject/createSession/updateSession`, `getSetting/setSetting`.
- `src/main/db/schema.ts` — migration 28.
- `src/main/ipc/index.ts` + new `src/main/ipc/teleport-handlers.ts`.
- New `src/main/services/teleport/{session-bundle,ssh-transport,session-import,teleport-orchestrator}.ts`.

## 6. Edge cases & risks
- **Busy session**: only teleport when idle; reject + offer abort otherwise.
- **CLI version skew**: record `codexCliVersion`; warn (don't block) on mismatch — subdir-scan fallback is robust.
- **No shared remote**: detect via `getRemoteUrl` and fail before transferring anything.
- **Patch conflicts**: `git apply` → retry `--3way` → hard fail triggers VM rollback.
- **MCP referencing local-only paths**: merge-if-absent; report which servers were skipped/may be broken; no auto-rewrite.
- **Large/untracked**: rely on `--exclude-standard` (skips `node_modules` etc.); warn above an untracked-count threshold.
- **Idempotency / rollback**: key VM import on `threadId` (re-run re-points the row); on import failure remove created worktree (`deleteWorktreeOp`) + session (`deleteSession`); laptop session stays untouched until VM success.

## 7. Verification (single machine simulating laptop + VM)
Run two data dirs + two CODEX_HOMEs, loopback SSH, and a bare repo as the shared remote:
- **Laptop sim**: `HIVE_DATA_DIR=~/.hive-laptop`, `CODEX_HOME=~/.codex-laptop`. Start a codex session, run 2+ turns (so the rollout has `token_count` + tool calls), make committed + staged + unstaged + untracked changes.
- **VM sim**: `HIVE_DATA_DIR=~/.hive-vm`, `CODEX_HOME=~/.codex-vm`, remote = `localhost`, separate worktrees root.
- Run `teleport:start`, then assert:
  1. branch + HEAD in the bare remote and checked out on the VM worktree;
  2. VM `git status` matches laptop (tracked diff + untracked identical);
  3. VM `sessions` row has same `opencode_session_id`, `agent_sdk='codex'`, model fields;
  4. `reconnect` succeeds → `thread/read` returns full history;
  5. context bar shows non-zero usage (token hydration);
  6. `skills/list` + an MCP tool call resolve on the VM;
  7. a new turn on the VM edits land in the VM worktree;
  8. laptop session is `status='teleported'`, its `app-server` gone, non-resumable locally.
- **Failure injection**: kill the bare remote mid-push (laptop untouched); corrupt the patch (`--3way` retry → clean VM rollback).

## 8. Open questions / future work
- Remote-viewing UI (HTTP/streaming) — separate PRD.
- Reverse teleport (VM → laptop) and multi-hop handoffs.
- Non-codex agents (claude-code/opencode) — different transcript/state stores.
- Auth/credential transfer + bare-VM bootstrap (deferred by decision #2).
