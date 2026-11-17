// The move service bound to the running app (`MoveProjectsDeps`): the database, the disk, git,
// what is running, and everything outside the database that names a project's folder.
//
// Runs in the server child. Importing this module loads nothing but the small modules below:
// the terminals, the watchers, the boards, git and the connections are loaded inside
// `createLiveMoveProjectsDeps`, on the first move or plan (the data engine later still, by the
// one step that needs it). Settings imports this module's neighbours on every open, and its
// tests load them against a database double.
import { lstatSync, readdirSync, readlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import {
  DOCUMENT_FLOW_UPDATED_CHANNEL,
  type DocumentFlowUpdatedEvent
} from '../../../shared/document-flow-events'
import type { DocumentRun } from '../../../shared/types/document-flow'
import type { RunningSessionsTracker } from '../../../server/running-sessions'
import type { DatabaseService } from '../../db'
import type { Project, Worktree } from '../../db/types'
import { isSameOrAncestorPath } from '../path-utils'
import { memberProjectIdsOf, readForegroundBusyPids, reasonOf, takeBusyReading } from './busy-probe'
import { canonicalFolderPath } from './folder-identity'
import { createLiveMoveQueryDeps } from './live-query-deps'
import type { MovedProject, MoveProjectsDeps, RelocationMove } from './types'

export interface LiveMoveProjectsOptions {
  /**
   * The window's report of its running sessions. Absent (a test, a server without a window)
   * means nothing is reported; what the database and the terminals say still applies.
   */
  readonly activity?: Pick<RunningSessionsTracker, 'runningSessionIds'> | null
  /** The database to work on; the process's own when absent. */
  readonly db?: DatabaseService
  /** Stands in for the home directory. */
  readonly homeDir?: string
  /**
   * The environment a spawned Claude CLI sees; this process's with the person's Settings
   * variables on top when absent.
   */
  readonly env?: NodeJS.ProcessEnv
}

type MoveEventPublisher = (channel: string, payload: unknown) => void | Promise<void>

let moveEventPublisher: MoveEventPublisher | null = null

/**
 * How a move reaches the server's event bus for what is not a `db:changed` event: the
 * document runs whose paths it rewrote. The server registers its bus at start, as it does for
 * the git and board events; with none registered those runs are not announced, and a window
 * that has one open shows its old paths until it reads the run again.
 */
export const setDevFolderMoveEventPublisher = (publisher: MoveEventPublisher | null): void => {
  moveEventPublisher = publisher
}

/**
 * As many of a project's runs as one listing returns: the newest ones. Only for a move that
 * does not say which runs it changed.
 */
const ANNOUNCED_RUNS_PER_PROJECT = 200

const isNotFound = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'

/**
 * Whether a connection project's folder still has a member link that the move left broken:
 * the relink said so about this folder, or a link in it still points into a folder that
 * moved. A folder that cannot be read counts as broken; one that is gone has no board.
 */
const hasBrokenMemberLink = (
  folder: string,
  relinkWarnings: readonly string[],
  relocations: readonly RelocationMove[]
): boolean => {
  if (relinkWarnings.some((text) => text.includes(folder + sep) || text.includes(`(${folder})`))) {
    return true
  }
  try {
    for (const name of readdirSync(folder)) {
      const linkPath = join(folder, name)
      if (!lstatSync(linkPath).isSymbolicLink()) continue
      const target = readlinkSync(linkPath)
      const pointsAtOldPlace = relocations.some((relocation) =>
        relocation.from.some((from) => isSameOrAncestorPath(from, target))
      )
      if (pointsAtOldPlace) return true
    }
    return false
  } catch (error) {
    return !isNotFound(error)
  }
}

/**
 * Bind the move service to the app. Resolves once every module it needs is loaded, so that
 * `onRelocated`, which has to run in the same tick as the commit, never waits for one.
 */
export const createLiveMoveProjectsDeps = async (
  options: LiveMoveProjectsOptions = {}
): Promise<MoveProjectsDeps> => {
  const [
    { Effect },
    { createLogger },
    { ptyService },
    { scriptRunner },
    { makeLiveSessionProfilerOpsRpcService },
    { runningBashSessionIds },
    { deactivateMarkdownKanbanProjectWatch, restartMarkdownKanbanProjectWatch },
    { getMarkdownKanbanBackend },
    { regenerateConnectionInstructionsForProject, relinkConnectionSymlinksForMovedProject },
    { movePort },
    { syncWorktreesOp },
    { claudeProjectRoots, moveClaudeTranscripts },
    { moveFolderEntryInClaudeConfig, resolveClaudeConfigPath },
    { getUserEnvironmentVariables },
    { rebindBranchWatch },
    { rebindWorktreeGitWatch },
    { emitDbChanged },
    { createMoveProjectsGit }
  ] = await Promise.all([
    import('effect'),
    import('../logger'),
    import('../pty-service'),
    import('../script-runner'),
    import('../../../server/rpc/domains/session-profiler-ops'),
    import('../../../server/rpc/domains/bash'),
    import('../markdown-kanban-watcher'),
    import('../kanban-backend'),
    import('../connection-ops'),
    import('../port-registry'),
    import('../worktree-ops'),
    import('./claude-state'),
    import('../claude-trust'),
    import('../env-vars'),
    import('../branch-watcher'),
    import('../worktree-watcher'),
    import('../db-change-events'),
    import('./git-ports')
  ])
  const db = options.db ?? (await import('../../db')).getDatabase()
  const home = options.homeDir ?? homedir()
  const logger = createLogger({ component: 'DevFolderMove' })
  const profiler = makeLiveSessionProfilerOpsRpcService()
  const query = createLiveMoveQueryDeps(db, { homeDir: options.homeDir })

  /** Read when it is needed: the person can change their variables between two moves. */
  const environment = (): NodeJS.ProcessEnv =>
    options.env ?? { ...process.env, ...getUserEnvironmentVariables(db) }

  /** `~/.claude.json` as the CLI resolves it, with `home` standing in for the home directory. */
  const claudeConfigPath = (env: NodeJS.ProcessEnv): string =>
    resolveClaudeConfigPath({ ...env, CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR || home })

  /**
   * The connection projects that list the project as a member. Their boards, links and
   * tickets follow a member that moves. None when the projects cannot be read: the callers
   * then do what they can for the project itself.
   */
  const connectionProjectsWith = (projectId: string): Project[] => {
    try {
      return db
        .getAllProjects()
        .filter(
          (project) =>
            project.kind === 'connection' && memberProjectIdsOf(project).includes(projectId)
        )
    } catch (error) {
      logger.warn('dev folder: reading the connection projects failed', {
        projectId,
        error: reasonOf(error)
      })
      return []
    }
  }

  /** The boards that read files through the project's folder: its own and those above. */
  const boardProjectIds = (projectId: string): string[] => [
    projectId,
    ...connectionProjectsWith(projectId).map((project) => project.id)
  ]

  /**
   * The other projects whose row the move rewrote, without the ones named in `known`. One of
   * them may keep its board in a folder of the project that moved: its board config was
   * repointed, so what was read and what is watched through the old path has to be dropped.
   * They are only known once the move is committed, so their watch is not stopped before it.
   */
  const otherBoardProjectIds = (moved: MovedProject, known: readonly string[]): string[] => [
    ...new Set(moved.otherProjectIds.filter((id) => !known.includes(id)))
  ]

  /**
   * Moved project id → the connection projects whose board watch stays stopped after this
   * move, because a member link of theirs is still broken. Set in `onRelocated`, used once by
   * `afterMove` of the same move.
   */
  const boardsHeldStopped = new Map<string, ReadonlySet<string>>()

  /**
   * Every project and worktree path the database holds now, without the ones that moved:
   * how Claude's history of a neighbour whose folder name encodes the same way is told apart.
   */
  const pathsThatDidNotMove = (moved: MovedProject): string[] => {
    const paths = new Set<string>()
    for (const project of db.getAllProjects()) {
      paths.add(project.path)
      for (const worktree of db.getWorktreesByProject(project.id)) paths.add(worktree.path)
    }
    paths.delete(moved.toPath)
    for (const move of moved.moves) {
      paths.delete(move.from)
      paths.delete(move.to)
    }
    for (const worktree of moved.worktrees) {
      paths.delete(worktree.from)
      paths.delete(worktree.to)
    }
    return [...paths]
  }

  /**
   * The linked worktrees of the project that stayed where they were. Their git directory
   * lives inside the checkout and moved with it, so whatever watches it has to look again.
   */
  const worktreesThatStayed = (moved: MovedProject): Worktree[] => {
    let rows: readonly Worktree[]
    try {
      rows = db.getWorktreesByProject(moved.project.id)
    } catch {
      rows = moved.allWorktrees
    }
    const movedIds = new Set(moved.worktrees.map((worktree) => worktree.id))
    const movedFolders = moved.relocations.map((relocation) => relocation.to)
    return rows.filter(
      (row) =>
        row.status === 'active' &&
        !row.is_default &&
        !movedIds.has(row.id) &&
        !movedFolders.some((folder) => isSameOrAncestorPath(folder, row.path))
    )
  }

  return {
    ...query,
    git: createMoveProjectsGit(),
    homeDir: home,

    busy: () =>
      takeBusyReading({
        runningSessionIds: () => options.activity?.runningSessionIds() ?? [],
        getSession: (id) => db.getSession(id),
        getConnection: (id) => db.getConnection(id),
        getProject: (id) => db.getProject(id),
        activeDocumentRuns: () =>
          db.listDocumentRunsInStatuses(['extracting', 'running', 'paused']),
        activeShellSessions: () => db.getShellCommandSessionsInStates(['pending', 'running']),
        // `bash.run` is handled by this process, and the commands it starts are its children:
        // the module that handles it is asked, not the desktop app.
        runningBashSessionIds: () => runningBashSessionIds(),
        isScriptRunning: (eventKey) => scriptRunner.isRunning(eventKey),
        agentCliSnapshot: () => Effect.runPromise(profiler.getSnapshot()),
        terminals: () => ptyService.listInstances(),
        foregroundBusyPids: (pids) => readForegroundBusyPids(pids),
        // The desktop app starts this process with a channel to itself; a server started on
        // its own has none, and no agent CLI can be running under it.
        hasDesktopParent: typeof process.send === 'function',
        canonical: canonicalFolderPath,
        log: (message, detail) => logger.warn(message, detail)
      }),

    beforeMove: async (project) => {
      // A watch that sees the folder vanish reports every card as removed.
      for (const id of boardProjectIds(project.id)) {
        try {
          await deactivateMarkdownKanbanProjectWatch(id)
        } catch (error) {
          logger.warn('dev folder: stopping a board watch failed', {
            projectId: id,
            error: reasonOf(error)
          })
        }
      }
    },

    afterAbort: async (project) => {
      for (const id of boardProjectIds(project.id)) {
        try {
          await restartMarkdownKanbanProjectWatch(id)
        } catch (error) {
          logger.warn('dev folder: restarting a board watch failed', {
            projectId: id,
            error: reasonOf(error)
          })
        }
      }
    },

    onRelocated: (moved) => {
      const warnings: string[] = []
      try {
        const projectId = moved.project.id
        const connectionProjects = connectionProjectsWith(projectId)

        try {
          const boards = getMarkdownKanbanBackend()
          const above = connectionProjects.map((project) => project.id)
          boards.invalidate(projectId)
          for (const id of above) boards.invalidate(id)
          for (const id of otherBoardProjectIds(moved, [projectId, ...above])) {
            boards.invalidate(id)
          }
        } catch (error) {
          warnings.push(
            `The board of this project may still list cards from its old folder: ${reasonOf(error)}. Open the board again to read it from the new folder.`
          )
        }

        try {
          // `relocations`, not `moves`: a link to a worktree inside the checkout is stored in
          // git's spelling, which only the relocations carry for every folder.
          const relink = relinkConnectionSymlinksForMovedProject(db, projectId, moved.relocations)
          warnings.push(...relink.warnings)
          boardsHeldStopped.set(
            projectId,
            new Set(
              relink.warnings.length === 0
                ? []
                : connectionProjects
                    .filter((project) =>
                      hasBrokenMemberLink(project.path, relink.warnings, moved.relocations)
                    )
                    .map((project) => project.id)
            )
          )
        } catch (error) {
          warnings.push(
            `The links of the connections that include this project could not be updated and still point at its old folder: ${reasonOf(error)}.`
          )
          boardsHeldStopped.set(projectId, new Set(connectionProjects.map((project) => project.id)))
        }

        // The port goes with the folder under every spelling it may be registered by. No
        // sentence when nothing moved: most folders have no port.
        for (const move of moved.moves) {
          try {
            movePort(move.from, move.to)
          } catch (error) {
            logger.warn('dev folder: moving a port failed', {
              from: move.from,
              error: reasonOf(error)
            })
          }
        }

        // A shell goes with its folder through a rename, but the terminals are filed under the
        // folder each was opened in. Re-filed, so that the next look at what is running finds
        // an open terminal in the project it is in: a later move to another disk would
        // otherwise remove the folder under it.
        try {
          ptyService.refileMovedFolders(moved.moves)
        } catch (error) {
          logger.warn('dev folder: re-filing the open terminals failed', {
            error: reasonOf(error)
          })
        }
      } catch (error) {
        warnings.push(
          `Connection folders, the board or the port of this project may still point at the old folder: ${reasonOf(error)}. Restart the app if one of them looks wrong.`
        )
      }
      return warnings
    },

    // Said to be the move's own sync: while the move's note is in the database, every other
    // sync of this project leaves its worktrees alone.
    syncWorktrees: (params) => syncWorktreesOp(options.db, params, { forDevFolderMove: true }),

    afterMove: async (moved) => {
      const warnings: string[] = []
      const projectId = moved.project.id

      // First, before anything slow: a connection to a SQLite file keeps the file it opened.
      // After a rename it can no longer write to it; after a copy it goes on writing into the
      // old copy, which is then deleted. Closed here, the next use opens the file where the
      // rewritten config says it is. A connection to a server holds no path of the project
      // (only its key files changed place), so its queries and transactions are left alone.
      for (const id of moved.dataProjectIds) {
        let name: string | null = null
        try {
          const record = db.getDataProject(id)
          if (record?.engine !== 'sqlite') continue
          name = record.name
          // Loaded here and not with the rest: only a move of a folder that holds such a
          // file needs it, and the engine exists only once a data project was opened.
          const { invalidateDataEngineIfLoaded } = await import('../data-projects/engine-service')
          await invalidateDataEngineIfLoaded(id)
        } catch (error) {
          const who = name === null ? 'A data project' : `The data project "${name}"`
          warnings.push(
            `${who} may still be connected to its database file in the old folder: ${reasonOf(error)}. Disconnect it, then connect again.`
          )
        }
      }

      try {
        warnings.push(
          ...(await moveClaudeTranscripts({
            moves: moved.moves,
            roots: claudeProjectRoots(environment(), home),
            otherRegisteredPaths: pathsThatDidNotMove(moved)
          }))
        )
      } catch (error) {
        warnings.push(
          `Claude's history of this project could not be moved along with it: ${reasonOf(error)}. Sessions started before the move may not be offered for resuming in the new folder.`
        )
      }

      try {
        const configPath = claudeConfigPath(environment())
        for (const move of moved.moves) {
          // The old entry goes even while the old folder is still on disk: after a move to
          // another disk the old copy is removed only later (or kept when it changed), and
          // whatever is at the old path from now on is not this project.
          const result = await moveFolderEntryInClaudeConfig(configPath, move.from, move.to, {
            removeOld: 'always'
          })
          if (result.ok) continue
          // A file that cannot be read or written now will not be for the next folder either.
          warnings.push(
            `Claude's settings file (${configPath}) could not be updated, so Claude Code may ask again whether it trusts this project's folder.`
          )
          break
        }
      } catch (error) {
        warnings.push(
          `Claude's settings for this project's folder could not be carried over: ${reasonOf(error)}. Claude Code may ask again whether it trusts the folder.`
        )
      }

      try {
        // After the relink (`onRelocated`): the files name each member by the link that
        // points at its folder now.
        warnings.push(...regenerateConnectionInstructionsForProject(db, projectId))
      } catch (error) {
        warnings.push(
          `AGENTS.md and CLAUDE.md of the connections that include this project still name its old folder: ${reasonOf(error)}.`
        )
      }

      const held = boardsHeldStopped.get(projectId) ?? new Set<string>()
      boardsHeldStopped.delete(projectId)
      const boardProjects: { readonly id: string; readonly heldName: string | null }[] = [
        { id: projectId, heldName: null },
        ...connectionProjectsWith(projectId).map((project) => ({
          id: project.id,
          heldName: held.has(project.id) ? project.name : null
        }))
      ]
      // A watch on a board folder inside the project still looks at the old path.
      const alreadyListed = boardProjects.map((board) => board.id)
      for (const id of otherBoardProjectIds(moved, alreadyListed)) {
        boardProjects.push({ id, heldName: null })
      }
      for (const board of boardProjects) {
        if (board.heldName !== null) {
          // Its board folders may be reached through the broken link. A scan would find no
          // cards there and, on the second one, drop what the app keeps about each of them.
          warnings.push(
            `The board of the connection project "${board.heldName}" is not watched for changes while its link to this project is broken. Fix the link, then open that board again.`
          )
          continue
        }
        try {
          await restartMarkdownKanbanProjectWatch(board.id)
        } catch (error) {
          warnings.push(
            `A board that reads files from this project is not watched for changes: ${reasonOf(error)}. Open the board again to start watching it.`
          )
        }
      }

      // By now git has re-linked the worktrees (the service repairs before it calls this), so
      // each `.git` pointer leads to the directory to watch.
      const unwatched: string[] = []
      for (const worktree of worktreesThatStayed(moved)) {
        try {
          // False from either means the worktree is not watched: nothing to do.
          rebindBranchWatch(worktree.path)
          await rebindWorktreeGitWatch(worktree.path)
        } catch (error) {
          unwatched.push(reasonOf(error))
        }
      }
      if (unwatched.length > 0) {
        warnings.push(
          `Branch and status changes in ${
            unwatched.length === 1 ? 'a worktree' : `${unwatched.length} worktrees`
          } of this project may not show up until the app is restarted: ${unwatched[0]}.`
        )
      }

      return warnings
    },

    publishChanged: (moved) => {
      try {
        const projectId = moved.project.id
        const connectionProjectIds = connectionProjectsWith(projectId).map((project) => project.id)

        // The transaction that repointed the rows published nothing: one event per entity
        // that a window keeps a copy of.
        for (const id of new Set([projectId, ...moved.otherProjectIds])) {
          emitDbChanged({ entity: 'project', op: 'update', id, projectId: id })
        }
        emitDbChanged({ entity: 'worktree', op: 'batch', id: null, projectId })
        // A connection lists the path of each member worktree.
        emitDbChanged({ entity: 'connection', op: 'batch', id: null, projectId: null })
        // The tickets of the project and of the connection projects above it, and of every
        // other project that had a ticket rewritten because it named the folder.
        for (const id of new Set([
          projectId,
          ...connectionProjectIds,
          ...(moved.ticketProjectIds ?? [])
        ])) {
          emitDbChanged({ entity: 'ticket', op: 'batch', id: null, projectId: id })
        }
        for (const id of moved.dataProjectIds) {
          emitDbChanged({ entity: 'dataProject', op: 'update', id, projectId: null })
        }

        // The runs that changed, by id when the move reports them: a run of any project can
        // name a file in the folder. Without that report, the newest runs of the project and
        // of the connection projects above it stand in for them.
        const runs: Pick<DocumentRun, 'id' | 'project_id'>[] = []
        if (moved.runIds !== undefined) {
          for (const id of new Set(moved.runIds)) {
            const run = db.getDocumentRun(id)
            if (run !== null) runs.push(run)
          }
        } else if (moved.runsRewritten > 0) {
          for (const id of [projectId, ...connectionProjectIds]) {
            runs.push(...db.listDocumentRuns(id, ANNOUNCED_RUNS_PER_PROJECT))
          }
        }
        if (runs.length === 0) return
        const publish = moveEventPublisher
        if (publish === null) {
          logger.warn('dev folder: no event publisher is set, the moved runs are not announced', {
            projectId
          })
          return
        }
        for (const run of runs) {
          const event: DocumentFlowUpdatedEvent = {
            runId: run.id,
            projectId: run.project_id,
            reason: 'run'
          }
          void Promise.resolve(publish(DOCUMENT_FLOW_UPDATED_CHANNEL, event)).catch(() => undefined)
        }
      } catch (error) {
        logger.warn('dev folder: announcing a move failed', {
          projectId: moved.project.id,
          error: reasonOf(error)
        })
      }
    },

    log: (message, detail) => logger.info(message, detail)
  }
}
