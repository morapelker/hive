// What is running, read once and then asked about one project at a time (`BusyProbe`).
//
// A project is only moved while nothing is working in its folder: a session that writes there
// while the folder goes from one path to another loses its place or its work. Every source is
// handed in, so the rule can be tested without the app; `live-deps.ts` binds the real ones.
//
// Each answer is a sentence for the person who pressed "Move projects": what is running, and
// what to do about it. "Check again" is the button in that dialog. A check that could not be
// made counts as running and says so, with one exception that is decided on purpose: a plain
// terminal whose state cannot be read does not hold a project back (see `terminals`).
//
// A move to another disk is stricter than a rename (`BusyProbeOptions.copies`): the old folder
// is removed, so a terminal that only sits in it holds the project back as well.
import { execFile } from 'node:child_process'
import type { ConnectionMember, ConnectionWithMembers, Project, Session } from '../../db/types'
import type { DocumentRun } from '../../../shared/types/document-flow'
import type {
  SessionProfilerSession,
  SessionProfilerSnapshot
} from '../../../shared/types/session-profiler'
import { isSameOrAncestorPath } from '../path-utils'
import type { BusyProbe } from './types'

export type BusySession = Pick<Session, 'project_id' | 'connection_id' | 'name'>

export type BusyConnection = Pick<ConnectionWithMembers, 'saved_project_id'> & {
  readonly members: readonly Pick<ConnectionMember, 'project_id'>[]
}

export type BusyProject = Pick<Project, 'member_project_ids'>

export type BusyDocumentRun = Pick<DocumentRun, 'project_id' | 'title' | 'status' | 'members'>

/**
 * `tracked` is false for an agent process that outlived the terminal it was started in: the
 * app still finds it, but no tab leads to it. `pid` is how the person can find it themselves.
 */
export type BusyAgentSession = Pick<
  SessionProfilerSession,
  'cwd' | 'worktreePath' | 'name' | 'agent' | 'stopping' | 'tracked' | 'pid'
>

export type BusyAgentSnapshot = Pick<SessionProfilerSnapshot, 'supported' | 'error'> & {
  readonly sessions: readonly BusyAgentSession[]
}

export interface BusyTerminal {
  /** Pid of the terminal's own process (its shell); 0 when it is not known. */
  readonly pid: number
  /** The folder the terminal was opened in. */
  readonly cwd: string
}

export interface BusySources {
  /** Ids of the sessions a window reports as working or waiting on a person. */
  runningSessionIds(): readonly string[]
  getSession(id: string): BusySession | null
  getConnection(id: string): BusyConnection | null
  getProject(id: string): BusyProject | null
  /** Document runs that are extracting, running or paused, of every project. */
  activeDocumentRuns(): readonly BusyDocumentRun[]
  /** Shell-command sessions that are pending or running, of every project. */
  activeShellSessions(): readonly BusySession[]
  /**
   * Ids of the sessions with a command running that was typed with `!` into their input box.
   * This process runs such a command itself, in the session's folder: it has no terminal and
   * no session row of its own, and the window does not report its session as working.
   */
  runningBashSessionIds(): Promise<readonly string[]>
  /**
   * Whether a script started under this key is still running. The keys asked about are
   * `script:run:<worktreeId>` and `script:setup:<worktreeId>`.
   */
  isScriptRunning(eventKey: string): boolean
  /** The agent CLIs the desktop app has open in terminals (they live in its main process). */
  agentCliSnapshot(): Promise<BusyAgentSnapshot>
  /** The plain terminals of this process. */
  terminals(): readonly BusyTerminal[]
  /**
   * Of these terminal pids, the ones running a command in the foreground. Null when that
   * cannot be read (no `ps`, or a system without process groups).
   */
  foregroundBusyPids(pids: readonly number[]): Promise<ReadonlySet<number> | null>
  /** Whether a desktop app is this process's parent: only then can agent CLIs exist. */
  readonly hasDesktopParent: boolean
  /** Real path in its on-disk spelling, or null when the path cannot be resolved. */
  canonical(path: string): string | null
  readonly log?: (message: string, detail?: Record<string, unknown>) => void
}

export interface BusyReadingOptions {
  /** How long the desktop app gets to list its agent CLIs before the check counts as not made. */
  readonly agentSnapshotTimeoutMs?: number
}

const AGENT_SNAPSHOT_TIMEOUT_MS = 5_000
const PS_TIMEOUT_MS = 5_000
const PS_MAX_BUFFER = 16 * 1024 * 1024

// ── Sentences ───────────────────────────────────────────────────────────────────────────

/** Why something failed, short enough to sit inside a sentence. */
export const reasonOf = (error: unknown): string => {
  let text = ''
  try {
    text = (error instanceof Error ? error.message : String(error)).trim().replace(/\.+$/, '')
  } catch {
    // A thrown value that cannot even be printed.
  }
  return text.length > 0 ? text : 'an unknown error'
}

/** `The session "Fix login"`, or `A session` when it has no name. */
const named = (kind: string, name: string | null | undefined): string => {
  const trimmed = typeof name === 'string' ? name.trim() : ''
  if (trimmed.length > 0) return `The ${kind} "${trimmed}"`
  return `${/^[aeiou]/i.test(kind) ? 'An' : 'A'} ${kind}`
}

const notChecked = (what: string, error: unknown): string =>
  `Could not check ${what}: ${reasonOf(error)}. Check again.`

const sessionSentence = (name: string | null, direct: boolean): string =>
  `${named('session', name)} is working or waiting for an answer in ${
    direct ? 'this project' : 'a connection that includes this project'
  }. Wait for it to finish or stop it, then check again.`

const commandSentence = (name: string | null, direct: boolean): string =>
  `${named('command', name)} is running in ${
    direct ? 'this project' : 'a connection that includes this project'
  }. Wait for it to finish or stop it, then check again.`

/** For a command typed with `!` into a session. The session shows it, with a button to stop it. */
const sessionCommandSentence = (name: string | null, direct: boolean): string =>
  `${named('session', name)} is running a command in ${
    direct ? 'this project' : 'a connection that includes this project'
  }. Wait for the command to finish or stop it in that session, then check again.`

const SESSION_COMMANDS = 'for commands running in sessions'

const runSentence = (run: Pick<BusyDocumentRun, 'title' | 'status'>, direct: boolean): string => {
  const where = direct ? 'this project' : 'a connection project that includes this project'
  const subject = named('orchestrator', run.title)
  if (run.status === 'extracting') {
    return `${subject} is still reading its document for ${where}. Wait for it to finish or cancel it, then check again.`
  }
  if (run.status === 'paused') {
    return `${subject} is paused in ${where}. Finish it or cancel it, then check again.`
  }
  return `${subject} is running in ${where}. Wait for it to finish or cancel it, then check again.`
}

const scriptSentence = (kind: 'run' | 'setup', worktreeName: string): string =>
  kind === 'run'
    ? `The run script of this project is running (worktree "${worktreeName}"). Stop it, then check again.`
    : `The setup script of the worktree "${worktreeName}" is still running. Wait for it to finish or stop it, then check again.`

const AGENT_NAMES: Readonly<Record<string, string>> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode'
}

const agentSentence = (session: BusyAgentSession): string => {
  const agent = AGENT_NAMES[session.agent] ?? 'agent'
  if (session.stopping) {
    return `${named(`${agent} session`, session.name)} is still shutting down in this project. Wait a moment, then check again.`
  }
  if (session.tracked === false) {
    // It has no tab to close. The session profiler lists such processes and can stop them;
    // it is off until the person turns it on.
    const pid = Number.isInteger(session.pid) && session.pid > 0 ? ` (pid ${session.pid})` : ''
    const name = typeof session.name === 'string' ? session.name.trim() : ''
    const owner = name.length > 0 ? ` of the session "${name}"` : ''
    return `A leftover ${agent} process${pid}${owner} is still running in this project. Turn on Session profiler in Settings › Advanced and stop it there, or end the process, then check again.`
  }
  return `${named(`${agent} session`, session.name)} has a terminal open in this project, and it would go on working in the old folder. Close its tab, then check again.`
}

const TERMINAL_SENTENCE =
  'A terminal in this project is running a command. Stop it, then check again.'

const OPEN_TERMINAL_SENTENCE =
  'A terminal is open in this project. The move goes to another disk and removes the folder the terminal is in. Close the terminal, then check again.'

// ── Reading the sources ─────────────────────────────────────────────────────────────────

/** `projects.member_project_ids` (a JSON array of ids) of a connection project; none otherwise. */
export const memberProjectIdsOf = (project: BusyProject | null | undefined): string[] => {
  const json = project?.member_project_ids
  if (!json) return []
  try {
    const parsed: unknown = JSON.parse(json)
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : []
  } catch {
    return []
  }
}

/** Something that is running, with the projects it runs in. */
interface Holder {
  /** The project it belongs to. */
  readonly own: string
  /** Projects it reaches through a connection or a connection project. */
  readonly through: ReadonlySet<string>
  /** The sentence for a project it holds: `direct` when that project is `own`. */
  readonly sentence: (direct: boolean) => string
}

/**
 * The projects a session works in besides its own: every member of its connection, and every
 * member of the connection project it (or its connection) belongs to. A session in a
 * connection is listed under the first member's project, or under the connection project, so
 * its own project id alone does not say whose folders it has open.
 */
const projectsThroughConnections = (
  session: BusySession,
  sources: Pick<BusySources, 'getConnection' | 'getProject'>
): Set<string> => {
  const through = new Set<string>(memberProjectIdsOf(sources.getProject(session.project_id)))
  if (session.connection_id) {
    const connection = sources.getConnection(session.connection_id)
    for (const member of connection?.members ?? []) through.add(member.project_id)
    if (connection?.saved_project_id) {
      through.add(connection.saved_project_id)
      for (const id of memberProjectIdsOf(sources.getProject(connection.saved_project_id))) {
        through.add(id)
      }
    }
  }
  return through
}

const sessionHolder = (
  session: BusySession,
  sources: Pick<BusySources, 'getConnection' | 'getProject'>,
  sentence: (name: string | null, direct: boolean) => string
): Holder => ({
  own: session.project_id,
  through: projectsThroughConnections(session, sources),
  sentence: (direct) => sentence(session.name, direct)
})

const holds = (holder: Holder, projectId: string): string | null => {
  if (holder.own === projectId) return holder.sentence(true)
  return holder.through.has(projectId) ? holder.sentence(false) : null
}

/** What is known about the agent CLIs: the list, or the sentence for "could not be checked". */
type AgentReading =
  | { readonly known: true; readonly sessions: readonly BusyAgentSession[] }
  | { readonly known: false; readonly sentence: string }

const AGENTS_NOT_CHECKED = 'Could not check for open agent sessions'

/**
 * For a system on which the desktop app cannot list agent sessions at all (Windows). Checking
 * again changes nothing there, so the sentence does not ask for it.
 */
const AGENTS_NOT_LISTABLE =
  'Moving projects is not available on this system yet: Hive cannot tell whether an agent session is open in a project.'

/**
 * Agent CLIs run in the desktop app's main process, so only it can list them. Without a
 * desktop parent there is no such process and no agent CLI: nothing to check. With one, a
 * list that did not arrive (an error, no answer in time, a system the app cannot sample)
 * leaves it unknown whether a CLI sits in a project's folder, and every project counts as
 * busy until the check can be made.
 */
const readAgents = async (sources: BusySources, timeoutMs: number): Promise<AgentReading> => {
  const unknown = (reason: string): AgentReading => {
    if (!sources.hasDesktopParent) return { known: true, sessions: [] }
    return { known: false, sentence: `${AGENTS_NOT_CHECKED}: ${reason}. Check again.` }
  }
  /** Not a pass: a move to another disk would copy the folder away under a CLI still in it. */
  const notListable = (): AgentReading =>
    sources.hasDesktopParent
      ? { known: false, sentence: AGENTS_NOT_LISTABLE }
      : { known: true, sessions: [] }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs)
    })
    const snapshot = await Promise.race([sources.agentCliSnapshot(), late])
    if (snapshot === null) return unknown('the app did not answer in time')
    if (typeof snapshot !== 'object' || !Array.isArray(snapshot.sessions)) {
      return unknown('the app gave an answer that could not be read')
    }
    if (typeof snapshot.error === 'string') return unknown(reasonOf(snapshot.error))
    if (snapshot.supported !== true) return notListable()
    return { known: true, sessions: snapshot.sessions }
  } catch (error) {
    return unknown(reasonOf(error))
  } finally {
    clearTimeout(timer)
  }
}

/** The folders of the plain terminals: of all that are open, and of those running a command. */
interface TerminalFolders {
  readonly open: readonly string[]
  readonly running: readonly string[]
}

/**
 * The folders of the plain terminals. `running` are those with a command in the foreground:
 * they hold a project back in every move. A shell sitting at its prompt is left out of them:
 * a rename keeps its working directory, so it goes on working after the move. When it cannot
 * be told which terminals are running something, none of them counts as running: nearly
 * every project has an idle terminal open, and counting them all would leave "Move projects"
 * with nothing it may move.
 *
 * `open` are all of them, whatever they are doing and whether or not that can be read. They
 * only hold a project back when its folders are copied to another disk: the old folder is
 * removed then, and a shell left in it can neither read nor write until the person leaves
 * it by hand.
 */
const readTerminalFolders = async (sources: BusySources): Promise<TerminalFolders> => {
  const all = sources.terminals()
  const open = all.map((terminal) => terminal.cwd)
  const terminals = all.filter((terminal) => terminal.pid > 0)
  if (terminals.length === 0) return { open, running: [] }
  let busy: ReadonlySet<number> | null = null
  try {
    busy = await sources.foregroundBusyPids(terminals.map((terminal) => terminal.pid))
  } catch (error) {
    sources.log?.('dev folder: reading the terminals failed', { error: reasonOf(error) })
  }
  if (busy === null) return { open, running: [] }
  const running = busy
  return {
    open,
    running: terminals
      .filter((terminal) => running.has(terminal.pid))
      .map((terminal) => terminal.cwd)
  }
}

/**
 * The sessions with a `!` command running. An async function, so that a source that throws
 * instead of rejecting is caught by the same handler.
 */
const readBashSessionIds = async (sources: BusySources): Promise<readonly string[]> => [
  ...(await sources.runningBashSessionIds())
]

/**
 * Take one reading of what is running. The answer is a function that is asked about one
 * project at a time and never throws. Never rejects: a source that fails makes every project
 * busy with a sentence that says which check could not be made.
 */
export const takeBusyReading = async (
  sources: BusySources,
  options: BusyReadingOptions = {}
): Promise<BusyProbe> => {
  /** Checks that could not be made; each holds every project back. */
  const notMade: string[] = []
  const attempt = <T>(what: string, fallback: T, read: () => T): T => {
    try {
      return read()
    } catch (error) {
      notMade.push(notChecked(what, error))
      sources.log?.(`dev folder: could not check ${what}`, { error: reasonOf(error) })
      return fallback
    }
  }

  // The two slow readings first, side by side; the database and the window's report are read
  // after them, so they are as fresh as they can be when the answer is handed out.
  const [agents, terminalFolders] = await Promise.all([
    readAgents(sources, options.agentSnapshotTimeoutMs ?? AGENT_SNAPSHOT_TIMEOUT_MS).catch(
      (error: unknown): AgentReading => ({
        known: false,
        sentence: `${AGENTS_NOT_CHECKED}: ${reasonOf(error)}. Check again.`
      })
    ),
    readTerminalFolders(sources).catch((error: unknown): TerminalFolders => {
      notMade.push(notChecked('the open terminals', error))
      return { open: [], running: [] }
    })
  ])

  // Asked after the slow readings, like the database: this process answers at once, and a
  // command can be started in a session while the other two are on their way.
  const bashSessionIds = await readBashSessionIds(sources).catch(
    (error: unknown): readonly string[] => {
      notMade.push(notChecked(SESSION_COMMANDS, error))
      sources.log?.(`dev folder: could not check ${SESSION_COMMANDS}`, { error: reasonOf(error) })
      return []
    }
  )

  const sessions = attempt('which sessions are working', [] as Holder[], () => {
    const found: Holder[] = []
    for (const id of sources.runningSessionIds()) {
      // A window can report a session the database does not know: it belongs to no project.
      const session = sources.getSession(id)
      if (session !== null) found.push(sessionHolder(session, sources, sessionSentence))
    }
    return found
  })

  const runs = attempt('for running orchestrators', [] as Holder[], () =>
    sources.activeDocumentRuns().map((run): Holder => {
      // A run on a connection project works in every member's checkout. Once it is launched
      // it names them itself; before that only the connection project does.
      const through = new Set<string>(memberProjectIdsOf(sources.getProject(run.project_id)))
      for (const member of run.members ?? []) through.add(member.project_id)
      return { own: run.project_id, through, sentence: (direct) => runSentence(run, direct) }
    })
  )

  const commands = attempt('for running commands', [] as Holder[], () =>
    sources.activeShellSessions().map((session) => sessionHolder(session, sources, commandSentence))
  )

  const sessionCommands = attempt(SESSION_COMMANDS, [] as Holder[], () => {
    const found: Holder[] = []
    for (const id of bashSessionIds) {
      // A command goes on running when its session is deleted: no row is left to say which
      // project it is in.
      const session = sources.getSession(id)
      if (session !== null) found.push(sessionHolder(session, sources, sessionCommandSentence))
    }
    return found
  })

  /** Real paths asked for more than once in a plan over many projects. */
  const canonicalOf = new Map<string, string | null>()
  const canonical = (path: string): string | null => {
    const known = canonicalOf.get(path)
    if (known !== undefined) return known
    let real: string | null = null
    try {
      real = sources.canonical(path)
    } catch {
      // Not resolvable: only the spelling is compared.
    }
    canonicalOf.set(path, real)
    return real
  }
  /** A path as it is spelled and as the disk spells it. */
  const spellingsOf = (path: string): string[] => {
    const real = canonical(path)
    return real === null || real === path ? [path] : [path, real]
  }
  const isInside = (folders: readonly string[], path: string | null): boolean => {
    if (typeof path !== 'string' || path.length === 0) return false
    return spellingsOf(path).some((spelling) =>
      folders.some((folder) => isSameOrAncestorPath(folder, spelling))
    )
  }

  return (project, worktrees, movingPaths, move) => {
    try {
      for (const holder of [...sessions, ...runs, ...commands, ...sessionCommands]) {
        const sentence = holds(holder, project.id)
        if (sentence !== null) return sentence
      }

      for (const worktree of worktrees) {
        if (sources.isScriptRunning(`script:run:${worktree.id}`)) {
          return scriptSentence('run', worktree.name)
        }
        if (sources.isScriptRunning(`script:setup:${worktree.id}`)) {
          return scriptSentence('setup', worktree.name)
        }
      }

      const folders = [...new Set(movingPaths.flatMap(spellingsOf))]
      if (agents.known) {
        // An idle CLI counts as well: it keeps the folder it was started in for as long as it
        // lives, and would go on reading and writing the old path.
        const open = agents.sessions.find(
          (session) => isInside(folders, session.cwd) || isInside(folders, session.worktreePath)
        )
        if (open !== undefined) return agentSentence(open)
      }
      if (terminalFolders.running.some((cwd) => isInside(folders, cwd))) return TERMINAL_SENTENCE
      // The same reading answers for a rename and for a copy: only the copy takes the folder
      // away from a shell that sits in it.
      if (move?.copies === true && terminalFolders.open.some((cwd) => isInside(folders, cwd))) {
        return OPEN_TERMINAL_SENTENCE
      }

      if (!agents.known) return agents.sentence
      return notMade.length > 0 ? notMade[0] : null
    } catch (error) {
      return notChecked('whether something is running in this project', error)
    }
  }
}

// ── Which terminals are running a command ───────────────────────────────────────────────

/**
 * From the output of `ps -A -o pid=,pgid=,tpgid=`: the given pids that have handed their
 * terminal to another process group. A shell runs each command in a group of its own and
 * makes that group the terminal's foreground one (`tpgid`) for as long as the command runs;
 * at its prompt the foreground group is the shell's own. A pid that is not listed has exited,
 * and one without a terminal (`tpgid` 0 or -1) is not waiting on anything it started there.
 */
export const parseForegroundBusyPids = (psOutput: string, pids: readonly number[]): Set<number> => {
  const wanted = new Set(pids)
  const busy = new Set<number>()
  for (const line of psOutput.split('\n')) {
    const columns = line.trim().split(/\s+/)
    if (columns.length < 3) continue
    const [pid, pgid, tpgid] = columns.map(Number)
    if (!Number.isInteger(pid) || !Number.isInteger(pgid) || !Number.isInteger(tpgid)) continue
    if (wanted.has(pid) && tpgid > 0 && tpgid !== pgid) busy.add(pid)
  }
  return busy
}

const PS_ARGS = ['-A', '-o', 'pid=,pgid=,tpgid=']

const runPs = (command: string): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      PS_ARGS,
      {
        env: { ...process.env, LC_ALL: 'C' },
        timeout: PS_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        maxBuffer: PS_MAX_BUFFER,
        encoding: 'utf8'
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout))
    )
  })

/** One `ps` over every process. `/bin/ps` first: the app's PATH is not always the shell's. */
const readProcessGroups = async (): Promise<string> => {
  try {
    return await runPs('/bin/ps')
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error
    return runPs('ps')
  }
}

export interface ForegroundBusyOptions {
  readonly platform?: NodeJS.Platform
  /** Stands in for the `ps` call. */
  readonly readProcessGroups?: () => Promise<string>
}

/**
 * Of the given terminal pids, the ones running a command in the foreground right now: one
 * `ps` per call. Null when that cannot be read: on Windows (no process groups), or when `ps`
 * fails or does not answer in time. Never rejects.
 */
export const readForegroundBusyPids = async (
  pids: readonly number[],
  options: ForegroundBusyOptions = {}
): Promise<ReadonlySet<number> | null> => {
  if ((options.platform ?? process.platform) === 'win32') return null
  if (pids.length === 0) return new Set()
  try {
    const output = await (options.readProcessGroups ?? readProcessGroups)()
    return parseForegroundBusyPids(output, pids)
  } catch {
    return null
  }
}
