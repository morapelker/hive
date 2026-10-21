// Session profiler (Settings › Advanced › "Session profiler", off by default):
// a header counter of the agent CLI processes (claude / codex) the app has
// alive, sampled from the OS with one `ps -A` per poll, plus the CPU of the
// whole Hive process tree. Main answers on demand only — no timer, no
// listener — so with the setting off nothing runs at all.

/** Why a live session process looks like it should not be alive any more. */
export type SessionProfilerIrrelevantReason =
  /** No hive session row for the process (deleted, or the DB was reset). */
  | 'no_session_row'
  /** The session row is `completed` / `error` but its process is still alive. */
  | 'session_completed'
  /** The session's worktree was archived. */
  | 'worktree_archived'
  /** The attached ticket is in Done or archived. */
  | 'ticket_done'
  /** The process is not in the app's PTY registry (leaked out of it). */
  | 'untracked'
  /** No terminal I/O for longer than the idle threshold. */
  | 'idle'

export type SessionProfilerAgentKind = 'claude' | 'codex' | 'opencode' | 'other'

export interface SessionProfilerTicket {
  id: string
  title: string
  /** Kanban column (todo / in_progress / review / merged / done …). */
  column: string
  archived: boolean
  projectId: string | null
}

export interface SessionProfilerSession {
  /** Hive session id (== the PTY id for CLI sessions); null if unknown. */
  sessionId: string | null
  /** Root pid of the session's process (the PTY child). */
  pid: number
  /** `ps` lstart of the root process — identifies the process across pid reuse. */
  startedAt: string
  agent: SessionProfilerAgentKind
  /** True when the PTY is in main's registry (the app still owns it). */
  tracked: boolean
  /** Session name / title from the DB. */
  name: string | null
  /** DB row status: 'active' | 'completed' | 'error', or null if no row. */
  dbStatus: string | null
  /** Last hook-driven live status (working / idle / permission / completed …), if known. */
  liveStatus: string | null
  /** Pending background work (sub-agents / background shells) reported by hooks. */
  backgroundWork: number
  /**
   * The turn ended but the agent will wake itself again: a Stop with a scheduled wakeup
   * (ScheduleWakeup / CronCreate / `/loop`) still pending, or an API-error auto-resume
   * waiting for the API to come back. Never flagged `idle`; stopping it loses the wakeup.
   */
  paused: boolean
  /**
   * The app stopped this session moments ago and these processes are still exiting (or
   * are being swept: tool shells / dev servers that ran in their own process group).
   * Such a row is not `tracked`, has no irrelevantReasons and needs no Stop.
   */
  stopping: boolean
  ticket: SessionProfilerTicket | null
  worktreeName: string | null
  worktreePath: string | null
  worktreeArchived: boolean
  projectName: string | null
  /** Process cwd as known to the app (PTY cwd). */
  cwd: string | null
  /** Number of processes in the session's subtree (root included). */
  processCount: number
  /** Resident memory of the whole subtree, bytes (sum — shared pages overcount). */
  rssBytes: number
  /** CPU of the subtree over the last sample window, % of one core (may exceed 100). */
  cpuPercent: number | null
  /** Cumulative CPU seconds of the subtree. */
  cpuSeconds: number
  /** Seconds since the process started. */
  elapsedSeconds: number
  /** Seconds since the last terminal I/O (PTY data in/out), null if unknown. */
  idleSeconds: number | null
  /** Non-empty when the session looks safe to clear; ordered most-significant first. */
  irrelevantReasons: SessionProfilerIrrelevantReason[]
}

export interface SessionProfilerTotals {
  /**
   * Every process in the Hive tree (main, helpers, server, agents, their children),
   * plus the agent sessions that leaked out of it (adopted by init) — so the agent figures
   * below are always a subset of these.
   */
  processCount: number
  /** CPU of the whole tree (see processCount), % of one core (may exceed 100), null on the first sample. */
  cpuPercent: number | null
  /** CPU of the agent session subtrees only, % of one core. */
  agentCpuPercent: number | null
  /** RSS sum of the whole tree (see processCount), bytes (overcounts shared pages). */
  rssBytes: number
  /** RSS sum of the agent session subtrees, bytes. */
  agentRssBytes: number
  /** Logical CPU count, to express cpuPercent as a share of the machine. */
  cpuCount: number
}

export interface SessionProfilerSnapshot {
  /** False on platforms the sampler does not support (win32) or without a desktop main. */
  supported: boolean
  /** Epoch ms of the sample. */
  sampledAt: number
  /** Length of the CPU window the percentages cover, ms (null on the first sample). */
  cpuWindowMs: number | null
  /** Idle threshold used for the 'idle' reason, seconds. */
  idleThresholdSeconds: number
  sessions: SessionProfilerSession[]
  totals: SessionProfilerTotals
  /** Error text if the sample failed (sessions/totals are then empty). */
  error?: string
}

export interface SessionProfilerKillRequest {
  /** Hive session id — tracked PTYs are torn down through the app's own path. */
  sessionId?: string | null
  /** Root pid, required for untracked processes. */
  pid?: number
  /** lstart from the snapshot; the kill is refused if the pid now belongs to another process. */
  startedAt?: string
}

export interface SessionProfilerKillResult {
  ok: boolean
  /** 'pty' = torn down via the PTY registry; 'signal' = signalled by pid. */
  method?: 'pty' | 'signal'
  error?: string
}
