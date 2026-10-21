import * as pty from 'node-pty'
import { execFile } from 'node:child_process'
import { createLogger } from './logger'

const log = createLogger({ component: 'PtyService' })

/**
 * Terminal backend type.
 * - 'node-pty': Uses node-pty + xterm.js for terminal emulation (cross-platform)
 * - 'ghostty': Uses the native Ghostty module for Metal-rendered terminals (macOS only)
 *
 * When using the 'ghostty' backend, the native module handles both the PTY and
 * the terminal rendering. The PtyService is not used for I/O in that case —
 * surface lifecycle is managed entirely through GhosttyService.
 */
export type TerminalBackend = 'node-pty' | 'ghostty'

interface PtyInstance {
  pty: pty.IPty
  cwd: string
  backend: TerminalBackend
  dataListeners: Array<(data: string) => void>
  exitListeners: Array<(code: number, signal: number) => void>
  /** Epoch ms of the spawn. */
  createdAt: number
  /** Epoch ms of the last output chunk from the child (createdAt until then). */
  lastOutputAt: number
  /** Epoch ms of the last input written to the child (createdAt until then). */
  lastInputAt: number
}

/** Read-only view of a live PTY, for diagnostics (session profiler). */
export interface PtyInstanceInfo {
  id: string
  /** Pid of the direct pty child (0 if node-pty did not report one). */
  pid: number
  cwd: string
  backend: TerminalBackend
  createdAt: number
  lastOutputAt: number
  lastInputAt: number
}

export interface PtyCreateOpts {
  cwd: string
  command?: string
  args?: string[]
  shell?: string
  env?: Record<string, string>
  cols?: number
  rows?: number
  backend?: TerminalBackend
}

/** Env vars that influence terminal/TUI rendering — logged at every spawn. */
const ENV_SNAPSHOT_KEYS = [
  'TERM',
  'COLORTERM',
  'LANG',
  'LC_ALL',
  'COLUMNS',
  'LINES',
  'NO_COLOR',
  'FORCE_COLOR',
  'CI'
] as const

/**
 * Diagnostic snapshot of the rendering-relevant spawn env. CLAUDE_CODE_*
 * variables are logged by name only — their values may embed secrets.
 */
function buildEnvSnapshot(env: Record<string, string>): Record<string, string | undefined> {
  const snapshot: Record<string, string | undefined> = {}
  for (const key of ENV_SNAPSHOT_KEYS) {
    snapshot[key] = env[key]
  }
  const claudeCodeKeys = Object.keys(env)
    .filter((key) => key.startsWith('CLAUDE_CODE_'))
    .sort()
  if (claudeCodeKeys.length > 0) {
    snapshot.claudeCodeKeys = claudeCodeKeys.join(',')
  }
  return snapshot
}

/** Grace period between the polite SIGHUP and the SIGKILL escalation probe. */
const KILL_ESCALATION_GRACE_MS = 1500

// Pids whose pty reported exit (child reaped — the numeric pid is reusable by
// the OS from that moment). The escalation probe must not signal such a pid
// directly: a probe hit would be a *different* process that inherited the
// number. Group probes stay valid — pgid reuse additionally requires the new
// owner to become a session/group leader. Entries are pruned after 60s.
const EXITED_PID_RETENTION_MS = 60_000
const exitedPtyPids = new Map<number, number>()

function recordPtyExit(pid: number | undefined): void {
  if (!pid) return
  const now = Date.now()
  exitedPtyPids.set(pid, now)
  for (const [oldPid, at] of exitedPtyPids) {
    if (now - at > EXITED_PID_RETENTION_MS) exitedPtyPids.delete(oldPid)
  }
}

class PtyService {
  private ptys: Map<string, PtyInstance> = new Map()

  create(id: string, opts: PtyCreateOpts): { cols: number; rows: number } {
    // If using the ghostty backend, the native module handles the PTY internally.
    // We don't create a node-pty process — surface lifecycle is managed by GhosttyService.
    if (opts.backend === 'ghostty') {
      log.info('Skipping node-pty creation for ghostty backend', { id })
      return { cols: opts.cols || 80, rows: opts.rows || 24 }
    }

    // If a PTY already exists for this id, return its dimensions
    const existing = this.ptys.get(id)
    if (existing) {
      log.info('PTY already exists, reusing', { id })
      return {
        cols: existing.pty.cols,
        rows: existing.pty.rows
      }
    }

    const command =
      opts.command ||
      opts.shell ||
      process.env.SHELL ||
      (process.platform === 'win32'
        ? 'powershell.exe'
        : process.platform === 'darwin'
          ? '/bin/zsh'
          : '/bin/bash')
    const args = opts.command ? (opts.args ?? []) : []
    const cols = opts.cols || 80
    const rows = opts.rows || 24

    const env: Record<string, string> = {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor'
    } as Record<string, string>
    // COLUMNS/LINES leak in from the interactive login shell that
    // loadShellEnv() captures at startup. TUI programs prefer them over the
    // PTY's actual size, pinning width detection to the wrong dimensions and
    // fighting SIGWINCH-driven resizes. The PTY size is authoritative here.
    delete env.COLUMNS
    delete env.LINES
    Object.assign(env, opts.env ?? {})

    log.info('Creating PTY', {
      id,
      command,
      args: args.length,
      cwd: opts.cwd,
      cols,
      rows,
      env: buildEnvSnapshot(env)
    })

    const ptyProcess = pty.spawn(command, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: opts.cwd,
      env
    })

    // A fresh child may have received a previously-exited pid — the ledger
    // entry belongs to the old process, not this one.
    if (ptyProcess.pid) exitedPtyPids.delete(ptyProcess.pid)

    const createdAt = Date.now()
    const instance: PtyInstance = {
      pty: ptyProcess,
      cwd: opts.cwd,
      backend: opts.backend || 'node-pty',
      dataListeners: [],
      exitListeners: [],
      createdAt,
      lastOutputAt: createdAt,
      lastInputAt: createdAt
    }

    // Wire up data events
    ptyProcess.onData((data) => {
      instance.lastOutputAt = Date.now()
      for (const listener of instance.dataListeners) {
        try {
          listener(data)
        } catch (err) {
          log.error(
            'Error in PTY data listener',
            err instanceof Error ? err : new Error(String(err)),
            { id }
          )
        }
      }
    })

    // Wire up exit events
    ptyProcess.onExit(({ exitCode, signal }) => {
      const code = exitCode ?? -1
      const sig = signal ?? 0
      log.info('PTY exited', { id, exitCode: code, signal: sig })
      recordPtyExit(ptyProcess.pid)
      for (const listener of instance.exitListeners) {
        try {
          listener(code, sig)
        } catch (err) {
          log.error(
            'Error in PTY exit listener',
            err instanceof Error ? err : new Error(String(err)),
            { id }
          )
        }
      }
      // Only forget the id if it still belongs to THIS pty: after destroy() the id can
      // be reused (a shell command's Run again), and a late exit of the old process
      // must not unregister the new one.
      if (this.ptys.get(id) === instance) this.ptys.delete(id)
    })

    this.ptys.set(id, instance)

    return { cols, rows }
  }

  write(id: string, data: string): void {
    const instance = this.ptys.get(id)
    if (!instance) {
      log.warn('PTY not found for write', { id })
      return
    }
    instance.lastInputAt = Date.now()
    instance.pty.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const instance = this.ptys.get(id)
    if (!instance) {
      log.warn('PTY not found for resize', { id })
      return
    }
    try {
      instance.pty.resize(cols, rows)
    } catch (err) {
      log.error('Error resizing PTY', err instanceof Error ? err : new Error(String(err)), {
        id,
        cols,
        rows
      })
    }
  }

  destroy(id: string): void {
    const instance = this.ptys.get(id)
    if (!instance) {
      log.warn('PTY not found for destroy', { id })
      return
    }
    log.info('Destroying PTY', { id })
    const pid = instance.pty.pid
    // Snapshot the process group around HUP time (pgrep runs concurrently
    // with the signal, so it observes the members that survive it) — the
    // escalation uses it to prove the group still belongs to this PTY
    // (see reapSurvivors).
    const groupSnapshot =
      pid && process.platform !== 'win32'
        ? this.listGroupMembers(pid)
        : Promise.resolve(new Set<number>())
    try {
      instance.pty.kill()
    } catch (err) {
      log.error('Error killing PTY', err instanceof Error ? err : new Error(String(err)), { id })
    }
    this.ptys.delete(id)
    this.scheduleKillEscalation(id, pid, groupSnapshot)
  }

  /** Pids currently in the given process group (empty when none or on error). */
  private listGroupMembers(pgid: number): Promise<Set<number>> {
    return new Promise((resolve) => {
      execFile('pgrep', ['-g', String(pgid)], { timeout: 2000 }, (err, stdout) => {
        if (err) return resolve(new Set())
        const pids = stdout
          .split('\n')
          .map((line) => Number(line.trim()))
          .filter((n) => Number.isInteger(n) && n > 0)
        resolve(new Set(pids))
      })
    })
  }

  /**
   * node-pty's kill() sends a single SIGHUP to the direct child and never
   * checks the outcome. HUP-ignoring processes — and custom-provider spawns,
   * where the agent is a grandchild of a `$SHELL -ilc` wrapper — survive it
   * and leak. After a grace period, probe liveness and escalate to a
   * process-group SIGKILL (the pty child is a session leader, so pgid ===
   * pid, which also reaps same-group grandchildren). The timer is unref'd
   * and fire-and-forget so destroyAll() under the quit-cleanup deadline
   * never blocks on it.
   */
  private scheduleKillEscalation(
    id: string,
    pid: number | undefined,
    groupSnapshot: Promise<Set<number>>
  ): void {
    if (!pid || process.platform === 'win32') return
    const timer = setTimeout(() => {
      void groupSnapshot.then((members) => this.reapSurvivors(id, pid, members))
    }, KILL_ESCALATION_GRACE_MS)
    timer.unref?.()
  }

  /**
   * Probe the direct child AND its process group before deciding everything
   * is dead: a wrapper shell can die on SIGHUP while a HUP-ignoring agent in
   * the same group survives — probing only the (reaped) wrapper pid would
   * skip the group SIGKILL that reaps the survivor. Known gap: a shell whose
   * interactive job control forked the agent into its OWN pgid is invisible
   * to both probes; covering that would require a descendant walk.
   */
  /** True when the pid belongs to a pty currently registered with this service. */
  private isCurrentPtyPid(pid: number): boolean {
    for (const instance of this.ptys.values()) {
      if (instance.pty.pid === pid) return true
    }
    return false
  }

  private async reapSurvivors(id: string, pid: number, groupSnapshot: Set<number>): Promise<void> {
    // The pid may have been recycled into a CURRENTLY REGISTERED pty (a new
    // spawn between the destroy and this escalation firing) — that process
    // is alive on purpose; a stale timer must never touch it.
    if (this.isCurrentPtyPid(pid)) return
    // Once the pty reported exit, the numeric pid may already belong to an
    // unrelated process — never probe or signal it directly; only the group
    // remains a valid target (surviving wrapper-shell grandchildren).
    // Entries expire at read time too: pruning on insert alone could leave a
    // stale record vetoing a later PTY that legitimately reused the pid.
    const exitedAt = exitedPtyPids.get(pid)
    if (exitedAt !== undefined && Date.now() - exitedAt > EXITED_PID_RETENTION_MS) {
      exitedPtyPids.delete(pid)
    }
    const directPidValid = !exitedPtyPids.has(pid)
    let leaderAlive = false
    if (directPidValid) {
      try {
        process.kill(pid, 0)
        leaderAlive = true
      } catch {
        // direct child dead and reaped
      }
    }
    let groupAlive = false
    try {
      process.kill(-pid, 0)
      groupAlive = true
    } catch {
      // process group empty
    }
    if (!leaderAlive && !groupAlive) return
    if (!leaderAlive && groupAlive) {
      // The leader is gone, so the numeric pgid could in principle have been
      // recycled by an unrelated new group leader. The destroy-time snapshot
      // (taken concurrently with the HUP, so it observes the HUP survivors)
      // lets us check continuity: the kernel keeps a pgid reserved while any
      // original member lives, so overlap with a current member proves the
      // group is still ours. With an EMPTY snapshot (pgrep produced no
      // evidence) the default depends on what we know about the leader:
      // - leader provably exited: an alive group with zero traced members is
      //   more likely a recycled pgid than an untracked survivor — skip.
      // - leader never reported exit: our processes are likely still there
      //   and pgrep merely failed — fail open toward killing, because
      //   disabling the escalation is the leak this change exists to fix.
      if (groupSnapshot.size > 0) {
        const current = await this.listGroupMembers(pid)
        const stillOurs = [...current].some(
          (member) => member !== pid && groupSnapshot.has(member)
        )
        if (!stillOurs) {
          log.warn('Skipping group SIGKILL — group no longer traceable to the destroyed PTY', {
            id,
            pid
          })
          return
        }
      } else if (!directPidValid) {
        log.warn('Skipping group SIGKILL — exited leader and no membership evidence', { id, pid })
        return
      }
    }
    log.warn('PTY process (or group member) survived SIGHUP, escalating to SIGKILL', { id, pid })
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      if (leaderAlive) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // Died between the probe and the kill — nothing left to do
        }
      }
    }
  }

  destroyAll(): void {
    log.info('Destroying all PTYs', { count: this.ptys.size })
    for (const [id] of this.ptys) {
      this.destroy(id)
    }
  }

  /**
   * Quit-path variant of destroyAll: HUP everything, wait a short bounded
   * grace (well inside the quit-cleanup deadline), then synchronously
   * group-SIGKILL anything still alive. The per-destroy escalation timers
   * never get to fire on quit — the process exits first — so without this
   * sweep HUP-surviving agents would leak on every app quit.
   */
  async destroyAllAndReap(graceMs = 300): Promise<void> {
    const targets: Array<{ id: string; pid: number; snapshot: Promise<Set<number>> }> = []
    if (process.platform !== 'win32') {
      for (const [id, instance] of this.ptys) {
        const pid = instance.pty.pid
        if (pid) targets.push({ id, pid, snapshot: this.listGroupMembers(pid) })
      }
    }
    this.destroyAll()
    if (targets.length === 0) return
    await new Promise((resolve) => setTimeout(resolve, graceMs))
    for (const { id, pid, snapshot } of targets) {
      await this.reapSurvivors(id, pid, await snapshot)
    }
  }

  onData(id: string, callback: (data: string) => void): () => void {
    const instance = this.ptys.get(id)
    if (!instance) {
      log.warn('PTY not found for onData', { id })
      return () => {}
    }
    instance.dataListeners.push(callback)
    return () => {
      const idx = instance.dataListeners.indexOf(callback)
      if (idx !== -1) {
        instance.dataListeners.splice(idx, 1)
      }
    }
  }

  onExit(id: string, callback: (code: number, signal: number) => void): () => void {
    const instance = this.ptys.get(id)
    if (!instance) {
      log.warn('PTY not found for onExit', { id })
      return () => {}
    }
    instance.exitListeners.push(callback)
    return () => {
      const idx = instance.exitListeners.indexOf(callback)
      if (idx !== -1) {
        instance.exitListeners.splice(idx, 1)
      }
    }
  }

  /**
   * Get an existing PTY or create a new one. Alias for `create()` which
   * already returns existing PTY dimensions if one exists for this id.
   */
  getOrCreate(id: string, opts: PtyCreateOpts): { cols: number; rows: number } {
    return this.create(id, opts)
  }

  has(id: string): boolean {
    return this.ptys.has(id)
  }

  getBackend(id: string): TerminalBackend | undefined {
    return this.ptys.get(id)?.backend
  }

  getIds(): string[] {
    return Array.from(this.ptys.keys())
  }

  /** Snapshot of every live PTY (pid, cwd, activity timestamps). */
  listInstances(): PtyInstanceInfo[] {
    const out: PtyInstanceInfo[] = []
    for (const [id, instance] of this.ptys) {
      out.push({
        id,
        pid: instance.pty.pid ?? 0,
        cwd: instance.cwd,
        backend: instance.backend,
        createdAt: instance.createdAt,
        lastOutputAt: instance.lastOutputAt,
        lastInputAt: instance.lastInputAt
      })
    }
    return out
  }

  /**
   * Destroy all PTYs whose IDs are NOT in the given set of valid IDs.
   * Useful for cleaning up terminals when worktrees are deleted.
   */
  getCount(): number {
    return this.ptys.size
  }

  destroyExcept(validIds: Set<string>): void {
    for (const [id] of this.ptys) {
      if (!validIds.has(id)) {
        log.info('Destroying orphaned PTY', { id })
        this.destroy(id)
      }
    }
  }
}

export const ptyService = new PtyService()
