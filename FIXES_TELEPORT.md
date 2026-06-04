# Teleport Session — Fix Plan

This document is the fixes spec for the 8 issues found in the code review of the
`teleport-session` branch (vs `origin/ipc-to-http-2`). It covers all 8 findings
(4 critical + 4 medium/low), each with root cause, concrete fix, files to touch,
and test coverage.

## Context

The review surfaced 8 issues in the new "teleport a stopped Claude Code CLI
session to a remote headless Hive" feature. Two are silent-data-loss /
unreachable-feature bugs, two are hard-to-debug hangs / wrong-state bugs, and
four are robustness/edge-case cleanups. This plan fixes all of them and extends
the existing vitest suites to lock in the corrected behavior.

Primary files:
- `src/server/rpc/domains/teleport-ops.ts` (fixes 1b, 2, 3, 5, 8)
- `src/renderer/src/components/sessions/SessionTabs.tsx` (fix 1a)
- `src/main/services/teleport-remote-client.ts` (fixes 4, 6, 7)
- `src/main/services/claude-hook-server.ts` (fix 1b helper export)
- Tests: `src/server/rpc/domains/__tests__/teleport-ops.test.ts`, `src/main/services/teleport-remote-client.test.ts` (new)

---

## [x] Fix 1 — Teleport gating uses the wrong "status" (Critical)

**Root cause:** Both the UI and backend gate on the DB column `sessions.status`
(`'active' | 'completed' | 'error'`), which stays `'active'` for a CLI session's
entire *open* life (set to `'completed'` only on tab close — `useSessionStore.ts:632`/`:1822`).
The live "running vs idle" signal is `SessionStatusType`
(`'working' | 'planning' | 'answering' | …`) published via `publishClaudeCliStatus`
(`claude-hook-server.ts:148`), which never writes the DB column. Note: the PTY
stays alive while a CLI session is idle, so `ptyService.has()` is **not** a
correct "is busy" signal — the live status is.

### [x] 1a. Renderer (`SessionTabs.tsx:1315`)
`SessionTab` already computes the correct busy signal and already disables the
menu item with it:
```ts
const sessionStatus = useWorktreeStatusStore((s) => s.sessionStatuses[sessionId]?.status ?? null)  // :159
const isSessionBusy = sessionStatus === 'working' || sessionStatus === 'planning'                   // :162
...
<ContextMenuItem disabled={isSessionBusy} onSelect={() => onTeleport?.()}>                          // existing
```
So the only change is to stop gating *visibility* on the broken DB status — show
the item for all CLI sessions and let the existing `disabled={isSessionBusy}`
guard the running case:
```ts
// before
canTeleport={session.agent_sdk === 'claude-code-cli' && session.status !== 'active'}
// after
canTeleport={session.agent_sdk === 'claude-code-cli'}
```

### [x] 1b. Backend (`teleport-ops.ts:178`)
Replace the DB-status check with the same live-status concept, injected through
`TeleportDeps` (keeps the domain testable, mirrors existing dep-injection style):
- Add `getLastClaudeCliStatus(sessionId: string): SessionStatusType | undefined`
  to `claude-hook-server.ts`, returning `lastStatusBySession.get(sessionId)` (the
  map already exists at `:149`).
- Add `isSessionBusy: (sessionId: string) => boolean` to the `TeleportDb`/deps
  interface; implement in `createLiveDeps` as
  `const s = getLastClaudeCliStatus(id); return s === 'working' || s === 'planning'`.
- In `startTeleport` validate step, replace:
  ```ts
  if (session.status === 'active') throw new Error('Stop the Claude Code CLI session before teleporting it')
  ```
  with:
  ```ts
  if (deps.isSessionBusy(session.id)) throw new Error('Stop the Claude Code CLI session before teleporting it')
  ```
- Keep the busy definition (`working|planning`) identical to the renderer; add a
  short comment cross-referencing so they stay in sync.

**[x] Tests:** in `teleport-ops.test.ts`, add `isSessionBusy` to the mock deps; assert
`start` rejects at step `validate` when busy and proceeds when idle.

---

## [x] Fix 2 — `provision([project.id])` deletes every other project's Discord channels (Critical)

**Root cause:** `computeDeleteCandidates` (`discord-service.ts:1356`) marks any
resource whose `project_id` ∉ the passed set as a delete candidate, and
`provision` overwrites `selectedProjectIds` with the passed set (`:447`). Every
other caller passes `[...config.selectedProjectIds, projectId]` (`:778`, `:821`).

**Fix:** in `receiveTeleport` (`teleport-ops.ts:302`), merge with the existing
selection (the config is already fetched at the top of the function):
```ts
const config = deps.discord.getConfig()                 // already present, used by isDiscordConfigured
...
await deps.discord.provision([...config.selectedProjectIds, project.id])
```
(`config` is non-null past the `isDiscordConfigured` guard.)

**[x] Tests:** extend the "writes transcript…" test to assert `provision` is called
with the merged array including a pre-existing selected id (seed
`getConfig().selectedProjectIds = ['other-project']`, expect `['other-project','project-1']`).

---

## [x] Fix 3 — Remote worktree created at stale commit instead of pushed `headSha` (Critical)

**Root cause:** `git fetch origin` updates `refs/remotes/origin/*`, not local
`refs/heads/*`. In `ensureTeleportWorktree` (`teleport-ops.ts:411-419`) the
`git branch -f targetBranch headSha` is skipped when `branch` exists locally but
isn't checked out, so `worktree add` checks out the stale local ref.

**Fix:** always force the target branch to the exact `headSha` before adding the
worktree. This is safe for both cases (`targetBranch` is either `teleport/<sha>` —
never checked out — or `branch` — only used when not checked out):
```ts
const short = headSha.slice(0, 8)
const checkedOut = await isBranchCheckedOut(project.path, branch)
const targetBranch = checkedOut ? `teleport/${short}` : branch
await execGit(project.path, ['branch', '-f', targetBranch, headSha])   // unconditional
const worktreePath = uniquePath(/* … */)
await execGit(project.path, ['worktree', 'add', worktreePath, targetBranch])
```
Remove the now-dead `branchExists` helper (and its only call) if nothing else
references it.

**[x] Tests:** introduced a thin exported seam `resolveTeleportTargetBranch` and
added `teleport-worktree-branch.test.ts` — a real-git integration test proving a
stale local branch is force-moved to the pushed `headSha`, plus the
checked-out → `teleport/<sha>` path.

---

## [x] Fix 4 — `requestRemote` hangs forever / crashes on bad frame (Critical)

**Root cause** (`teleport-remote-client.ts:110-130`): no timeout; `close` handler
is a no-op (clean close before a matching message never settles the promise);
`JSON.parse(String(data))` throws inside the listener → unhandled, promise stays
pending and socket leaks.

**Fix:** add a settle-once guard, a timeout, reject-on-close, and a try/catch
around the parse. There is no existing WS-client pattern in the repo to reuse, so
implement directly:
```ts
return new Promise<T>((resolve, reject) => {
  let settled = false
  const finish = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); try { socket.close() } catch {}; fn() }
  const timer = setTimeout(() => finish(() => reject(new Error('Remote Hive RPC timed out'))), 30_000)
  const socket = new WebSocket(url)
  socket.on('open', () => socket.send(JSON.stringify({ id, method, params })))
  socket.on('message', (data) => {
    let response: RpcResponse<T>
    try { response = JSON.parse(String(data)) as RpcResponse<T> } catch { return }  // ignore non-JSON frames
    if (response.id !== id) return
    if (response.ok) finish(() => resolve(response.value as T))
    else finish(() => {
      const error = new Error(response.error?.message ?? 'Remote Hive RPC failed') as Error & { details?: unknown }
      error.name = response.error?.code ?? 'RemoteHiveRpcError'
      error.details = response.error?.details
      reject(error)
    })
  })
  socket.on('error', (error) => finish(() => reject(error)))
  socket.on('close', () => finish(() => reject(new Error('Remote Hive connection closed before responding'))))
})
```
Declare `timer`/`socket` ordering so the closure is valid (define `socket` first,
then `timer`, or hoist via `let`).

**[x] Tests:** new `src/main/services/teleport-remote-client.test.ts` using a real `ws`
server (the package is already a dep): assert (a) resolve on matching response,
(b) reject on server close without reply, (c) non-JSON frame is ignored and a
later valid frame resolves, (d) timeout rejects. Token issuance (`fetch`) can be
stubbed with `vi.stubGlobal('fetch', …)`.

---

## [x] Fix 5 — `receiveTeleport` has no rollback / isn't idempotent (Medium)

**Root cause:** worktree + transcript + session rows are persisted before
`provision`; a failure leaves orphans, and a retry creates duplicates
(`teleport-ops.ts:288-307`). There is no DB query by branch+sha; lookup is via
`getWorktreesByProject` filtered in memory.

**Fix (pragmatic, two parts):**
1. **Idempotency:** before `ensureTeleportWorktree`, check for an existing
   teleport worktree for this branch and reuse it: scan
   `db.getWorktreesByProject(project.id)` for a `branch_name` matching `branch`
   (or `teleport/<short>`) whose `teleported`/head matches; if found, reuse its
   row + path instead of creating a second worktree/session. Keep this
   best-effort — match on `branch_name` is sufficient to avoid duplicate
   worktrees on retry.
2. **Cleanup on failure:** wrap the steps after `createSession` in try/catch; on
   failure, best-effort delete the just-created session row (add a `deleteSession`
   to deps if not present, or reuse existing delete) so a failed provision
   doesn't leave a dangling managed session. Re-throw the original error so
   `startTeleport` still reports `step: 'remote-receive'`.

**[x] Tests:** add a test where `provision` rejects and assert the created session is
cleaned up (mock `deleteSession` called) and the error propagates; add a test
where a matching worktree already exists and assert no second worktree/session is
created.

---

## [x] Fix 6 — WebSocket URL discards configured subpath (Medium)

**Root cause** (`teleport-remote-client.ts:68`): `wsUrl.pathname = '/ws'`
overwrites any base subpath, while the HTTP base preserves it.

**Fix:** append `/ws` to the normalized base pathname instead of replacing:
```ts
const wsUrl = new URL(httpBaseUrl)
wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:'
wsUrl.pathname = `${wsUrl.pathname.replace(/\/+$/, '')}/ws`
```
For a root URL `pathname` is `''` → result `/ws` (unchanged behavior); for
`/teleport` → `/teleport/ws`.

**[x] Tests:** unit-test `targetFromSettings` (export it or test via a thin wrapper)
for root and subpath inputs → assert `wsBaseUrl`.

---

## [x] Fix 7 — `parseTeleportSettings` JSON.parse is unguarded (Low)

**Root cause** (`teleport-remote-client.ts:45`): corrupted settings throw an
opaque `SyntaxError` instead of the friendly "not configured" message.

**Fix:** wrap the parse:
```ts
let parsed: { teleport?: Partial<TeleportSettings> | null }
try { parsed = JSON.parse(raw) } catch { throw new Error('Teleport remote is not configured') }
```

**[x] Tests:** unit test `parseTeleportSettings` (export for test) with malformed JSON
→ throws the friendly error; with valid `{teleport:{url,bootstrapToken}}` →
returns trimmed values.

---

## [x] Fix 8 — `slug()` can return empty string (Low)

**Root cause** (`teleport-ops.ts`): a separator-only branch (`---`, `.`) slugs to
`''`, producing a degenerate `${basename}-` worktree path that distinct such
branches collide on.

**Fix:** fall back to a stable default when empty:
```ts
const s = value.toLowerCase()./* … existing … */slice(0, 64)
return s || 'teleport'
```
(`uniquePath` still de-dups, so two empty-slug branches get `-2`, `-3` suffixes.)

**[x] Tests:** add a unit test for `slug('---') === 'teleport'` (export `slug` for test).

---

## Verification

1. **Typecheck/build baseline:** run `pnpm run build:web && pnpm run build:server`;
   confirm no new errors vs baseline (`tsc --noEmit` has ~32 pre-existing errors —
   diff, don't count).
2. **Unit tests:** `pnpm vitest run src/server/rpc/domains/__tests__/teleport-ops.test.ts src/main/services/teleport-remote-client.test.ts src/main/db/teleport-annotation.test.ts`
   — all green, including the new cases (busy gating, merged provision, WS
   timeout/close/bad-frame, parse guard, slug, idempotency/cleanup).
3. **End-to-end (manual, drive the web UI via Playwright + CDP against the
   test-python project):**
   - Configure a local headless remote (Docker image from this branch) in
     Settings → Teleport; click **Test** → expect success.
   - Start a Claude Code CLI session, let it go idle → right-click the tab:
     **Teleport session** is now visible (Fix 1a) and enabled; while it's actively
     working it is disabled.
   - Teleport → expect success toast + "Open Discord"; the worktree shows the
     **Teleported** badge.
   - On the remote, confirm the worktree is at the pushed HEAD sha (Fix 3) and
     that a *second* project's Discord channels still exist after teleporting a
     different project (Fix 2).
   - Point the remote URL at a dead port and teleport → expect a timeout error
     within ~30s, not an indefinite spinner (Fix 4).
