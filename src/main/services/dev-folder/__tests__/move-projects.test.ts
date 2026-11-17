// The move service against in-memory fakes of every port. The fakes keep one call log, so a
// test can assert the order of the steps, and every port counts its calls, so a test can make
// the n-th call of any of them fail.
import { basename, dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type {
  DevFolderMoveResult,
  DevFolderMoveSkipReason
} from '../../../../shared/types/dev-folder'
import type { Project, Worktree } from '../../../db/types'
import {
  countLeftBehind,
  moveProjectToDevFolder,
  planDevFolderMove,
  resumePendingDevFolderMove
} from '../move-projects'
import type {
  BusyProbeOptions,
  LeftoverSource,
  LinkedWorktree,
  MovedProject,
  MoveProjectsDeps,
  PathKind,
  PendingDevFolderMove,
  PreparedMove,
  RelocateProjectInput,
  RelocationMove
} from '../types'

const NOW = '2026-01-01T00:00:00.000Z'

const projectRow = (id: string, path: string, overrides: Partial<Project> = {}): Project => ({
  id,
  name: id,
  path,
  description: null,
  tags: null,
  language: null,
  custom_icon: null,
  detected_icon: null,
  setup_script: null,
  run_script: null,
  archive_script: null,
  worktree_create_script: null,
  custom_commands: null,
  auto_assign_port: false,
  sort_order: 0,
  created_at: NOW,
  last_accessed_at: NOW,
  ...overrides
})

const worktreeRow = (
  id: string,
  projectId: string,
  path: string,
  overrides: Partial<Worktree> = {}
): Worktree => ({
  id,
  project_id: projectId,
  name: basename(path),
  branch_name: basename(path),
  path,
  status: 'active',
  is_default: false,
  branch_renamed: 0,
  last_message_at: null,
  session_titles: '[]',
  last_model_provider_id: null,
  last_model_id: null,
  last_model_variant: null,
  attachments: '[]',
  pinned: 0,
  context: null,
  github_pr_number: null,
  github_pr_url: null,
  base_branch: null,
  created_at: NOW,
  last_accessed_at: NOW,
  ...overrides
})

type FailMode = 'reject' | 'throw'

interface WorldOptions {
  readonly devFolder?: string
  readonly previousFolders?: readonly string[]
  /** The dev folder is on another volume: a move copies, and the old folder stays until discarded. */
  readonly otherVolume?: boolean
  /** Create the dev folder on disk (the default). */
  readonly devFolderOnDisk?: boolean
}

const under = (folder: string, path: string): boolean =>
  path === folder || path.startsWith(`${folder}/`)

/** A disk, a database, a git and everything else the service is handed, all in memory. */
const makeWorld = (options: WorldOptions = {}) => {
  const devFolder = options.devFolder ?? '/dev'
  const previousFolders = options.previousFolders ?? ['/old']
  const copied = options.otherVolume === true

  /** Every call that changes something or that the order of matters, in the order made. */
  const calls: string[] = []
  const counts = new Map<string, number>()
  const failures = new Map<string, { nth: number | 'always'; mode: FailMode }>()

  /** Count the call; throw when the test asked for this call of this port to fail. */
  const tick = (port: string): void => {
    const count = (counts.get(port) ?? 0) + 1
    counts.set(port, count)
    const failure = failures.get(port)
    if (failure && (failure.nth === 'always' || failure.nth === count)) {
      throw new Error(`${port} failed`)
    }
  }
  /** An async port: fails by rejecting, or by throwing before it returns a promise. */
  const asyncPort = <T>(port: string, body: () => T | Promise<T>): Promise<T> => {
    try {
      tick(port)
    } catch (error) {
      if (failures.get(port)?.mode === 'throw') throw error
      return Promise.reject(error)
    }
    try {
      return Promise.resolve(body())
    } catch (error) {
      return Promise.reject(error)
    }
  }

  // ── Disk: real paths → kind, plus symlinked folders ──
  const entries = new Map<string, PathKind>([['/', 'dir']])
  const links = new Map<string, string>()
  const realOf = (path: string): string => {
    let current = resolve(path)
    for (let hop = 0; hop < 8; hop += 1) {
      const link = [...links.keys()].find((candidate) => under(candidate, current))
      if (link === undefined) break
      current = `${links.get(link)}${current.slice(link.length)}`
    }
    return current
  }
  const kindOf = (path: string): PathKind | null =>
    links.has(resolve(path)) ? 'symlink' : (entries.get(realOf(path)) ?? null)
  const canonicalOf = (path: string): string | null => {
    const real = realOf(path)
    return entries.has(real) ? real : null
  }
  const addDir = (path: string): void => {
    let current = realOf(path)
    while (!entries.has(current)) {
      entries.set(current, 'dir')
      current = dirname(current)
    }
  }
  const addFile = (path: string): void => {
    addDir(dirname(path))
    entries.set(realOf(path), 'file')
  }
  const copyTree = (from: string, to: string): void => {
    const source = realOf(from)
    const target = realOf(to)
    for (const [path, kind] of [...entries]) {
      if (under(source, path)) entries.set(`${target}${path.slice(source.length)}`, kind)
    }
  }
  const removeTree = (path: string): void => {
    const root = realOf(path)
    for (const entry of [...entries.keys()]) if (under(root, entry)) entries.delete(entry)
  }
  const renameTree = (from: string, to: string): void => {
    copyTree(from, to)
    removeTree(from)
  }
  if (options.devFolderOnDisk !== false) addDir(devFolder)
  for (const folder of previousFolders) addDir(folder)

  // ── Database ──
  const projects = new Map<string, Project>()
  const worktrees: Worktree[] = []
  const state = { pending: null as PendingDevFolderMove | null }
  const relocateInputs: RelocateProjectInput[] = []

  // ── git: the linked worktrees each repository has registered, by the repository's folder name.
  // `path` is the repository's side of the link (where it expects the worktree), `repo` the
  // worktree's side (the repository its own `.git` file names). ──
  const registered = new Map<string, { path: string; locked: boolean; repo: string }[]>()
  const gitLoad = { inFlight: 0, most: 0 }

  // ── What the tests turn ──
  const behaviour = {
    /** What the probe of the n-th `busy()` reading answers, for every project. */
    busyByReading: [] as (string | null)[],
    /** What every probe answers for one project. */
    busyByProject: new Map<string, string>(),
    /** What the n-th `operationInProgress` call answers. */
    gitOperationByCall: [] as (string | null)[],
    gitOperationByRepo: new Map<string, string>(),
    /** Runs inside the n-th `operationInProgress` call (counted from 1). */
    onGitOperation: null as ((call: number) => void) | null,
    /** Repository folder names git cannot list. */
    unlistable: new Set<string>(),
    /** Worktree folder names `repair` exits 0 on without fixing them. */
    unrepairable: new Set<string>(),
    /** Worktree folder names whose registration is gone after `repair`. */
    lostOnRepair: new Set<string>(),
    /** Worktree folder names `repair` fixes on the repository's side only. */
    oneWay: new Set<string>(),
    /** `repair` does its work and then reports this error, as git does over one broken worktree. */
    repairComplaint: null as string | null,
    /** What `relocateProject` reports about tickets and runs; null leaves both out. */
    rewrittenIds: null as { ticketProjectIds: string[]; runIds: string[] } | null,
    /** Runs inside the probe of the n-th reading (counted from 1), before it answers. */
    onProbe: null as ((reading: number) => void) | null,
    /** Each git listing takes a turn of the event loop, to see how many run at once. */
    slowGit: false,
    scriptsRewritten: false,
    /** `relocateProject` commits and then hands back something that is not its result. */
    garbledRelocateResult: false,
    leftovers: new Map<string, LeftoverSource>(),
    onRelocatedWarnings: [] as string[],
    afterMoveWarnings: [] as string[],
    submoduleWarnings: [] as string[],
    syncResult: { success: true } as { success: boolean; error?: string },
    /** Runs inside `prepareMove`: for what happens while a move is being prepared. */
    onPrepare: null as ((from: string, to: string) => void) | null,
    /** Runs inside `discardSource`, before the old folder is removed. */
    onDiscard: null as ((from: string) => void) | null
  }

  // ── What the tests read back ──
  const seen = {
    relocated: [] as MovedProject[],
    afterMoved: [] as MovedProject[],
    published: [] as MovedProject[],
    probes: [] as { projectId: string; worktreeIds: string[]; movingPaths: string[] }[],
    /** The fourth argument of every probe call, in the order made. */
    probeOptions: [] as (BusyProbeOptions | undefined)[],
    logs: [] as { message: string; detail?: Record<string, unknown> }[],
    /** Registrations whose folder git could not find at the moment worktrees were synced. */
    brokenAtSync: [] as string[]
  }

  const swap = (relocations: readonly RelocationMove[], path: string): string | null => {
    for (const relocation of relocations) {
      for (const from of relocation.from) {
        if (under(from, path)) return `${relocation.to}${path.slice(from.length)}`
      }
    }
    return null
  }

  const listRegistered = (repoPath: string): LinkedWorktree[] =>
    (registered.get(basename(repoPath)) ?? []).map((entry) => ({
      path: entry.path,
      prunable: kindOf(entry.path) !== 'dir',
      locked: entry.locked
    }))

  const deps: MoveProjectsDeps = {
    db: {
      getProject: (id) => {
        tick('db.getProject')
        return projects.get(id) ?? null
      },
      getAllProjects: () => {
        tick('db.getAllProjects')
        return [...projects.values()]
      },
      getProjectByPath: (path) => {
        tick('db.getProjectByPath')
        return [...projects.values()].find((project) => project.path === path) ?? null
      },
      getWorktreesByProject: (projectId) => {
        tick('db.getWorktreesByProject')
        return worktrees.filter((row) => row.project_id === projectId).map((row) => ({ ...row }))
      },
      namesRegisteredInside: (spellings, exceptProjectId) => {
        tick('db.namesRegisteredInside')
        const inside = (path: string): boolean =>
          spellings.some((spelling) => path !== spelling && under(spelling, path))
        return [
          ...[...projects.values()]
            .filter((project) => project.id !== exceptProjectId && inside(project.path))
            .map((project) => project.name),
          ...worktrees
            .filter((row) => row.project_id !== exceptProjectId && inside(row.path))
            .map((row) => row.name)
        ]
      },
      relocateProject: (input) => {
        tick('db.relocateProject')
        calls.push(`db.relocateProject:${input.projectId}`)
        const project = projects.get(input.projectId)
        if (!project) throw new Error('the project is gone')
        if (project.path !== input.expectedPath) throw new Error('the project is somewhere else')
        const to = input.relocations[0].to
        if ([...projects.values()].some((other) => other.id !== project.id && other.path === to)) {
          throw new Error('another project is registered there')
        }
        const changed = worktrees
          .filter((row) => row.project_id === project.id)
          .flatMap((row) => {
            const next = swap(input.relocations, row.path)
            return next === null ? [] : [{ id: row.id, from: row.path, to: next }]
          })
        input.place()
        // Everything after `place` and before the commit: what a failed UPDATE looks like.
        tick('db.commit')
        const moved = { ...project, path: to }
        projects.set(project.id, moved)
        for (const change of changed) {
          const row = worktrees.find((candidate) => candidate.id === change.id)
          if (row) row.path = change.to
        }
        state.pending = input.pending
        relocateInputs.push(input)
        if (behaviour.garbledRelocateResult) return { project: moved } as never
        return {
          project: moved,
          worktrees: changed,
          ticketsRewritten: 2,
          runsRewritten: 1,
          scriptsRewritten: behaviour.scriptsRewritten,
          otherProjectIds: ['other'],
          dataProjectIds: ['data'],
          ...(behaviour.rewrittenIds ?? {})
        }
      },
      readPendingMove: () => {
        tick('db.readPendingMove')
        return state.pending
      },
      clearPendingMove: () => {
        calls.push('db.clearPendingMove')
        tick('db.clearPendingMove')
        state.pending = null
      }
    },
    fs: {
      kind: (path) => {
        tick('fs.kind')
        return kindOf(path)
      },
      canonical: (path) => {
        tick('fs.canonical')
        return canonicalOf(path)
      },
      sameFolder: (a, b) => {
        tick('fs.sameFolder')
        return (canonicalOf(a) ?? resolve(a)) === (canonicalOf(b) ?? resolve(b))
      },
      mkdirp: (dir) =>
        asyncPort('fs.mkdirp', () => {
          calls.push(`fs.mkdirp:${dir}`)
          addDir(dir)
        }),
      copies: () => {
        tick('fs.copies')
        return copied
      },
      prepareMove: (from, to) =>
        asyncPort('fs.prepareMove', () => {
          behaviour.onPrepare?.(from, to)
          calls.push(`fs.prepareMove:${from}->${to}`)
          const prepared: PreparedMove = {
            from,
            to,
            copied,
            place: () => {
              tick('place')
              if (kindOf(to) !== null) throw new Error(`something is already at ${to}`)
              calls.push(`place:${to}`)
              if (copied) copyTree(from, to)
              else renameTree(from, to)
            },
            undo: () => {
              calls.push(`undo:${to}`)
              tick('undo')
              if (copied) removeTree(to)
              else renameTree(to, from)
            },
            abort: () => {
              calls.push(`abort:${to}`)
              return asyncPort('abort', () => undefined)
            },
            discardSource: () =>
              asyncPort('discardSource', () => {
                calls.push(`discardSource:${from}`)
                behaviour.onDiscard?.(from)
                const left = behaviour.leftovers.get(from)
                if (left) return left
                if (copied) removeTree(from)
                return null
              })
          }
          return prepared
        })
    },
    git: {
      listLinkedWorktrees: (repoPath) =>
        asyncPort('git.listLinkedWorktrees', async () => {
          calls.push(`git.list:${repoPath}`)
          if (behaviour.slowGit) {
            gitLoad.inFlight += 1
            gitLoad.most = Math.max(gitLoad.most, gitLoad.inFlight)
            await new Promise((done) => setTimeout(done, 0))
            gitLoad.inFlight -= 1
          }
          return behaviour.unlistable.has(basename(repoPath)) ? null : listRegistered(repoPath)
        }),
      repairWorktrees: (repoPath, paths) =>
        asyncPort('git.repairWorktrees', () => {
          calls.push(`git.repair:${repoPath}<-${paths.join(',')}`)
          const entries = registered.get(basename(repoPath)) ?? []
          for (const path of paths) {
            const name = basename(path)
            const entry = entries.find((candidate) => basename(candidate.path) === name)
            if (!entry || behaviour.unrepairable.has(name)) continue
            entry.path = path
            if (!behaviour.oneWay.has(name)) entry.repo = repoPath
          }
          registered.set(
            basename(repoPath),
            entries.filter((entry) => !behaviour.lostOnRepair.has(basename(entry.path)))
          )
          if (behaviour.repairComplaint !== null) throw new Error(behaviour.repairComplaint)
        }),
      repairLinkedSubmodules: (repoPath, oldRepoPath) =>
        asyncPort('git.repairLinkedSubmodules', () => {
          calls.push(`git.submodules:${repoPath}<-${oldRepoPath}`)
          return behaviour.submoduleWarnings
        }),
      operationInProgress: (repoPath) => {
        tick('git.operationInProgress')
        calls.push(`git.operation:${repoPath}`)
        const call = (counts.get('git.operationInProgress') ?? 1) - 1
        behaviour.onGitOperation?.(call + 1)
        return (
          behaviour.gitOperationByCall[call] ?? behaviour.gitOperationByRepo.get(repoPath) ?? null
        )
      },
      linksBack: (repoPath, worktreePath) => {
        tick('git.linksBack')
        const entry = (registered.get(basename(repoPath)) ?? []).find(
          (candidate) => candidate.path === worktreePath
        )
        return entry !== undefined && entry.repo === repoPath
      }
    },
    folders: () => {
      tick('folders')
      return { devFolder, previousFolders }
    },
    homeDir: '/Users/me',
    busy: () =>
      asyncPort('busy', () => {
        calls.push('busy')
        const reading = (counts.get('busy') ?? 1) - 1
        return (project, rows, movingPaths, options) => {
          tick('probe')
          calls.push(`probe:${project.id}`)
          seen.probes.push({
            projectId: project.id,
            worktreeIds: rows.map((row) => row.id),
            movingPaths: [...movingPaths]
          })
          seen.probeOptions.push(options)
          behaviour.onProbe?.(reading + 1)
          return behaviour.busyByReading[reading] ?? behaviour.busyByProject.get(project.id) ?? null
        }
      }),
    beforeMove: (project) => {
      calls.push(`beforeMove:${project.id}`)
      return asyncPort('beforeMove', () => undefined)
    },
    afterAbort: (project) => {
      calls.push(`afterAbort:${project.id}`)
      return asyncPort('afterAbort', () => undefined)
    },
    onRelocated: (moved) => {
      tick('onRelocated')
      calls.push(`onRelocated:${moved.project.id}`)
      seen.relocated.push(moved)
      return behaviour.onRelocatedWarnings
    },
    syncWorktrees: (params) =>
      asyncPort('syncWorktrees', () => {
        calls.push(`syncWorktrees:${params.projectPath}`)
        seen.brokenAtSync.push(
          ...listRegistered(params.projectPath)
            .filter((worktree) => worktree.prunable)
            .map((worktree) => worktree.path)
        )
        return behaviour.syncResult
      }),
    afterMove: (moved) =>
      asyncPort('afterMove', () => {
        calls.push(`afterMove:${moved.project.id}`)
        seen.afterMoved.push(moved)
        return behaviour.afterMoveWarnings
      }),
    publishChanged: (moved) => {
      tick('publishChanged')
      calls.push(`publishChanged:${moved.project.id}`)
      seen.published.push(moved)
    },
    log: (message, detail) => {
      tick('log')
      seen.logs.push({ message, detail })
    }
  }

  return {
    deps,
    calls,
    counts,
    behaviour,
    seen,
    state,
    relocateInputs,
    gitLoad,
    links,
    addDir,
    addFile,
    copyTree,
    removeTree,
    renameTree,
    kind: kindOf,
    project: (id: string): Project | undefined => projects.get(id),
    worktreePaths: (projectId: string): Record<string, string> =>
      Object.fromEntries(
        worktrees.filter((row) => row.project_id === projectId).map((row) => [row.id, row.path])
      ),
    registeredPaths: (repoName: string): string[] =>
      (registered.get(repoName) ?? []).map((entry) => entry.path),
    /** Make the n-th call (or every call) of a port fail. */
    fail: (port: string, nth: number | 'always' = 'always', mode: FailMode = 'reject'): void => {
      failures.set(port, { nth, mode })
    },
    /** Forget the calls made so far (setup done through the ports). */
    forgetCalls: (): void => {
      calls.length = 0
      counts.clear()
    },
    /** A project row with its default worktree row, and its checkout on disk. */
    addProject: (
      id: string,
      path: string,
      extra: {
        readonly onDisk?: boolean
        readonly git?: 'dir' | 'file' | 'none'
        readonly row?: Partial<Project>
      } = {}
    ): void => {
      projects.set(id, projectRow(id, path, extra.row))
      worktrees.push(worktreeRow(`${id}-default`, id, path, { is_default: true }))
      if (extra.onDisk === false) return
      addDir(path)
      if (extra.git === 'file') addFile(`${path}/.git`)
      else if (extra.git !== 'none') addDir(`${path}/.git`)
    },
    /** A linked worktree of the project's repository: registered in git, on disk, with a row. */
    addLinkedWorktree: (
      projectId: string,
      path: string,
      extra: {
        readonly onDisk?: boolean
        readonly row?: boolean
        readonly rowPath?: string
        /** git keeps it registered while its folder is away (`git worktree lock`). */
        readonly locked?: boolean
      } = {}
    ): void => {
      const project = projects.get(projectId)
      if (!project) throw new Error(`no project ${projectId}`)
      const repoName = basename(project.path)
      registered.set(repoName, [
        ...(registered.get(repoName) ?? []),
        { path, locked: extra.locked === true, repo: realOf(project.path) }
      ])
      if (extra.onDisk !== false) {
        addDir(path)
        addFile(`${path}/.git`)
      }
      if (extra.row !== false) {
        worktrees.push(
          worktreeRow(`${projectId}-${basename(path)}`, projectId, extra.rowPath ?? path)
        )
      }
    }
  }
}

type World = ReturnType<typeof makeWorld>

/** The project `app` in /old: a worktree inside it, one next to it and one somewhere else. */
const worldWithWorktrees = (options: WorldOptions = {}): World => {
  const world = makeWorld(options)
  world.addProject('app', '/old/app')
  world.addLinkedWorktree('app', '/old/app/.claude/worktrees/inner')
  world.addLinkedWorktree('app', '/old/app-feature')
  world.addLinkedWorktree('app', '/wt/app/outer')
  return world
}

const move = (
  world: World,
  projectId = 'app',
  expectedToPath = '/dev/app'
): Promise<DevFolderMoveResult> => moveProjectToDevFolder({ projectId, expectedToPath }, world.deps)

/** The plan row, the count and the move all give the same reason, and none of them touches anything. */
const expectStaticSkip = async (
  world: World,
  reason: DevFolderMoveSkipReason,
  detail: RegExp
): Promise<void> => {
  const plan = await planDevFolderMove(world.deps)
  const row = plan.candidates.find((candidate) => candidate.projectId === 'app')
  expect(row).toMatchObject({ skipReason: reason, detail: expect.stringMatching(detail) })
  expect(countLeftBehind(world.deps)).toEqual({ count: 0, folders: [] })

  const result = await move(world, 'app', row?.toPath)
  expect(result).toEqual({
    projectId: 'app',
    projectName: 'app',
    action: 'skipped',
    fromPath: '/old/app',
    toPath: row?.toPath,
    skipReason: reason,
    detail: row?.detail,
    warnings: [],
    movedPaths: []
  })
  // No git, no reading of what is running, nothing stopped, nothing prepared.
  expect(world.calls).toEqual([])
}

describe('which projects are offered', () => {
  it('offers the projects that sit directly in a folder used before, and no others', async () => {
    const world = makeWorld({ previousFolders: ['/older', '/old'] })
    world.addProject('elsewhere', '/code/elsewhere')
    world.addProject('here', '/dev/here')
    world.addProject('deep', '/old/group/deep')
    world.addProject('conn', '/old/conn', { row: { kind: 'connection' } })
    world.addProject('app', '/old/app', { row: { name: 'The App' } })
    world.addProject('ancient', '/older/ancient')

    const plan = await planDevFolderMove(world.deps)

    expect(plan).toEqual({
      devFolder: '/dev',
      sources: ['/older', '/old'],
      candidates: [
        {
          projectId: 'app',
          projectName: 'The App',
          source: '/old',
          fromPath: '/old/app',
          toPath: '/dev/app',
          skipReason: null,
          detail: null
        },
        {
          projectId: 'ancient',
          projectName: 'ancient',
          source: '/older',
          fromPath: '/older/ancient',
          toPath: '/dev/ancient',
          skipReason: null,
          detail: null
        }
      ]
    })
    expect(countLeftBehind(world.deps)).toEqual({ count: 2, folders: ['/older', '/old'] })
  })

  it('answers "not in a folder used before" when asked to move a project that is not offered', async () => {
    const world = makeWorld()
    world.addProject('elsewhere', '/code/elsewhere')
    world.addProject('here', '/dev/here')
    world.addProject('conn', '/old/conn', { row: { kind: 'connection' } })

    for (const id of ['elsewhere', 'here', 'conn']) {
      expect(await move(world, id, `/dev/${id}`)).toMatchObject({
        projectId: id,
        action: 'skipped',
        skipReason: 'not-in-source',
        toPath: null,
        movedPaths: []
      })
    }
    expect(await move(world, 'nobody', '/dev/nobody')).toMatchObject({
      projectId: 'nobody',
      projectName: '',
      fromPath: '',
      action: 'skipped',
      skipReason: 'not-in-source'
    })
    expect(world.calls).toEqual([])
  })

  it('tells folders apart by what they are, not by how they are spelled', async () => {
    // The row holds the path through a symlink; the folder used before is stored by real path,
    // and the dev folder is reached through a symlink too.
    const world = makeWorld({ devFolder: '/devlink', devFolderOnDisk: false })
    world.addDir('/volumes/dev')
    world.links.set('/devlink', '/volumes/dev')
    world.links.set('/link', '/old')
    world.addProject('app', '/link/app')
    world.addProject('here', '/volumes/dev/here')

    const plan = await planDevFolderMove(world.deps)

    expect(plan.candidates).toEqual([
      expect.objectContaining({
        projectId: 'app',
        source: '/old',
        fromPath: '/link/app',
        toPath: '/volumes/dev/app',
        skipReason: null
      })
    ])
  })

  it('leaves a project whose folder is not on disk', async () => {
    const world = makeWorld()
    world.addProject('app', '/old/app', { onDisk: false })
    await expectStaticSkip(world, 'missing', /not on disk/)
  })

  it('leaves a project registered through a symbolic link', async () => {
    const world = makeWorld()
    world.addProject('app', '/old/app', { onDisk: false })
    world.addDir('/real/app/.git')
    world.links.set('/old/app', '/real/app')
    await expectStaticSkip(world, 'unsupported', /symbolic link/)
  })

  it('leaves a project whose path is a file', async () => {
    const world = makeWorld()
    world.addProject('app', '/old/app', { onDisk: false })
    world.addFile('/old/app')
    await expectStaticSkip(world, 'unsupported', /not a folder/)
  })

  it('leaves a checkout that is itself a linked worktree or a submodule', async () => {
    const world = makeWorld()
    world.addProject('app', '/old/app', { git: 'file' })
    await expectStaticSkip(world, 'unsupported', /linked worktree or a submodule/)
  })

  it('leaves a checkout whose .git is a symbolic link', async () => {
    const world = makeWorld()
    world.addProject('app', '/old/app', { git: 'none' })
    world.addDir('/repositories/app.git')
    world.links.set('/old/app/.git', '/repositories/app.git')
    await expectStaticSkip(world, 'unsupported', /\.git is not a plain folder/)
  })

  it('leaves a project that holds the dev folder', async () => {
    const inside = makeWorld({ devFolder: '/old/app/projects' })
    inside.addProject('app', '/old/app')
    await expectStaticSkip(
      inside,
      'unsupported',
      /dev folder is this project's folder or inside it/
    )

    const same = makeWorld({ devFolder: '/old/app', devFolderOnDisk: false })
    same.addProject('app', '/old/app')
    await expectStaticSkip(same, 'unsupported', /dev folder is this project's folder or inside it/)
  })

  it('sees a dev folder that is still to be created inside a project through a symlink', async () => {
    const world = makeWorld({ devFolder: '/shortcut/projects', devFolderOnDisk: false })
    world.addProject('app', '/old/app')
    world.links.set('/shortcut', '/old/app')
    await expectStaticSkip(world, 'unsupported', /dev folder is this project's folder or inside it/)
  })

  it('leaves a project with another project registered inside it', async () => {
    const world = makeWorld()
    world.addProject('app', '/old/app')
    world.addProject('inner', '/old/app/packages/inner', { row: { name: 'Inner Tool' } })
    await expectStaticSkip(world, 'unsupported', /Inner Tool/)
  })

  it('leaves a project whose name is taken in the dev folder, on disk or by a project row', async () => {
    const onDisk = makeWorld()
    onDisk.addProject('app', '/old/app')
    onDisk.addDir('/dev/app')
    await expectStaticSkip(onDisk, 'exists', /already has a folder named app/)

    const asRow = makeWorld()
    asRow.addProject('app', '/old/app')
    asRow.addProject('twin', '/dev/app', { onDisk: false })
    await expectStaticSkip(asRow, 'exists', /already registered at \/dev\/app/)
  })
})

describe('countLeftBehind', () => {
  it('counts what would move and names the folders it would move from, most recent first', () => {
    const world = makeWorld({ previousFolders: ['/older', '/old', '/empty'] })
    world.addDir('/empty')
    world.addProject('a', '/old/a')
    world.addProject('b', '/old/b')
    world.addProject('gone', '/old/gone', { onDisk: false })
    world.addProject('taken', '/older/taken')
    world.addDir('/dev/taken')
    world.addProject('c', '/older/c')
    world.addLinkedWorktree('a', '/old/a-feature')

    expect(countLeftBehind(world.deps)).toEqual({ count: 3, folders: ['/older', '/old'] })
    // Cheap: no git, no look at what is running.
    expect(world.calls).toEqual([])
  })

  it('does not read the projects when no folder was used before', () => {
    const world = makeWorld({ previousFolders: [] })
    world.addProject('a', '/old/a')

    expect(countLeftBehind(world.deps)).toEqual({ count: 0, folders: [] })
    expect(world.counts.get('db.getAllProjects')).toBeUndefined()
  })

  it('leaves out a project that cannot be checked', () => {
    const world = makeWorld()
    world.addProject('a', '/old/a')
    world.addProject('b', '/old/b')
    world.fail('db.namesRegisteredInside', 1)

    expect(countLeftBehind(world.deps)).toEqual({ count: 1, folders: ['/old'] })
  })
})

describe('planDevFolderMove', () => {
  it('takes one reading of what is running for the whole plan, and asks git only about what would move', async () => {
    const world = makeWorld()
    world.addProject('a', '/old/a')
    world.addProject('gone', '/old/gone', { onDisk: false })
    world.addProject('b', '/old/b')
    world.addProject('plain', '/old/plain', { git: 'none' })
    world.behaviour.busyByProject.set(
      'b',
      'A session is working in this project. Stop it, then check again.'
    )

    const plan = await planDevFolderMove(world.deps)

    expect(world.calls).toEqual([
      'git.list:/old/a',
      'git.list:/old/b',
      'busy',
      'probe:a',
      'git.operation:/old/a',
      'probe:b',
      'probe:plain',
      'git.operation:/old/plain'
    ])
    expect(plan.candidates.map((row) => [row.projectId, row.skipReason, row.detail])).toEqual([
      ['a', null, null],
      ['gone', 'missing', expect.any(String)],
      ['b', 'busy', 'A session is working in this project. Stop it, then check again.'],
      ['plain', null, null]
    ])
  })

  it('takes no reading at all when nothing would move', async () => {
    const world = makeWorld()
    world.addProject('gone', '/old/gone', { onDisk: false })

    const plan = await planDevFolderMove(world.deps)

    expect(plan.candidates).toHaveLength(1)
    expect(world.calls).toEqual([])
  })

  it('reports a git operation in progress as busy, in a sentence', async () => {
    const world = makeWorld()
    world.addProject('a', '/old/a')
    world.addProject('b', '/old/b')
    world.behaviour.gitOperationByRepo.set('/old/a', 'a rebase')
    world.behaviour.gitOperationByRepo.set('/old/b', 'another git command')

    const plan = await planDevFolderMove(world.deps)

    expect(plan.candidates.map((row) => [row.skipReason, row.detail])).toEqual([
      [
        'busy',
        expect.stringMatching(/^A rebase is in progress in this project\. .*check again\.$/)
      ],
      ['busy', expect.stringMatching(/^Another git command is in progress in this project\. /)]
    ])
  })

  it('reports a project whose worktrees git cannot list as unsupported', async () => {
    const world = makeWorld()
    world.addProject('a', '/old/a')
    world.addProject('b', '/old/b')
    world.addProject('c', '/old/c')
    world.behaviour.unlistable.add('a')
    world.fail('git.listLinkedWorktrees', 2)

    const plan = await planDevFolderMove(world.deps)

    expect(plan.candidates.map((row) => [row.projectId, row.skipReason])).toEqual([
      ['a', 'unsupported'],
      ['b', 'unsupported'],
      ['c', null]
    ])
    expect(plan.candidates[0].detail).toMatch(/could not list this repository's worktrees/)
    // Only the project that can move is asked about.
    expect(world.seen.probes.map((probe) => probe.projectId)).toEqual(['c'])
  })

  it('runs at most eight git listings at once', async () => {
    const world = makeWorld()
    for (let index = 0; index < 30; index += 1) world.addProject(`p${index}`, `/old/p${index}`)
    world.behaviour.slowGit = true

    const plan = await planDevFolderMove(world.deps)

    expect(plan.candidates).toHaveLength(30)
    expect(plan.candidates.every((row) => row.skipReason === null)).toBe(true)
    expect(world.gitLoad.most).toBe(8)
    expect(world.counts.get('busy')).toBe(1)
  })

  it('asks about every directory that would move, in every spelling', async () => {
    const world = makeWorld()
    world.links.set('/link', '/old')
    world.addProject('app', '/link/app')
    world.addLinkedWorktree('app', '/old/app/.claude/worktrees/inner')
    world.addLinkedWorktree('app', '/old/app-feature')
    world.addLinkedWorktree('app', '/wt/app/outer')

    await planDevFolderMove(world.deps)

    expect(world.seen.probes).toEqual([
      {
        projectId: 'app',
        worktreeIds: ['app-default', 'app-inner', 'app-app-feature', 'app-outer'],
        movingPaths: ['/link/app', '/old/app', '/link/app-feature', '/old/app-feature']
      }
    ])
  })

  it('tells the reading whether the old folders would be copied and removed', async () => {
    const renamed = worldWithWorktrees()
    await planDevFolderMove(renamed.deps)
    expect(renamed.seen.probeOptions).toEqual([{ copies: false }])

    const copied = worldWithWorktrees({ otherVolume: true })
    await planDevFolderMove(copied.deps)
    expect(copied.seen.probeOptions).toEqual([{ copies: true }])

    // The dev folder need not be on disk for that: the filesystem is asked all the same.
    const toCreate = makeWorld({ devFolder: '/volumes/usb/dev', devFolderOnDisk: false })
    toCreate.addProject('app', '/old/app')
    toCreate.addLinkedWorktree('app', '/old/app-feature')
    const asked: string[] = []
    await planDevFolderMove({
      ...toCreate.deps,
      fs: {
        ...toCreate.deps.fs,
        copies: (from, to) => {
          asked.push(`${from}->${to}`)
          return from === '/old/app-feature'
        }
      }
    })
    expect(asked).toEqual([
      '/old/app->/volumes/usb/dev/app',
      '/old/app-feature->/volumes/usb/dev/app-feature'
    ])
    expect(toCreate.seen.probeOptions).toEqual([{ copies: true }])
  })

  it('holds no project back over the note of a move whose folder is in place', async () => {
    // What the note of a move that is running right now looks like: a plan is not made to wait
    // for it, and does none of its steps.
    const world = interruptedWorld()
    world.addProject('b', '/old/b')

    const plan = await planDevFolderMove(world.deps)

    expect(plan.candidates).toEqual([
      expect.objectContaining({ projectId: 'b', skipReason: null, detail: null })
    ])
    expect(world.calls).not.toContain('onRelocated:app')
    expect(world.state.pending).toMatchObject({ projectId: 'app' })
  })

  it('reports busy when what is running cannot be read', async () => {
    const reading = makeWorld()
    reading.addProject('a', '/old/a')
    reading.fail('busy')
    expect((await planDevFolderMove(reading.deps)).candidates[0]).toMatchObject({
      skipReason: 'busy',
      detail: expect.stringMatching(/Could not check/)
    })

    const probing = makeWorld()
    probing.addProject('a', '/old/a')
    probing.addProject('b', '/old/b')
    probing.fail('probe', 1)
    expect((await planDevFolderMove(probing.deps)).candidates.map((row) => row.skipReason)).toEqual(
      ['busy', null]
    )
  })

  it('rejects only when the folders or the project rows cannot be read', async () => {
    const ports = [
      'db.getProjectByPath',
      'db.getWorktreesByProject',
      'db.namesRegisteredInside',
      'db.readPendingMove',
      'fs.kind',
      'fs.canonical',
      'fs.sameFolder',
      'fs.copies',
      'git.listLinkedWorktrees',
      'git.operationInProgress',
      'busy',
      'probe',
      'log'
    ]
    for (const port of ports) {
      for (const mode of ['reject', 'throw'] as const) {
        const world = worldWithWorktrees()
        world.addProject('b', '/old/b')
        world.fail(port, 'always', mode)
        const plan = await planDevFolderMove(world.deps).catch((error: unknown) => error)
        expect(plan, `${port} (${mode})`).toMatchObject({ devFolder: '/dev' })
      }
    }

    for (const port of ['folders', 'db.getAllProjects']) {
      const world = worldWithWorktrees()
      world.fail(port)
      await expect(planDevFolderMove(world.deps)).rejects.toThrow(`${port} failed`)
    }
  })

  it('lists a project that cannot be checked, with the reason', async () => {
    const world = makeWorld()
    world.addProject('a', '/old/a')
    world.addProject('b', '/old/b')
    world.fail('db.namesRegisteredInside', 1)

    const plan = await planDevFolderMove(world.deps)

    expect(plan.candidates.map((row) => [row.projectId, row.skipReason])).toEqual([
      ['a', 'unsupported'],
      ['b', null]
    ])
    expect(plan.candidates[0].detail).toMatch(
      /could not be checked: db\.namesRegisteredInside failed/
    )
  })
})

describe('moveProjectToDevFolder: what stops it before anything changes', () => {
  it('refuses when the destination is not the one the person confirmed', async () => {
    const world = makeWorld()
    world.addProject('app', '/old/app')

    const result = await move(world, 'app', '/somewhere-else/app')

    expect(result).toEqual({
      projectId: 'app',
      projectName: 'app',
      action: 'skipped',
      fromPath: '/old/app',
      toPath: '/dev/app',
      skipReason: 'not-in-source',
      detail: 'The dev folder changed since this list was made. Check again.',
      warnings: [],
      movedPaths: []
    })
    expect(world.calls).toEqual([])
  })

  it('refuses a repository whose worktrees git cannot list', async () => {
    const world = makeWorld()
    world.addProject('app', '/old/app')
    world.behaviour.unlistable.add('app')

    const result = await move(world)

    expect(result).toMatchObject({
      action: 'skipped',
      skipReason: 'unsupported',
      toPath: '/dev/app'
    })
    expect(result.detail).toMatch(/could not list this repository's worktrees/)
    expect(world.calls).toEqual(['git.list:/old/app'])

    const rejecting = makeWorld()
    rejecting.addProject('app', '/old/app')
    rejecting.fail('git.listLinkedWorktrees')
    expect(await move(rejecting)).toEqual(result)
    expect(rejecting.calls).toEqual([])
  })

  it('refuses while something is running in the project, before stopping anything', async () => {
    const world = worldWithWorktrees()
    world.behaviour.busyByReading = [
      'A terminal in this project is running a command. Stop it, then check again.'
    ]

    const result = await move(world)

    expect(result).toMatchObject({
      action: 'skipped',
      skipReason: 'busy',
      detail: 'A terminal in this project is running a command. Stop it, then check again.',
      toPath: '/dev/app',
      movedPaths: []
    })
    expect(world.calls).toEqual(['git.list:/old/app', 'busy', 'probe:app'])
    expect(world.seen.probes[0]).toEqual({
      projectId: 'app',
      worktreeIds: ['app-default', 'app-inner', 'app-app-feature', 'app-outer'],
      movingPaths: ['/old/app', '/old/app-feature']
    })
  })

  it('refuses while git is in the middle of something', async () => {
    const world = makeWorld()
    world.addProject('app', '/old/app')
    world.behaviour.gitOperationByCall = ['a merge']

    const result = await move(world)

    expect(result).toMatchObject({
      action: 'skipped',
      skipReason: 'busy',
      detail:
        'A merge is in progress in this project. Finish it or wait for it to end, then check again.'
    })
    expect(world.calls).toEqual([
      'git.list:/old/app',
      'busy',
      'probe:app',
      'git.operation:/old/app'
    ])
  })
})

describe('moveProjectToDevFolder: the move', () => {
  it('runs the steps in the one order that is safe', async () => {
    const world = worldWithWorktrees()

    const result = await move(world)

    expect(world.calls).toEqual([
      'git.list:/old/app',
      'busy',
      'probe:app',
      'git.operation:/old/app',
      'beforeMove:app',
      'fs.mkdirp:/dev',
      'fs.prepareMove:/old/app->/dev/app',
      'fs.prepareMove:/old/app-feature->/dev/app-feature',
      // One more reading of what is running, then the check inside the block.
      'busy',
      'probe:app',
      'git.operation:/old/app',
      'git.operation:/old/app',
      'db.relocateProject:app',
      'place:/dev/app',
      'place:/dev/app-feature',
      'onRelocated:app',
      'git.repair:/dev/app<-/dev/app/.claude/worktrees/inner,/dev/app-feature,/wt/app/outer',
      'git.list:/dev/app',
      'git.submodules:/dev/app<-/old/app',
      'syncWorktrees:/dev/app',
      'afterMove:app',
      'publishChanged:app',
      'discardSource:/old/app',
      'discardSource:/old/app-feature',
      // Last: until here a quit leaves the note that says what is owed.
      'db.clearPendingMove'
    ])
    expect(result).toEqual({
      projectId: 'app',
      projectName: 'app',
      action: 'moved',
      fromPath: '/old/app',
      toPath: '/dev/app',
      skipReason: null,
      detail: null,
      warnings: [],
      movedPaths: [
        { from: '/old/app', to: '/dev/app' },
        { from: '/old/app/.claude/worktrees/inner', to: '/dev/app/.claude/worktrees/inner' },
        { from: '/old/app-feature', to: '/dev/app-feature' }
      ]
    })
  })

  it('lets nothing else run between its last check and the folders, rows and caches changing place', async () => {
    for (const otherVolume of [false, true]) {
      const world = worldWithWorktrees({ otherVolume })
      world.behaviour.onGitOperation = (call) => {
        // The third call is the check inside the block: one for each reading of what is
        // running comes before it. What is queued here runs at the first chance the service
        // gives anything else.
        if (call === 3) queueMicrotask(() => world.calls.push('something else ran'))
      }

      expect((await move(world)).action).toBe('moved')

      const ranAt = world.calls.indexOf('something else ran')
      expect(ranAt).toBeGreaterThan(world.calls.indexOf('onRelocated:app'))
      expect(world.calls.slice(world.calls.lastIndexOf('git.operation:/old/app'), ranAt)).toEqual([
        'git.operation:/old/app',
        'db.relocateProject:app',
        'place:/dev/app',
        'place:/dev/app-feature',
        'onRelocated:app',
        // Called before the service first waits again.
        'git.repair:/dev/app<-/dev/app/.claude/worktrees/inner,/dev/app-feature,/wt/app/outer'
      ])
    }
  })

  it('puts the folders back before anything else can run', async () => {
    const world = worldWithWorktrees()
    world.fail('db.commit')
    world.behaviour.onGitOperation = (call) => {
      if (call === 3) queueMicrotask(() => world.calls.push('something else ran'))
    }

    expect((await move(world)).action).toBe('failed')

    const ranAt = world.calls.indexOf('something else ran')
    expect(world.calls.slice(world.calls.indexOf('db.relocateProject:app'), ranAt)).toEqual([
      'db.relocateProject:app',
      'place:/dev/app',
      'place:/dev/app-feature',
      'undo:/dev/app-feature',
      'undo:/dev/app',
      // Called before the service first waits again.
      'abort:/dev/app'
    ])
  })

  it('leaves the disk, the rows and git agreeing on the new place', async () => {
    const world = worldWithWorktrees()

    await move(world)

    expect(world.kind('/old/app')).toBeNull()
    expect(world.kind('/old/app-feature')).toBeNull()
    expect(world.kind('/dev/app/.git')).toBe('dir')
    expect(world.kind('/dev/app/.claude/worktrees/inner/.git')).toBe('file')
    expect(world.kind('/dev/app-feature/.git')).toBe('file')
    expect(world.kind('/wt/app/outer')).toBe('dir')
    expect(world.project('app')?.path).toBe('/dev/app')
    expect(world.worktreePaths('app')).toEqual({
      'app-default': '/dev/app',
      'app-inner': '/dev/app/.claude/worktrees/inner',
      'app-app-feature': '/dev/app-feature',
      'app-outer': '/wt/app/outer'
    })
    expect(world.registeredPaths('app')).toEqual([
      '/dev/app/.claude/worktrees/inner',
      '/dev/app-feature',
      '/wt/app/outer'
    ])
    expect(world.seen.brokenAtSync).toEqual([])
    expect(world.state.pending).toBeNull()
  })

  it('hands the database every spelling of what moves, and the note for an interrupted move', async () => {
    const world = worldWithWorktrees()

    await move(world)

    const relocations = [
      { from: ['/old/app'], to: '/dev/app' },
      { from: ['/old/app-feature'], to: '/dev/app-feature' }
    ]
    expect(world.relocateInputs).toHaveLength(1)
    expect(world.relocateInputs[0]).toMatchObject({
      projectId: 'app',
      expectedPath: '/old/app',
      relocations,
      homeDir: '/Users/me',
      pending: {
        projectId: 'app',
        fromPath: '/old/app',
        fromRealPath: '/old/app',
        toPath: '/dev/app',
        relocations
      }
    })
  })

  it('tells the follow-up steps what moved', async () => {
    const world = worldWithWorktrees()

    await move(world)

    expect(world.seen.relocated).toHaveLength(1)
    const moved = world.seen.relocated[0]
    expect(moved).toMatchObject({
      project: { id: 'app', path: '/dev/app' },
      fromPath: '/old/app',
      fromRealPath: '/old/app',
      toPath: '/dev/app',
      relocations: [
        { from: ['/old/app'], to: '/dev/app' },
        { from: ['/old/app-feature'], to: '/dev/app-feature' }
      ],
      ticketsRewritten: 2,
      runsRewritten: 1,
      otherProjectIds: ['other'],
      dataProjectIds: ['data']
    })
    expect(moved.moves).toEqual([
      { from: '/old/app', to: '/dev/app' },
      { from: '/old/app-feature', to: '/dev/app-feature' },
      { from: '/old/app/.claude/worktrees/inner', to: '/dev/app/.claude/worktrees/inner' }
    ])
    expect(moved.worktrees.map((row) => row.id)).toEqual([
      'app-default',
      'app-inner',
      'app-app-feature'
    ])
    expect(moved.allWorktrees.map((row) => row.path)).toEqual([
      '/dev/app',
      '/dev/app/.claude/worktrees/inner',
      '/dev/app-feature',
      '/wt/app/outer'
    ])
    // The same object goes to every follow-up step.
    expect(world.seen.afterMoved[0]).toBe(moved)
    expect(world.seen.published[0]).toBe(moved)
  })

  it('passes on which projects had a ticket rewritten and which runs changed', async () => {
    const world = worldWithWorktrees()
    world.behaviour.rewrittenIds = { ticketProjectIds: ['app', 'conn'], runIds: ['run-1'] }

    const told = await move(world)

    expect(world.seen.relocated[0]).toMatchObject({
      ticketProjectIds: ['app', 'conn'],
      runIds: ['run-1']
    })
    expect(world.seen.published[0].runIds).toEqual(['run-1'])
    // The window that asked hears no event of its own move: the answer tells it which
    // boards to reload before the next project starts.
    expect(told.boardProjectIds).toEqual(['app', 'conn'])

    // A database that does not report them: "not reported" is not turned into "none".
    const silent = worldWithWorktrees()
    const untold = await move(silent)
    expect('ticketProjectIds' in silent.seen.relocated[0]).toBe(false)
    expect('runIds' in silent.seen.relocated[0]).toBe(false)
    expect('boardProjectIds' in untold).toBe(false)
  })

  it('tells both readings whether the old folders are copied and removed', async () => {
    const renamed = worldWithWorktrees()
    await move(renamed)
    expect(renamed.seen.probeOptions).toEqual([{ copies: false }, { copies: false }])

    const copied = worldWithWorktrees({ otherVolume: true })
    await move(copied)
    expect(copied.seen.probeOptions).toEqual([{ copies: true }, { copies: true }])
  })

  it('asks the filesystem before anything is prepared, and goes by what was prepared after', async () => {
    // One folder of the two would be copied: that is enough for the first reading.
    const world = worldWithWorktrees()
    const asked: string[] = []
    await moveProjectToDevFolder(
      { projectId: 'app', expectedToPath: '/dev/app' },
      {
        ...world.deps,
        fs: {
          ...world.deps.fs,
          copies: (from, to) => {
            asked.push(`${from}->${to}`)
            return from === '/old/app-feature'
          }
        }
      }
    )
    expect(asked).toEqual(['/old/app->/dev/app', '/old/app-feature->/dev/app-feature'])
    // Asked before the reading it is for, and before anything was stopped or prepared.
    expect(world.calls.indexOf('busy')).toBeLessThan(world.calls.indexOf('beforeMove:app'))
    // Nothing was copied in the end (this disk renames): the second reading says so.
    expect(world.seen.probeOptions).toEqual([{ copies: true }, { copies: false }])

    // A filesystem port that cannot tell is taken to rename, until the folders were prepared.
    const untold = worldWithWorktrees({ otherVolume: true })
    await moveProjectToDevFolder(
      { projectId: 'app', expectedToPath: '/dev/app' },
      { ...untold.deps, fs: { ...untold.deps.fs, copies: undefined } }
    )
    expect(untold.seen.probeOptions).toEqual([{ copies: false }, { copies: true }])
  })

  it('moves a project stored through a symlink under both spellings, and reports the stored ones', async () => {
    const world = makeWorld()
    world.links.set('/link', '/old')
    world.addProject('app', '/link/app')
    // git reports real paths; rows imported from its listing hold them.
    world.addLinkedWorktree('app', '/old/app/.claude/worktrees/inner')
    world.addLinkedWorktree('app', '/old/app-feature', { rowPath: '/link/app-feature' })

    const result = await move(world)

    expect(result.action).toBe('moved')
    expect(world.relocateInputs[0].relocations).toEqual([
      { from: ['/link/app', '/old/app'], to: '/dev/app' },
      { from: ['/link/app-feature', '/old/app-feature'], to: '/dev/app-feature' }
    ])
    expect(world.relocateInputs[0].pending.fromRealPath).toBe('/old/app')
    expect(world.calls).toContain('fs.prepareMove:/link/app->/dev/app')
    expect(world.calls).toContain('git.submodules:/dev/app<-/old/app')
    expect(world.seen.relocated[0].moves).toEqual([
      { from: '/link/app', to: '/dev/app' },
      { from: '/old/app', to: '/dev/app' },
      { from: '/link/app-feature', to: '/dev/app-feature' },
      { from: '/old/app-feature', to: '/dev/app-feature' },
      { from: '/link/app/.claude/worktrees/inner', to: '/dev/app/.claude/worktrees/inner' },
      { from: '/old/app/.claude/worktrees/inner', to: '/dev/app/.claude/worktrees/inner' }
    ])
    // The window holds the database's spellings, never git's.
    expect(result.movedPaths).toEqual([
      { from: '/link/app', to: '/dev/app' },
      { from: '/old/app/.claude/worktrees/inner', to: '/dev/app/.claude/worktrees/inner' },
      { from: '/link/app-feature', to: '/dev/app-feature' }
    ])
    expect(world.kind('/dev/app/.claude/worktrees/inner')).toBe('dir')
    expect(world.kind('/old/app')).toBeNull()
  })

  it('stores the real path of a dev folder that the move itself created', async () => {
    const world = makeWorld({ devFolder: '/short/dev', devFolderOnDisk: false })
    world.addDir('/volumes/data')
    world.links.set('/short', '/volumes/data')
    world.addProject('app', '/old/app')

    const plan = await planDevFolderMove(world.deps)
    expect(plan.candidates[0].toPath).toBe('/short/dev/app')
    const result = await move(world, 'app', '/short/dev/app')

    expect(result).toMatchObject({ action: 'moved', toPath: '/volumes/data/dev/app' })
    expect(result.movedPaths[0]).toEqual({ from: '/old/app', to: '/volumes/data/dev/app' })
    expect(world.calls).toContain('fs.mkdirp:/short/dev')
    expect(world.project('app')?.path).toBe('/volumes/data/dev/app')
  })

  it('moves the next project of a plan that was made before the first move created the dev folder', async () => {
    const world = makeWorld({ devFolder: '/short/dev', devFolderOnDisk: false })
    world.addDir('/volumes/data')
    world.links.set('/short', '/volumes/data')
    world.addProject('app', '/old/app')
    world.addProject('api', '/old/api')

    // One plan, then one move per row of it: the window sends each row's `toPath` as it was
    // planned, while the folder still had no real path of its own.
    const plan = await planDevFolderMove(world.deps)
    expect(plan.candidates.map((candidate) => candidate.toPath)).toEqual([
      '/short/dev/app',
      '/short/dev/api'
    ])
    expect(await move(world, 'app', '/short/dev/app')).toMatchObject({ action: 'moved' })
    const second = await move(world, 'api', '/short/dev/api')

    expect(second).toMatchObject({ action: 'moved', toPath: '/volumes/data/dev/api' })
    expect(world.project('api')?.path).toBe('/volumes/data/dev/api')

    // A destination in another folder is still refused, whichever way that folder is spelled.
    world.addProject('web', '/old/web')
    expect(await move(world, 'web', '/volumes/elsewhere/web')).toMatchObject({
      action: 'skipped',
      skipReason: 'not-in-source',
      detail: 'The dev folder changed since this list was made. Check again.'
    })
  })

  it('moves a folder without a repository and leaves git out of it', async () => {
    const world = makeWorld()
    world.addProject('plain', '/old/plain', { git: 'none' })

    const result = await move(world, 'plain', '/dev/plain')

    expect(result).toMatchObject({ action: 'moved', warnings: [] })
    expect(world.calls).toEqual([
      'busy',
      'probe:plain',
      'git.operation:/old/plain',
      'beforeMove:plain',
      'fs.mkdirp:/dev',
      'fs.prepareMove:/old/plain->/dev/plain',
      'busy',
      'probe:plain',
      'git.operation:/old/plain',
      'git.operation:/old/plain',
      'db.relocateProject:plain',
      'place:/dev/plain',
      'onRelocated:plain',
      'afterMove:plain',
      'publishChanged:plain',
      'discardSource:/old/plain',
      'db.clearPendingMove'
    ])
  })

  it('does not reconcile the rows of a repository without linked worktrees', async () => {
    const world = makeWorld()
    world.addProject('app', '/old/app')

    const result = await move(world)

    // Its one row went with the project, and git has no worktree the move could have put out
    // of step. Most projects are like this one, and reconciling is the slowest step of a move.
    expect(result).toMatchObject({ action: 'moved', toPath: '/dev/app', warnings: [] })
    expect(
      world.calls.filter((call) => call.startsWith('git.') || call.startsWith('sync'))
    ).toEqual([
      'git.list:/old/app',
      'git.operation:/old/app',
      'git.operation:/old/app',
      'git.operation:/old/app',
      'git.submodules:/dev/app<-/old/app'
    ])
  })
})

describe('moveProjectToDevFolder: worktrees next to the checkout', () => {
  it('leaves a sibling whose name is taken in the dev folder, says so, and still repairs it', async () => {
    const world = worldWithWorktrees()
    world.addDir('/dev/app-feature')

    const result = await move(world)

    expect(result.action).toBe('moved')
    expect(result.warnings).toEqual([
      expect.stringMatching(
        /^The worktree app-feature stayed in \/old: .*already has a folder named app-feature/
      )
    ])
    expect(world.relocateInputs[0].relocations).toEqual([{ from: ['/old/app'], to: '/dev/app' }])
    expect(world.calls).toContain(
      'git.repair:/dev/app<-/dev/app/.claude/worktrees/inner,/old/app-feature,/wt/app/outer'
    )
    expect(world.kind('/old/app-feature')).toBe('dir')
    expect(world.worktreePaths('app')['app-app-feature']).toBe('/old/app-feature')
    expect(result.movedPaths).toEqual([
      { from: '/old/app', to: '/dev/app' },
      { from: '/old/app/.claude/worktrees/inner', to: '/dev/app/.claude/worktrees/inner' }
    ])
    expect(world.calls).toContain('syncWorktrees:/dev/app')
  })

  it('leaves a sibling that is registered as a project of its own', async () => {
    const world = worldWithWorktrees()
    world.addProject('feature', '/old/app-feature', { git: 'file' })

    const result = await move(world)

    expect(result.action).toBe('moved')
    expect(result.warnings).toEqual([
      expect.stringMatching(/app-feature stayed in \/old: .*project of its own/)
    ])
    expect(world.project('feature')?.path).toBe('/old/app-feature')
    expect(world.kind('/old/app-feature')).toBe('dir')
  })

  it('does not take along a sibling that is not on disk, nor hand it to git repair', async () => {
    const world = makeWorld()
    world.addProject('app', '/old/app')
    world.addLinkedWorktree('app', '/old/app-stale', { onDisk: false })
    world.addLinkedWorktree('app', '/wt/app/outer')

    const result = await move(world)

    expect(result).toMatchObject({ action: 'moved', warnings: [] })
    expect(world.relocateInputs[0].relocations).toEqual([{ from: ['/old/app'], to: '/dev/app' }])
    expect(world.calls).toContain('git.repair:/dev/app<-/wt/app/outer')
    expect(world.calls).toContain('syncWorktrees:/dev/app')
  })

  it('counts a worktree inside a sibling that moves as moved with it', async () => {
    const world = makeWorld()
    world.addProject('app', '/old/app')
    world.addLinkedWorktree('app', '/old/app-feature')
    world.addLinkedWorktree('app', '/old/app-feature/.claude/worktrees/deep')

    const result = await move(world)

    expect(result.action).toBe('moved')
    expect(world.calls).toContain(
      'git.repair:/dev/app<-/dev/app-feature,/dev/app-feature/.claude/worktrees/deep'
    )
    expect(world.seen.relocated[0].moves).toEqual([
      { from: '/old/app', to: '/dev/app' },
      { from: '/old/app-feature', to: '/dev/app-feature' },
      {
        from: '/old/app-feature/.claude/worktrees/deep',
        to: '/dev/app-feature/.claude/worktrees/deep'
      }
    ])
  })
})

describe('moveProjectToDevFolder: what stops it once it has started', () => {
  it('reads what is running once more before the folders go into place, and backs out when something started', async () => {
    // On the same volume too: stopping the watchers and preparing the move take time, and a
    // session can start in it.
    for (const otherVolume of [false, true]) {
      const world = worldWithWorktrees({ otherVolume })
      world.behaviour.busyByReading = [
        null,
        'A session started working in this project. Stop it, then check again.'
      ]

      const result = await move(world)

      expect(result).toMatchObject({
        action: 'skipped',
        skipReason: 'busy',
        detail: 'A session started working in this project. Stop it, then check again.',
        toPath: '/dev/app',
        movedPaths: []
      })
      expect(world.calls).toEqual([
        'git.list:/old/app',
        'busy',
        'probe:app',
        'git.operation:/old/app',
        'beforeMove:app',
        'fs.mkdirp:/dev',
        'fs.prepareMove:/old/app->/dev/app',
        'fs.prepareMove:/old/app-feature->/dev/app-feature',
        'busy',
        'probe:app',
        'abort:/dev/app',
        'abort:/dev/app-feature',
        'afterAbort:app'
      ])
      expect(world.project('app')?.path).toBe('/old/app')
      expect(world.kind('/dev/app')).toBeNull()
      expect(world.state.pending).toBeNull()
    }
  })

  it('takes two readings for every move, the second with the rows as they are then', async () => {
    const world = worldWithWorktrees()
    world.behaviour.onPrepare = (_from, to) => {
      // A worktree row appears while the move is being prepared.
      if (to === '/dev/app') world.addLinkedWorktree('app', '/wt/app/late')
    }

    expect((await move(world)).action).toBe('moved')

    expect(world.counts.get('busy')).toBe(2)
    expect(world.seen.probes.map((probe) => probe.worktreeIds)).toEqual([
      ['app-default', 'app-inner', 'app-app-feature', 'app-outer'],
      ['app-default', 'app-inner', 'app-app-feature', 'app-outer', 'app-late']
    ])
  })

  it('lets nothing else run between the second reading and the folders going into place', async () => {
    for (const otherVolume of [false, true]) {
      const world = worldWithWorktrees({ otherVolume })
      world.behaviour.onProbe = (reading) => {
        // What is queued while the second reading is being used runs at the first chance the
        // service gives anything else: a session that starts then would not be seen.
        if (reading === 2) queueMicrotask(() => world.calls.push('something else ran'))
      }

      expect((await move(world)).action).toBe('moved')

      const ranAt = world.calls.indexOf('something else ran')
      expect(world.calls.slice(world.calls.lastIndexOf('probe:app'), ranAt)).toEqual([
        'probe:app',
        'git.operation:/old/app',
        'git.operation:/old/app',
        'db.relocateProject:app',
        'place:/dev/app',
        'place:/dev/app-feature',
        'onRelocated:app',
        'git.repair:/dev/app<-/dev/app/.claude/worktrees/inner,/dev/app-feature,/wt/app/outer'
      ])
    }
  })

  it('moves to another volume, discards the old copies and only then forgets the note', async () => {
    const world = worldWithWorktrees({ otherVolume: true })

    const result = await move(world)

    expect(result).toMatchObject({ action: 'moved', warnings: [] })
    expect(world.counts.get('busy')).toBe(2)
    expect(world.calls.slice(-3)).toEqual([
      'discardSource:/old/app',
      'discardSource:/old/app-feature',
      'db.clearPendingMove'
    ])
    expect(world.kind('/old/app')).toBeNull()
    expect(world.kind('/dev/app/.git')).toBe('dir')
    expect(world.state.pending).toBeNull()
  })

  it('still has the note while an old copy is being removed', async () => {
    const world = worldWithWorktrees({ otherVolume: true })
    let noteWhileRemoving: unknown = 'not asked'
    world.behaviour.onDiscard = (from) => {
      if (from === '/old/app-feature') noteWhileRemoving = world.state.pending
    }

    await move(world)

    // A quit at that moment leaves it for the next start, with the folders that were copied.
    expect(noteWhileRemoving).toMatchObject({
      projectId: 'app',
      toPath: '/dev/app',
      copiedFrom: ['/old/app', '/old/app-feature']
    })
    expect(world.state.pending).toBeNull()
  })

  it('writes the copied folders into the note, and nothing when the folders were renamed', async () => {
    const copied = worldWithWorktrees({ otherVolume: true })
    await move(copied)
    expect(copied.relocateInputs[0].pending.copiedFrom).toEqual(['/old/app', '/old/app-feature'])

    const renamed = worldWithWorktrees()
    await move(renamed)
    expect('copiedFrom' in renamed.relocateInputs[0].pending).toBe(false)
  })

  it('backs out when git starts something between the last wait and the move', async () => {
    const world = worldWithWorktrees()
    // The first two calls belong to the two readings of what is running.
    world.behaviour.gitOperationByCall = [null, null, 'another git command']

    const result = await move(world)

    expect(result).toMatchObject({
      action: 'skipped',
      skipReason: 'busy',
      detail: expect.stringMatching(/^Another git command is in progress/),
      movedPaths: []
    })
    expect(world.calls.slice(-8)).toEqual([
      'fs.prepareMove:/old/app-feature->/dev/app-feature',
      'busy',
      'probe:app',
      'git.operation:/old/app',
      'git.operation:/old/app',
      'abort:/dev/app',
      'abort:/dev/app-feature',
      'afterAbort:app'
    ])
    expect(world.kind('/old/app')).toBe('dir')
    expect(world.project('app')?.path).toBe('/old/app')
  })

  it('backs out when the project row changed while the move was being prepared', async () => {
    const world = makeWorld()
    world.addProject('app', '/old/app')
    world.addProject('b', '/old/b')
    world.behaviour.onPrepare = () => {
      // Another writer repoints the row (a second app instance on the same database).
      world.deps.db.relocateProject({
        projectId: 'app',
        expectedPath: '/old/app',
        relocations: [{ from: ['/old/app'], to: '/elsewhere/app' }],
        homeDir: '/Users/me',
        pending: {
          projectId: 'app',
          fromPath: '/old/app',
          fromRealPath: '/old/app',
          toPath: '/elsewhere/app',
          relocations: []
        },
        place: () => undefined
      })
    }

    const result = await move(world)

    expect(result).toMatchObject({ action: 'skipped', skipReason: 'not-in-source' })
    expect(result.detail).toMatch(/changed while its move was being prepared/)
    expect(world.calls).not.toContain('place:/dev/app')
    expect(world.calls.slice(-2)).toEqual(['abort:/dev/app', 'afterAbort:app'])
    expect(world.kind('/old/app')).toBe('dir')
  })

  it('backs out when something took the destination while the move was being prepared', async () => {
    const world = worldWithWorktrees()
    world.behaviour.onPrepare = (_from, to) => {
      if (to === '/dev/app-feature') world.addDir('/dev/app-feature')
    }

    const result = await move(world)

    expect(result).toMatchObject({
      action: 'skipped',
      skipReason: 'exists',
      detail: expect.stringMatching(/already has a folder named app-feature/)
    })
    expect(world.calls).not.toContain('db.relocateProject:app')
    expect(world.calls.slice(-3)).toEqual([
      'abort:/dev/app',
      'abort:/dev/app-feature',
      'afterAbort:app'
    ])
    expect(world.kind('/old/app')).toBe('dir')
  })

  it('puts the folders back, last one first, when the database refuses after they were placed', async () => {
    const world = worldWithWorktrees()
    world.fail('db.commit')

    const result = await move(world)

    expect(result).toEqual({
      projectId: 'app',
      projectName: 'app',
      action: 'failed',
      fromPath: '/old/app',
      toPath: '/dev/app',
      skipReason: null,
      detail: 'This project was not moved: db.commit failed. It is still in its old folder.',
      warnings: [],
      movedPaths: []
    })
    expect(world.calls.slice(world.calls.indexOf('db.relocateProject:app'))).toEqual([
      'db.relocateProject:app',
      'place:/dev/app',
      'place:/dev/app-feature',
      'undo:/dev/app-feature',
      'undo:/dev/app',
      'abort:/dev/app',
      'abort:/dev/app-feature',
      'afterAbort:app'
    ])
    expect(world.kind('/old/app/.git')).toBe('dir')
    expect(world.kind('/old/app/.claude/worktrees/inner')).toBe('dir')
    expect(world.kind('/old/app-feature')).toBe('dir')
    expect(world.kind('/dev/app')).toBeNull()
    expect(world.kind('/dev/app-feature')).toBeNull()
    expect(world.project('app')?.path).toBe('/old/app')
    expect(world.state.pending).toBeNull()
  })

  it('takes the first folder back when the second cannot be placed', async () => {
    const world = worldWithWorktrees()
    world.fail('place', 2)

    const result = await move(world)

    expect(result).toMatchObject({
      action: 'failed',
      detail: 'This project was not moved: place failed. It is still in its old folder.',
      movedPaths: []
    })
    expect(world.calls.slice(world.calls.indexOf('db.relocateProject:app'))).toEqual([
      'db.relocateProject:app',
      'place:/dev/app',
      'undo:/dev/app',
      'abort:/dev/app',
      'abort:/dev/app-feature',
      'afterAbort:app'
    ])
    expect(world.kind('/old/app')).toBe('dir')
    expect(world.kind('/dev/app')).toBeNull()
    expect(world.project('app')?.path).toBe('/old/app')
  })

  it('says where the folder is when it cannot be put back, without hiding what went wrong first', async () => {
    const world = worldWithWorktrees()
    world.fail('db.commit')
    world.fail('undo', 1)

    const result = await move(world)

    expect(result.action).toBe('failed')
    expect(result.detail).toBe(
      'This project was not moved: db.commit failed, and the folder could not be put back: ' +
        '/dev/app-feature was not moved back to /old/app-feature (undo failed); move it back yourself.'
    )
    // The undo that failed did not stop the one after it.
    expect(world.calls).toContain('undo:/dev/app')
    expect(world.kind('/old/app')).toBe('dir')
    expect(world.kind('/dev/app-feature')).toBe('dir')
    expect(world.calls.slice(-3)).toEqual([
      'abort:/dev/app',
      'abort:/dev/app-feature',
      'afterAbort:app'
    ])
  })

  it('removes what was prepared when a later folder cannot be prepared', async () => {
    const world = worldWithWorktrees()
    world.fail('fs.prepareMove', 2)

    const result = await move(world)

    expect(result).toMatchObject({
      action: 'failed',
      detail: 'This project was not moved: fs.prepareMove failed. It is still in its old folder.',
      toPath: '/dev/app'
    })
    expect(world.calls.slice(world.calls.indexOf('beforeMove:app'))).toEqual([
      'beforeMove:app',
      'fs.mkdirp:/dev',
      'fs.prepareMove:/old/app->/dev/app',
      'abort:/dev/app',
      'afterAbort:app'
    ])
  })

  it('restarts what it stopped even when stopping it failed', async () => {
    const world = makeWorld()
    world.addProject('app', '/old/app')
    world.fail('beforeMove')

    const result = await move(world)

    expect(result).toMatchObject({
      action: 'failed',
      detail: 'This project was not moved: beforeMove failed. It is still in its old folder.'
    })
    expect(world.calls.slice(-2)).toEqual(['beforeMove:app', 'afterAbort:app'])
  })

  it('still answers when backing out fails too', async () => {
    const world = worldWithWorktrees()
    world.fail('db.commit')
    world.fail('abort')
    world.fail('afterAbort', 'always', 'throw')

    const result = await move(world)

    expect(result).toMatchObject({
      action: 'failed',
      detail: 'This project was not moved: db.commit failed. It is still in its old folder.'
    })
    expect(world.calls.slice(-3)).toEqual([
      'abort:/dev/app',
      'abort:/dev/app-feature',
      'afterAbort:app'
    ])
    expect(world.kind('/old/app')).toBe('dir')
  })
})

describe('moveProjectToDevFolder: after the project has moved', () => {
  const expectNoSync = (world: World, result: DevFolderMoveResult): void => {
    expect(result.action).toBe('moved')
    expect(world.calls.some((call) => call.startsWith('syncWorktrees'))).toBe(false)
    // Everything else still runs.
    expect(world.calls).toContain('git.submodules:/dev/app<-/old/app')
    expect(world.calls).toContain('afterMove:app')
    expect(world.calls).toContain('publishChanged:app')
    expect(world.calls).toContain('db.clearPendingMove')
  }

  it('does not sync, and gives the command to run, when git refuses to repair', async () => {
    const world = worldWithWorktrees()
    world.fail('git.repairWorktrees')

    const result = await move(world)

    expectNoSync(world, result)
    expect(result.warnings).toEqual([
      "Git could not re-link these worktrees to the project's new folder (git.repairWorktrees failed): " +
        '/dev/app/.claude/worktrees/inner, /dev/app-feature, /wt/app/outer. ' +
        'Run this in a terminal to fix them: git -C /dev/app worktree repair ' +
        '/dev/app/.claude/worktrees/inner /dev/app-feature /wt/app/outer'
    ])
  })

  it('does not sync when a worktree is still prunable after a repair that exited cleanly', async () => {
    const world = worldWithWorktrees()
    world.behaviour.unrepairable.add('inner')

    const result = await move(world)

    expectNoSync(world, result)
    expect(result.warnings).toEqual([
      "Git could not re-link this worktree to the project's new folder: /dev/app/.claude/worktrees/inner. " +
        'Run this in a terminal to fix it: git -C /dev/app worktree repair /dev/app/.claude/worktrees/inner'
    ])
  })

  it('does not sync when a worktree is missing from the listing after the repair', async () => {
    const world = worldWithWorktrees()
    world.behaviour.lostOnRepair.add('outer')

    const result = await move(world)

    expectNoSync(world, result)
    expect(result.warnings).toEqual([
      expect.stringMatching(/re-link this worktree .*: \/wt\/app\/outer\. /)
    ])
  })

  it('does not sync when the worktrees cannot be listed after the repair', async () => {
    const world = worldWithWorktrees()
    world.fail('git.listLinkedWorktrees', 2)

    const result = await move(world)

    expectNoSync(world, result)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toMatch(/worktree repair/)

    const unlistable = worldWithWorktrees()
    unlistable.behaviour.onPrepare = () => unlistable.behaviour.unlistable.add('app')
    expectNoSync(unlistable, await move(unlistable))
  })

  it('says nothing, and syncs, when git reports an error and every worktree is linked all the same', async () => {
    // What git does over one worktree whose folder lost its `.git` file: it re-links every
    // worktree it was handed, and exits with an error.
    const world = worldWithWorktrees()
    world.behaviour.repairComplaint =
      'error: unable to locate repository; .git file broken: /wt/app/outer/.git'

    const result = await move(world)

    expect(result).toMatchObject({ action: 'moved', warnings: [] })
    expect(world.calls).toContain('syncWorktrees:/dev/app')
    expect(world.seen.brokenAtSync).toEqual([])
    expect(world.calls.indexOf('git.list:/dev/app')).toBeGreaterThan(
      world.calls.findIndex((call) => call.startsWith('git.repair:'))
    )
    expect(world.seen.logs).toContainEqual({
      message: 'dev folder: git reported an error while re-linking, and every worktree is linked',
      detail: {
        toPath: '/dev/app',
        error: 'error: unable to locate repository; .git file broken: /wt/app/outer/.git'
      }
    })
  })

  it('names only the worktrees that are still not linked after git reported an error', async () => {
    const world = worldWithWorktrees()
    world.behaviour.repairComplaint = 'error: could not write the .git file of inner'
    world.behaviour.unrepairable.add('inner')

    const result = await move(world)

    expectNoSync(world, result)
    expect(result.warnings).toEqual([
      "Git could not re-link this worktree to the project's new folder (error: could not write the .git file of inner): " +
        '/dev/app/.claude/worktrees/inner. ' +
        'Run this in a terminal to fix it: git -C /dev/app worktree repair /dev/app/.claude/worktrees/inner'
    ])
  })

  it('names every worktree on disk when git refused and cannot list them afterwards either', async () => {
    const world = worldWithWorktrees()
    world.fail('git.repairWorktrees')
    world.behaviour.onPrepare = () => world.behaviour.unlistable.add('app')

    const result = await move(world)

    expectNoSync(world, result)
    expect(result.warnings).toEqual([
      "Git could not re-link these worktrees to the project's new folder (git.repairWorktrees failed): " +
        '/dev/app/.claude/worktrees/inner, /dev/app-feature, /wt/app/outer. ' +
        'Run this in a terminal to fix them: git -C /dev/app worktree repair ' +
        '/dev/app/.claude/worktrees/inner /dev/app-feature /wt/app/outer'
    ])
  })

  it('does not take a worktree for linked while its own .git file names another repository', async () => {
    // git lists it where it is and finds it there: its listing shows the repository's side only.
    const world = worldWithWorktrees()
    world.behaviour.oneWay.add('outer')

    const result = await move(world)

    expectNoSync(world, result)
    expect(result.warnings).toEqual([
      "Git could not re-link this worktree to the project's new folder: /wt/app/outer. " +
        'Run this in a terminal to fix it: git -C /dev/app worktree repair /wt/app/outer'
    ])

    // A git port that cannot look at the worktree's side goes by the listing alone.
    const untold = worldWithWorktrees()
    untold.behaviour.oneWay.add('outer')
    const answer = await moveProjectToDevFolder(
      { projectId: 'app', expectedToPath: '/dev/app' },
      { ...untold.deps, git: { ...untold.deps.git, linksBack: undefined } }
    )
    expect(answer).toMatchObject({ action: 'moved', warnings: [] })
    expect(untold.calls).toContain('syncWorktrees:/dev/app')
  })

  it('says how to re-link a locked worktree whose folder is away, and syncs all the same', async () => {
    const world = worldWithWorktrees()
    // On a disk that is not connected: git keeps a locked worktree registered, the sync too.
    world.addLinkedWorktree('app', '/Volumes/stick/app usb', { onDisk: false, locked: true })
    // Away and not locked: the sync drops it, with or without a move. Nothing to say.
    world.addLinkedWorktree('app', '/wt/app/gone', { onDisk: false })

    const result = await move(world)

    expect(result.action).toBe('moved')
    expect(result.warnings).toEqual([
      'The worktree at /Volumes/stick/app usb was not on disk, so its link to the project was not updated. ' +
        "When it is back, run: git -C /dev/app worktree repair '/Volumes/stick/app usb'"
    ])
    // git is handed the worktrees that are on disk, and no others.
    expect(world.calls).toContain(
      'git.repair:/dev/app<-/dev/app/.claude/worktrees/inner,/dev/app-feature,/wt/app/outer'
    )
    expect(world.calls).toContain('syncWorktrees:/dev/app')

    // The same when no other worktree is there to repair.
    const alone = makeWorld()
    alone.addProject('app', '/old/app')
    alone.addLinkedWorktree('app', '/Volumes/stick/usb', { onDisk: false, locked: true })
    const answer = await move(alone)
    expect(answer.warnings).toEqual([
      'The worktree at /Volumes/stick/usb was not on disk, so its link to the project was not updated. ' +
        'When it is back, run: git -C /dev/app worktree repair /Volumes/stick/usb'
    ])
    expect(alone.calls.some((call) => call.startsWith('git.repair:'))).toBe(false)
    expect(alone.calls).toContain('syncWorktrees:/dev/app')
  })

  it('quotes paths a shell would split in the command it gives', async () => {
    const world = makeWorld({ devFolder: '/my dev' })
    world.addProject('app', '/old/app')
    world.addLinkedWorktree('app', "/wt/it's here/outer")
    world.fail('git.repairWorktrees')

    const result = await move(world, 'app', '/my dev/app')

    expect(result.warnings[0]).toContain(
      `git -C '/my dev/app' worktree repair '/wt/it'\\''s here/outer'`
    )
  })

  it('reports an old copy that changed or could not be removed', async () => {
    const world = worldWithWorktrees({ otherVolume: true })
    world.behaviour.leftovers.set('/old/app', { path: '/old/app', reason: 'changed', detail: null })
    world.behaviour.leftovers.set('/old/app-feature', {
      path: '/old/app-feature',
      reason: 'failed',
      detail: 'permission denied.'
    })

    const result = await move(world)

    expect(result.action).toBe('moved')
    expect(result.warnings).toEqual([
      'The old copy is still at /old/app: it changed while the project was being moved, compare it with the new one before deleting it.',
      'The old copy is still at /old/app-feature: it could not be removed (permission denied). Delete it yourself.'
    ])
  })

  it('says where an old copy changed when the filesystem can tell', async () => {
    const world = worldWithWorktrees({ otherVolume: true })
    world.behaviour.leftovers.set('/old/app', {
      path: '/old/app',
      reason: 'changed',
      detail: 'what changed is in .git, src and 2 more folders'
    })
    world.behaviour.leftovers.set('/old/app-feature', {
      path: '/old/app-feature',
      reason: 'changed',
      detail: 'it could not be read: EACCES: permission denied.'
    })

    const result = await move(world)

    expect(result.action).toBe('moved')
    expect(result.warnings).toEqual([
      'The old copy is still at /old/app: it changed while the project was being moved (what changed is in .git, src and 2 more folders), compare it with the new one before deleting it.',
      'The old copy is still at /old/app-feature: it was kept because it could not be read: EACCES: permission denied. Compare it with the new one before deleting it.'
    ])
  })

  it('warns about scripts when they were rewritten and the new path needs quoting', async () => {
    const special = makeWorld({ devFolder: '/my dev' })
    special.addProject('app', '/old/app', { row: { name: 'The App' } })
    special.behaviour.scriptsRewritten = true
    expect((await move(special, 'app', '/my dev/app')).warnings).toEqual([
      'Scripts of The App mention its folder, and the new path has characters a shell treats specially: check them.'
    ])

    const plainPath = makeWorld()
    plainPath.addProject('app', '/old/app')
    plainPath.behaviour.scriptsRewritten = true
    expect((await move(plainPath)).warnings).toEqual([])

    const untouched = makeWorld({ devFolder: '/my dev' })
    untouched.addProject('app', '/old/app')
    expect((await move(untouched, 'app', '/my dev/app')).warnings).toEqual([])
  })

  it('warns about scripts when they were rewritten and the old path needs quoting or escaping', async () => {
    const oldPathWarning =
      'Scripts of The App mention its folder, and the old path has characters a shell treats specially: a script may still name the old folder in an escaped or quoted spelling. Check them.'

    const special = makeWorld({ previousFolders: ['/my old'] })
    special.addProject('app', '/my old/app', { row: { name: 'The App' } })
    special.behaviour.scriptsRewritten = true
    expect((await move(special)).warnings).toEqual([oldPathWarning])

    // Nothing was rewritten: nothing to check.
    const untouched = makeWorld({ previousFolders: ['/my old'] })
    untouched.addProject('app', '/my old/app', { row: { name: 'The App' } })
    expect((await move(untouched)).warnings).toEqual([])

    // The spelling the row holds is plain, the real path of the folder is not.
    const behindLink = makeWorld()
    behindLink.addDir('/my disk/old')
    behindLink.links.set('/old', '/my disk/old')
    behindLink.addProject('app', '/old/app', { row: { name: 'The App' } })
    behindLink.behaviour.scriptsRewritten = true
    expect((await move(behindLink)).warnings).toEqual([oldPathWarning])

    // Both paths: both sentences.
    const both = makeWorld({ devFolder: '/my dev', previousFolders: ['/my old'] })
    both.addProject('app', '/my old/app', { row: { name: 'The App' } })
    both.behaviour.scriptsRewritten = true
    expect((await move(both, 'app', '/my dev/app')).warnings).toEqual([
      'Scripts of The App mention its folder, and the new path has characters a shell treats specially: check them.',
      oldPathWarning
    ])
  })

  it('passes on what the follow-up steps report, in the order they ran', async () => {
    const world = worldWithWorktrees()
    world.behaviour.onRelocatedWarnings = ['A connection folder could not be relinked.']
    world.behaviour.submoduleWarnings = [
      'The submodules of the worktree outer could not be relinked.'
    ]
    world.behaviour.syncResult = { success: false, error: 'git said no.' }
    world.behaviour.afterMoveWarnings = ['Claude history could not be moved.']

    const result = await move(world)

    expect(result.action).toBe('moved')
    expect(result.warnings).toEqual([
      'A connection folder could not be relinked.',
      'The submodules of the worktree outer could not be relinked.',
      "The project's worktree list could not be brought up to date after the move: git said no. Restart the app to try again.",
      'Claude history could not be moved.'
    ])
  })

  it('answers "moved", with a warning, whatever fails once the database points at the new place', async () => {
    const ports = [
      'onRelocated',
      'git.repairLinkedSubmodules',
      'syncWorktrees',
      'afterMove',
      'publishChanged',
      'discardSource'
    ]
    for (const port of ports) {
      const world = worldWithWorktrees()
      world.fail(port)

      const result = await move(world)

      expect(result.action, port).toBe('moved')
      expect(result.warnings, port).toHaveLength(port === 'discardSource' ? 2 : 1)
      expect(result.warnings[0], port).toContain(`${port} failed`)
      expect(world.project('app')?.path, port).toBe('/dev/app')
      expect(world.calls, port).not.toContain('afterAbort:app')
      expect(world.calls, port).not.toContain('undo:/dev/app')
      // One step failing does not stop the ones after it.
      expect(world.calls, port).toContain(
        'git.repair:/dev/app<-/dev/app/.claude/worktrees/inner,/dev/app-feature,/wt/app/outer'
      )
      expect(world.calls, port).toContain('db.clearPendingMove')
      if (port !== 'discardSource') {
        expect(world.calls, port).toContain('discardSource:/old/app-feature')
      }
      expect(world.state.pending, port).toBeNull()
    }
  })

  it('still tells the follow-up steps about every worktree row when reading them back fails', async () => {
    const world = worldWithWorktrees()
    // The first two reads are for the two readings of what is running, the third comes right
    // after the commit.
    world.fail('db.getWorktreesByProject', 3)

    const result = await move(world)

    expect(result).toMatchObject({ action: 'moved', warnings: [] })
    expect(world.seen.relocated[0].allWorktrees.map((row) => [row.id, row.path])).toEqual([
      ['app-default', '/dev/app'],
      ['app-inner', '/dev/app/.claude/worktrees/inner'],
      ['app-app-feature', '/dev/app-feature'],
      ['app-outer', '/wt/app/outer']
    ])
  })

  it('never answers "failed" once the database is repointed, even when the answer of the database is unusable', async () => {
    const world = worldWithWorktrees()
    world.behaviour.garbledRelocateResult = true

    const result = await move(world)

    expect(result).toMatchObject({
      action: 'moved',
      toPath: '/dev/app',
      movedPaths: [{ from: '/old/app', to: '/dev/app' }]
    })
    expect(result.warnings).toEqual([
      expect.stringMatching(
        /^A step after the move did not finish: .*Restart the app to finish it\.$/
      )
    ])
    expect(world.calls).not.toContain('undo:/dev/app')
    expect(world.calls).not.toContain('afterAbort:app')
    expect(world.kind('/dev/app/.git')).toBe('dir')
    // What is owed stays written down for the next start.
    expect(world.state.pending).toMatchObject({ projectId: 'app', toPath: '/dev/app' })
  })

  it('keeps the note for the next start when it cannot be cleared, without a warning', async () => {
    const world = worldWithWorktrees()
    world.fail('db.clearPendingMove')

    const result = await move(world)

    expect(result).toMatchObject({ action: 'moved', warnings: [] })
    expect(world.state.pending).toMatchObject({ projectId: 'app', toPath: '/dev/app' })
    expect(world.seen.logs.map((entry) => entry.message)).toContain(
      'dev folder: clearing the pending move failed'
    )
  })
})

/** What must hold whatever happened: the answer, the disk and the rows tell one story. */
const expectConsistent = (world: World, result: DevFolderMoveResult, label: string): void => {
  expect(['moved', 'skipped', 'failed'], label).toContain(result.action)
  expect(result.projectId, label).toBe('app')
  const beganAt = world.calls.indexOf('beforeMove:app')
  const prepared = world.calls.filter((call) => call.startsWith('fs.prepareMove:')).length
  const aborted = world.calls.filter((call) => call.startsWith('abort:')).length
  const undone = world.calls.filter((call) => call.startsWith('undo:')).length
  const placed = world.calls.filter((call) => call.startsWith('place:')).length

  if (result.action === 'moved') {
    expect(world.project('app')?.path, label).toBe('/dev/app')
    expect(result.toPath, label).toBe('/dev/app')
    expect(world.kind('/dev/app/.git'), label).toBe('dir')
    expect(world.kind('/dev/app/.claude/worktrees/inner'), label).toBe('dir')
    expect(result.movedPaths[0], label).toEqual({ from: '/old/app', to: '/dev/app' })
    expect(world.calls, label).not.toContain('afterAbort:app')
    expect(undone, label).toBe(0)
    expect(aborted, label).toBe(0)
  } else {
    expect(world.project('app')?.path, label).toBe('/old/app')
    expect(world.kind('/old/app/.git'), label).toBe('dir')
    expect(world.kind('/old/app-feature'), label).toBe('dir')
    expect(world.kind('/dev/app'), label).toBeNull()
    expect(world.kind('/dev/app-feature'), label).toBeNull()
    expect(result.movedPaths, label).toEqual([])
    expect(result.warnings, label).toEqual([])
    expect(result.detail, label).toEqual(expect.any(String))
    expect(result.skipReason === null, label).toBe(result.action === 'failed')
    expect(world.state.pending, label).toBeNull()
    expect(undone, label).toBe(placed)
    expect(aborted, label).toBe(prepared)
    if (beganAt >= 0) expect(world.calls[world.calls.length - 1], label).toBe('afterAbort:app')
    else expect(world.calls, label).not.toContain('afterAbort:app')
    for (const after of ['onRelocated:app', 'afterMove:app', 'publishChanged:app']) {
      expect(world.calls, label).not.toContain(after)
    }
  }
  // Worktrees are only ever synced once git finds every one of them again.
  expect(world.seen.brokenAtSync, label).toEqual([])
}

describe('moveProjectToDevFolder: never rejects', () => {
  const ASYNC_PORTS = new Set([
    'fs.mkdirp',
    'fs.prepareMove',
    'discardSource',
    'git.listLinkedWorktrees',
    'git.repairWorktrees',
    'git.repairLinkedSubmodules',
    'busy',
    'beforeMove',
    'syncWorktrees',
    'afterMove'
  ])

  for (const otherVolume of [false, true]) {
    it(`whichever call of whichever port fails (${otherVolume ? 'another volume' : 'same volume'})`, async () => {
      const clean = worldWithWorktrees({ otherVolume })
      expect((await move(clean)).action).toBe('moved')
      const portCalls = [...clean.counts]
      // Every port of the service is exercised by this move.
      expect(portCalls.map(([port]) => port).sort()).toEqual(
        [
          ...ASYNC_PORTS,
          'db.clearPendingMove',
          'db.commit',
          'db.getProject',
          'db.getProjectByPath',
          'db.getWorktreesByProject',
          'db.namesRegisteredInside',
          'db.readPendingMove',
          'db.relocateProject',
          'folders',
          'fs.canonical',
          'fs.copies',
          'fs.kind',
          'fs.sameFolder',
          'git.linksBack',
          'git.operationInProgress',
          'onRelocated',
          'place',
          'probe',
          'publishChanged'
        ].sort()
      )

      let runs = 0
      for (const [port, count] of portCalls) {
        const modes: FailMode[] = ASYNC_PORTS.has(port) ? ['reject', 'throw'] : ['throw']
        for (const mode of modes) {
          for (let nth = 1; nth <= count; nth += 1) {
            const label = `${port} call ${nth} of ${count} (${mode})`
            const world = worldWithWorktrees({ otherVolume })
            world.fail(port, nth, mode)
            const result = await move(world).catch((error: unknown) => {
              throw new Error(`rejected on ${label}: ${String(error)}`)
            })
            expectConsistent(world, result, label)
            runs += 1
          }
        }
      }
      expect(runs).toBeGreaterThan(60)
    })
  }

  it('when a port fails every time it is called', async () => {
    const ports = [
      'folders',
      'db.getProject',
      'db.getProjectByPath',
      'db.getWorktreesByProject',
      'db.namesRegisteredInside',
      'db.relocateProject',
      'db.commit',
      'db.clearPendingMove',
      'db.readPendingMove',
      'fs.kind',
      'fs.canonical',
      'fs.sameFolder',
      'fs.copies',
      'fs.mkdirp',
      'fs.prepareMove',
      'place',
      'discardSource',
      'git.listLinkedWorktrees',
      'git.repairWorktrees',
      'git.repairLinkedSubmodules',
      'git.operationInProgress',
      'git.linksBack',
      'busy',
      'probe',
      'beforeMove',
      'onRelocated',
      'syncWorktrees',
      'afterMove',
      'publishChanged'
    ]
    for (const port of ports) {
      for (const mode of ['reject', 'throw'] as const) {
        const label = `${port} always (${mode})`
        const world = worldWithWorktrees()
        world.fail(port, 'always', mode)
        const result = await move(world).catch((error: unknown) => {
          throw new Error(`rejected on ${label}: ${String(error)}`)
        })
        expectConsistent(world, result, label)
      }
    }
  })

  it('when the log fails as well', async () => {
    const world = worldWithWorktrees()
    world.fail('db.getProject')
    world.fail('log')

    await expect(move(world)).resolves.toMatchObject({
      action: 'failed',
      projectName: '',
      detail: 'This project was not moved: db.getProject failed. It is still in its old folder.'
    })
  })
})

/**
 * The state a quit leaves right after the database was repointed: nothing repaired yet. With
 * `copied`, the move went to another volume: the old folders are still on disk, and the note
 * names them.
 */
const interruptedWorld = (options: { readonly copied?: boolean } = {}): World => {
  const world = worldWithWorktrees({ otherVolume: options.copied })
  const relocations = [
    { from: ['/old/app'], to: '/dev/app' },
    { from: ['/old/app-feature'], to: '/dev/app-feature' }
  ]
  const put = options.copied ? world.copyTree : world.renameTree
  world.deps.db.relocateProject({
    projectId: 'app',
    expectedPath: '/old/app',
    relocations,
    homeDir: '/Users/me',
    pending: {
      projectId: 'app',
      fromPath: '/old/app',
      fromRealPath: '/old/app',
      toPath: '/dev/app',
      relocations,
      ...(options.copied ? { copiedFrom: ['/old/app', '/old/app-feature'] } : {})
    },
    place: () => {
      put('/old/app', '/dev/app')
      put('/old/app-feature', '/dev/app-feature')
    }
  })
  world.forgetCalls()
  return world
}

/** The steps a move owes after its commit, as the call log shows them for `app`. */
const OWED_STEPS_OF_APP = [
  'git.list:/dev/app',
  'onRelocated:app',
  'git.repair:/dev/app<-/dev/app/.claude/worktrees/inner,/dev/app-feature,/wt/app/outer',
  'git.list:/dev/app',
  'git.submodules:/dev/app<-/old/app',
  'syncWorktrees:/dev/app',
  'afterMove:app',
  'publishChanged:app',
  'db.clearPendingMove'
]

const OWED_AND_UNREACHABLE =
  'The move of app was interrupted and its folder /dev/app cannot be reached now. Reconnect the disk that holds it, or remove app from Hive, then check again.'

describe('moveProjectToDevFolder: after a move that did not get to its end', () => {
  it('finishes that move first, then moves the project it was asked for', async () => {
    const world = interruptedWorld()
    world.addProject('b', '/old/b')

    const result = await move(world, 'b', '/dev/b')

    expect(result).toMatchObject({ action: 'moved', toPath: '/dev/b', warnings: [] })
    expect(world.calls).toEqual([
      ...OWED_STEPS_OF_APP,
      'git.list:/old/b',
      'busy',
      'probe:b',
      'git.operation:/old/b',
      'beforeMove:b',
      'fs.mkdirp:/dev',
      'fs.prepareMove:/old/b->/dev/b',
      'busy',
      'probe:b',
      'git.operation:/old/b',
      'git.operation:/old/b',
      'db.relocateProject:b',
      'place:/dev/b',
      'onRelocated:b',
      'git.submodules:/dev/b<-/old/b',
      'afterMove:b',
      'publishChanged:b',
      'discardSource:/old/b',
      'db.clearPendingMove'
    ])
    // Both are where they belong, in git too, and nothing is owed.
    expect(world.registeredPaths('app')).toEqual([
      '/dev/app/.claude/worktrees/inner',
      '/dev/app-feature',
      '/wt/app/outer'
    ])
    expect(world.project('b')?.path).toBe('/dev/b')
    expect(world.state.pending).toBeNull()
    // The note of the move that was asked for is its own, not the one it found.
    expect(world.relocateInputs[world.relocateInputs.length - 1].pending).toMatchObject({
      projectId: 'b',
      toPath: '/dev/b'
    })
  })

  it('reads the note once, and nothing else of it, when no move is owed', async () => {
    const world = makeWorld()
    world.addProject('b', '/old/b')

    expect((await move(world, 'b', '/dev/b')).action).toBe('moved')

    expect(world.counts.get('db.readPendingMove')).toBe(1)
  })

  it('moves no other project while the folder of the interrupted move cannot be reached', async () => {
    const world = interruptedWorld()
    world.addProject('b', '/old/b')
    // The disk that holds the dev folder's project is not connected.
    world.renameTree('/dev/app', '/unmounted/app')

    const plan = await planDevFolderMove(world.deps)
    expect(plan.candidates).toEqual([
      {
        projectId: 'b',
        projectName: 'b',
        source: '/old',
        fromPath: '/old/b',
        toPath: '/dev/b',
        skipReason: 'busy',
        detail: OWED_AND_UNREACHABLE
      }
    ])
    // Said before git or the reading of what is running is asked anything.
    expect(world.calls).toEqual([])

    const result = await move(world, 'b', '/dev/b')

    expect(result).toEqual({
      projectId: 'b',
      projectName: 'b',
      action: 'skipped',
      fromPath: '/old/b',
      toPath: '/dev/b',
      skipReason: 'busy',
      detail: OWED_AND_UNREACHABLE,
      warnings: [],
      movedPaths: []
    })
    // None of the owed steps ran on a folder that is not there, and nothing of b was touched.
    expect(world.calls).toEqual([])
    expect(world.project('b')?.path).toBe('/old/b')
    expect(world.kind('/old/b')).toBe('dir')
    // The note is the one that was found: the move of b did not write over it.
    expect(world.state.pending).toMatchObject({ projectId: 'app', toPath: '/dev/app' })
    expect(world.relocateInputs.map((input) => input.projectId)).toEqual(['app'])

    // The disk is back: the next plan holds nothing back, and the next move finishes what was
    // owed before it begins.
    world.renameTree('/unmounted/app', '/dev/app')
    expect((await planDevFolderMove(world.deps)).candidates).toEqual([
      expect.objectContaining({ projectId: 'b', skipReason: null, detail: null })
    ])
    world.forgetCalls()
    expect(await move(world, 'b', '/dev/b')).toMatchObject({ action: 'moved', warnings: [] })
    expect(world.calls.slice(0, OWED_STEPS_OF_APP.length)).toEqual(OWED_STEPS_OF_APP)
    expect(world.registeredPaths('app')).toContain('/dev/app/.claude/worktrees/inner')
    expect(world.state.pending).toBeNull()
  })

  it('gives the interrupted project itself its own answer while its folder is away', async () => {
    // The dev folder was changed since: the folder the project was moved to is one that
    // projects are moved from now.
    const world = makeWorld({ devFolder: '/dev2', previousFolders: ['/dev'] })
    world.addProject('app', '/dev/app', { onDisk: false })
    world.state.pending = {
      projectId: 'app',
      fromPath: '/old/app',
      fromRealPath: '/old/app',
      toPath: '/dev/app',
      relocations: [{ from: ['/old/app'], to: '/dev/app' }]
    }

    const result = await move(world, 'app', '/dev2/app')

    expect(result).toMatchObject({
      action: 'skipped',
      skipReason: 'missing',
      detail: 'Its folder is not on disk, so there is nothing to move.'
    })
    expect(world.state.pending).toMatchObject({ projectId: 'app' })
  })

  it('moves nothing while the owed steps stopped on an error, and says to restart', async () => {
    const world = interruptedWorld()
    world.addProject('b', '/old/b')
    // The owed steps stop where the rows of the moved project are read: the note stays.
    world.fail('db.getWorktreesByProject', 1)

    const result = await move(world, 'b', '/dev/b')

    expect(result).toMatchObject({
      action: 'skipped',
      skipReason: 'busy',
      detail:
        'The move of app was interrupted and could not be finished yet. Restart Hive, then check again.',
      movedPaths: []
    })
    expect(world.calls).toEqual(['git.list:/dev/app'])
    expect(world.project('b')?.path).toBe('/old/b')
    expect(world.state.pending).toMatchObject({ projectId: 'app', toPath: '/dev/app' })
  })

  it('is not held back by a note about a project that is gone or somewhere else', async () => {
    const world = makeWorld()
    world.addProject('b', '/old/b')
    world.state.pending = {
      projectId: 'deleted',
      fromPath: '/old/deleted',
      fromRealPath: null,
      toPath: '/dev/deleted',
      relocations: []
    }

    expect((await planDevFolderMove(world.deps)).candidates).toEqual([
      expect.objectContaining({ projectId: 'b', skipReason: null })
    ])
    // A plan only reads: the note is still there for the move to deal with.
    expect(world.state.pending).not.toBeNull()
    world.forgetCalls()
    const result = await move(world, 'b', '/dev/b')

    expect(result).toMatchObject({ action: 'moved', warnings: [] })
    // The stale note was dropped before the move began.
    expect(world.calls[0]).toBe('db.clearPendingMove')
    expect(world.state.pending).toBeNull()
  })

  it('answers "not moved" when the note cannot be read', async () => {
    const world = makeWorld()
    world.addProject('b', '/old/b')
    world.fail('db.readPendingMove')

    const result = await move(world, 'b', '/dev/b')

    // Not knowing whether steps are owed, the move does not risk writing over their note.
    expect(result).toMatchObject({
      action: 'failed',
      projectName: 'b',
      fromPath: '/old/b',
      detail:
        'This project was not moved: db.readPendingMove failed. It is still in its old folder.'
    })
    expect(world.calls).toEqual([])

    // A plan lists the project all the same: the move says what is wrong.
    const plan = await planDevFolderMove(world.deps)
    expect(plan.candidates).toEqual([expect.objectContaining({ projectId: 'b', skipReason: null })])
  })
})

describe('resumePendingDevFolderMove', () => {
  it('only reads the note when no move is owed', async () => {
    const world = worldWithWorktrees()

    await resumePendingDevFolderMove(world.deps)

    expect(world.calls).toEqual([])
    expect([...world.counts.keys()]).toEqual(['db.readPendingMove'])
  })

  it('drops the note when the project is somewhere else by now, or gone', async () => {
    const movedOn = worldWithWorktrees()
    movedOn.state.pending = {
      projectId: 'app',
      fromPath: '/older/app',
      fromRealPath: null,
      toPath: '/dev/app',
      relocations: [{ from: ['/older/app'], to: '/dev/app' }]
    }
    await resumePendingDevFolderMove(movedOn.deps)
    expect(movedOn.calls).toEqual(['db.clearPendingMove'])
    expect(movedOn.state.pending).toBeNull()

    const gone = makeWorld()
    gone.state.pending = {
      projectId: 'deleted',
      fromPath: '/old/deleted',
      fromRealPath: null,
      toPath: '/dev/deleted',
      relocations: []
    }
    await resumePendingDevFolderMove(gone.deps)
    expect(gone.calls).toEqual(['db.clearPendingMove'])
    expect(gone.state.pending).toBeNull()
  })

  it('runs the steps that were owed, in order, and clears the note', async () => {
    const world = interruptedWorld()
    // Until the repair, git still has the worktrees that moved under their old paths.
    expect(world.registeredPaths('app')).toEqual([
      '/old/app/.claude/worktrees/inner',
      '/old/app-feature',
      '/wt/app/outer'
    ])

    await resumePendingDevFolderMove(world.deps)

    expect(world.calls).toEqual([
      'git.list:/dev/app',
      'onRelocated:app',
      'git.repair:/dev/app<-/dev/app/.claude/worktrees/inner,/dev/app-feature,/wt/app/outer',
      'git.list:/dev/app',
      'git.submodules:/dev/app<-/old/app',
      'syncWorktrees:/dev/app',
      'afterMove:app',
      'publishChanged:app',
      'db.clearPendingMove'
    ])
    expect(world.state.pending).toBeNull()
    expect(world.seen.brokenAtSync).toEqual([])
    expect(world.registeredPaths('app')).toEqual([
      '/dev/app/.claude/worktrees/inner',
      '/dev/app-feature',
      '/wt/app/outer'
    ])
  })

  it('rebuilds what moved from the note and the rows as they are now', async () => {
    const world = interruptedWorld()

    await resumePendingDevFolderMove(world.deps)

    const moved = world.seen.relocated[0]
    expect(moved).toMatchObject({
      project: { id: 'app', path: '/dev/app' },
      fromPath: '/old/app',
      fromRealPath: '/old/app',
      toPath: '/dev/app',
      relocations: [
        { from: ['/old/app'], to: '/dev/app' },
        { from: ['/old/app-feature'], to: '/dev/app-feature' }
      ]
    })
    expect(moved.moves).toEqual([
      { from: '/old/app', to: '/dev/app' },
      { from: '/old/app-feature', to: '/dev/app-feature' },
      { from: '/old/app/.claude/worktrees/inner', to: '/dev/app/.claude/worktrees/inner' }
    ])
    expect(moved.worktrees).toEqual([
      { id: 'app-default', from: '/old/app', to: '/dev/app' },
      {
        id: 'app-inner',
        from: '/old/app/.claude/worktrees/inner',
        to: '/dev/app/.claude/worktrees/inner'
      },
      { id: 'app-app-feature', from: '/old/app-feature', to: '/dev/app-feature' }
    ])
    expect(moved.allWorktrees).toHaveLength(4)
    expect(world.seen.afterMoved[0]).toBe(moved)
    expect(world.seen.published[0]).toBe(moved)
    // What the transaction reported is gone with the process that ran it.
    expect('ticketProjectIds' in moved).toBe(false)
    expect('runIds' in moved).toBe(false)
  })

  it('runs nothing and keeps the note while the moved folder cannot be reached', async () => {
    const world = interruptedWorld()
    // The disk that holds it is not connected at this start.
    world.renameTree('/dev/app', '/unmounted/app')

    await resumePendingDevFolderMove(world.deps)

    expect(world.calls).toEqual([])
    expect(world.seen.relocated).toEqual([])
    expect(world.seen.afterMoved).toEqual([])
    expect(world.state.pending).toMatchObject({ projectId: 'app', toPath: '/dev/app' })
    expect(world.seen.logs).toEqual([
      {
        message:
          'dev folder: the folder of an interrupted move cannot be reached, its steps stay owed',
        detail: { projectId: 'app', toPath: '/dev/app' }
      }
    ])

    // Something else than a folder at that path is no folder to work on either.
    world.addFile('/dev/app')
    await resumePendingDevFolderMove(world.deps)
    expect(world.calls).toEqual([])
    expect(world.state.pending).not.toBeNull()
    world.removeTree('/dev/app')

    // A later start, with the disk connected: the steps run and the note goes.
    world.renameTree('/unmounted/app', '/dev/app')
    await resumePendingDevFolderMove(world.deps)

    expect(world.calls).toEqual(OWED_STEPS_OF_APP)
    expect(world.state.pending).toBeNull()
    expect(world.seen.brokenAtSync).toEqual([])
  })

  it('says where the old copies of a move to another volume still are, and removes nothing', async () => {
    const world = interruptedWorld({ copied: true })

    await resumePendingDevFolderMove(world.deps)

    const finished = world.seen.logs.find(
      (entry) => entry.message === 'dev folder: finished the steps of an interrupted move'
    )
    expect(finished?.detail?.warnings).toEqual([
      'An old copy of app is still at /old/app: Hive quit before it was removed. The project is at /dev/app now. Compare the two, then delete the old copy yourself.',
      'An old copy of the worktree app-feature of app is still at /old/app-feature: Hive quit before it was removed. The worktree is at /dev/app-feature now. Compare the two, then delete the old copy yourself.'
    ])
    expect(
      world.seen.logs
        .filter(
          (entry) => entry.message === 'dev folder: an interrupted move left an old copy on disk'
        )
        .map((entry) => entry.detail)
    ).toEqual([
      { projectId: 'app', path: '/old/app', nowAt: '/dev/app' },
      { projectId: 'app', path: '/old/app-feature', nowAt: '/dev/app-feature' }
    ])
    // Said after the owed steps, and before the note goes.
    expect(world.calls).toEqual(OWED_STEPS_OF_APP)
    expect(world.state.pending).toBeNull()
    // Both copies are as they were: what was checked before the new one went into place is not
    // known any more.
    expect(world.kind('/old/app/.git')).toBe('dir')
    expect(world.kind('/old/app/.claude/worktrees/inner')).toBe('dir')
    expect(world.kind('/old/app-feature')).toBe('dir')
    expect(world.kind('/dev/app/.git')).toBe('dir')
  })

  it('says nothing about an old copy that is gone, or about a move that copied nothing', async () => {
    const world = interruptedWorld({ copied: true })
    // The quit came after the first old folder was removed.
    world.removeTree('/old/app')

    await resumePendingDevFolderMove(world.deps)

    const finished = world.seen.logs.find((entry) => entry.message.includes('finished the steps'))
    expect(finished?.detail?.warnings).toEqual([
      expect.stringMatching(/^An old copy of the worktree app-feature of app is still at /)
    ])

    const renamed = interruptedWorld()
    // Something else is at the old path by now: the note of a rename names no old copy.
    renamed.addDir('/old/app')
    await resumePendingDevFolderMove(renamed.deps)
    expect(
      renamed.seen.logs.find((entry) => entry.message.includes('finished the steps'))?.detail
        ?.warnings
    ).toEqual([])
  })

  it('says how to re-link a locked worktree that is away, as the move itself does', async () => {
    const world = interruptedWorld()
    world.addLinkedWorktree('app', '/Volumes/stick/usb', { onDisk: false, locked: true })

    await resumePendingDevFolderMove(world.deps)

    const finished = world.seen.logs.find((entry) => entry.message.includes('finished the steps'))
    expect(finished?.detail?.warnings).toEqual([
      'The worktree at /Volumes/stick/usb was not on disk, so its link to the project was not updated. ' +
        'When it is back, run: git -C /dev/app worktree repair /Volumes/stick/usb'
    ])
    expect(world.calls).toContain('syncWorktrees:/dev/app')
    expect(world.state.pending).toBeNull()
  })

  it('gives the owed steps one attempt and clears the note, also when the repair did not take', async () => {
    // A note that stayed would make every start run all the steps again.
    const world = interruptedWorld()
    world.fail('git.repairWorktrees')

    await resumePendingDevFolderMove(world.deps)

    expect(world.state.pending).toBeNull()
    const finished = world.seen.logs.find((entry) => entry.message.includes('finished the steps'))
    expect(finished?.detail?.warnings).toEqual([expect.stringMatching(/worktree repair/)])
  })

  it('is safe to run on a move whose steps had all run already', async () => {
    const world = interruptedWorld()
    await resumePendingDevFolderMove(world.deps)
    // The same note again, as if the quit came just before it was cleared.
    world.state.pending = world.seen.relocated[0] && {
      projectId: 'app',
      fromPath: '/old/app',
      fromRealPath: '/old/app',
      toPath: '/dev/app',
      relocations: world.seen.relocated[0].relocations
    }
    world.forgetCalls()

    await resumePendingDevFolderMove(world.deps)

    expect(world.calls).toContain(
      'git.repair:/dev/app<-/dev/app/.claude/worktrees/inner,/dev/app-feature,/wt/app/outer'
    )
    expect(world.calls).toContain('syncWorktrees:/dev/app')
    expect(world.seen.relocated[1].moves).toEqual(world.seen.relocated[0].moves)
    expect(world.state.pending).toBeNull()
  })

  it('never syncs when the repair could not be verified', async () => {
    const refused = interruptedWorld()
    refused.fail('git.repairWorktrees')
    await resumePendingDevFolderMove(refused.deps)
    expect(refused.calls.some((call) => call.startsWith('syncWorktrees'))).toBe(false)
    expect(refused.calls.slice(-3)).toEqual([
      'afterMove:app',
      'publishChanged:app',
      'db.clearPendingMove'
    ])

    const prunable = interruptedWorld()
    prunable.behaviour.unrepairable.add('app-feature')
    await resumePendingDevFolderMove(prunable.deps)
    expect(prunable.calls.some((call) => call.startsWith('syncWorktrees'))).toBe(false)
    expect(prunable.state.pending).toBeNull()

    const unlistable = interruptedWorld()
    unlistable.behaviour.unlistable.add('app')
    await resumePendingDevFolderMove(unlistable.deps)
    expect(unlistable.calls).toEqual([
      'git.list:/dev/app',
      'onRelocated:app',
      'git.submodules:/dev/app<-/old/app',
      'afterMove:app',
      'publishChanged:app',
      'db.clearPendingMove'
    ])
    // What could not be done is written to the log: nobody is watching at start.
    const finished = unlistable.seen.logs.find((entry) =>
      entry.message.includes('interrupted move')
    )
    expect(finished?.detail?.warnings).toEqual([expect.stringMatching(/worktree repair/)])
  })

  it('never rejects, whichever call of whichever port fails', async () => {
    const clean = interruptedWorld()
    await resumePendingDevFolderMove(clean.deps)
    const portCalls = [...clean.counts]
    expect(portCalls.length).toBeGreaterThan(10)

    for (const [port, count] of portCalls) {
      for (const mode of ['reject', 'throw'] as const) {
        for (const nth of [
          ...Array.from({ length: count }, (_, index) => index + 1),
          'always'
        ] as const) {
          const label = `${port} call ${nth} of ${count} (${mode})`
          const world = interruptedWorld()
          world.fail(port, nth, mode)
          await resumePendingDevFolderMove(world.deps).catch((error: unknown) => {
            throw new Error(`rejected on ${label}: ${String(error)}`)
          })
          expect(world.seen.brokenAtSync, label).toEqual([])
          // Resuming never moves a folder or a row.
          expect(world.project('app')?.path, label).toBe('/dev/app')
          expect(world.kind('/dev/app/.git'), label).toBe('dir')
        }
      }
    }
  })

  it('keeps the note when it stops on an error, so the next start tries again', async () => {
    const world = interruptedWorld()
    world.fail('db.getWorktreesByProject')

    await resumePendingDevFolderMove(world.deps)

    expect(world.state.pending).not.toBeNull()
    expect(world.seen.logs.map((entry) => entry.message)).toContain(
      'dev folder: finishing an interrupted move failed'
    )
  })
})
