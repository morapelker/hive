import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Effect } from 'effect'
import { z } from 'zod'
import { GITHUB_CLONE_PROGRESS_CHANNEL, type GithubCloneProgressEvent } from '@shared/github-events'
import type { EventBus } from '../../events/event-bus'
import type { RpcHandler } from '../router'

export interface GithubRepo {
  readonly nameWithOwner: string
  readonly description: string | null
  readonly isPrivate: boolean
  readonly updatedAt: string
}

export interface GithubListRepositoriesResult {
  readonly success: boolean
  readonly repos: GithubRepo[]
  readonly error?: string
}

export interface GithubCloneStartResult {
  readonly success: boolean
  readonly path?: string
  readonly error?: string
}

export interface GithubCancelCloneResult {
  readonly success: boolean
}

export interface GithubCloneRepositoryParams {
  readonly nameWithOwner: string
  readonly parentPath: string
  readonly operationId: string
}

export interface GithubOpsRpcService {
  readonly listRepositories: () => Effect.Effect<GithubListRepositoriesResult, unknown, never>
  readonly cloneRepository: (
    params: GithubCloneRepositoryParams
  ) => Effect.Effect<GithubCloneStartResult, unknown, never>
  readonly cancelClone: (
    operationId: string
  ) => Effect.Effect<GithubCancelCloneResult, unknown, never>
}

interface CommandResult {
  readonly stdout: string
  readonly stderr: string
}

type CommandRunner = (
  file: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd: string; readonly maxBuffer?: number }
) => Promise<CommandResult>

type SpawnRunner = (
  file: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd: string }
) => ChildProcess

const execFileAsync = promisify(execFile) as unknown as CommandRunner

const spawnProcess: SpawnRunner = (file, args, options) =>
  spawn(file, args as string[], {
    cwd: options.cwd,
    env: process.env,
    // Own process group (POSIX) so cancelClone can signal gh AND the git child
    // it spawns — killing only the gh PID leaves git downloading.
    detached: process.platform !== 'win32'
  })

const emptyParamsSchema = z.union([z.object({}).strict(), z.undefined(), z.null()])
const cloneParamsSchema = z
  .object({
    nameWithOwner: z.string().min(1),
    parentPath: z.string().min(1),
    operationId: z.string().min(1)
  })
  .strict()
const operationIdParamsSchema = z.object({ operationId: z.string().min(1) }).strict()

const GH_NOT_INSTALLED_ERROR = 'GitHub CLI (gh) is not installed'
// Owner must start alphanumeric (GitHub rule); repo may start with '.' or '_'
// but never '-', so neither segment can be mistaken for a CLI flag.
const NAME_WITH_OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9._][A-Za-z0-9._-]*$/

// All repos the user can access (own, collaborator, org member), most recently pushed first.
const GH_REPOS_ENDPOINT =
  'user/repos?per_page=100&affiliation=owner,collaborator,organization_member&sort=pushed'
const GH_REPOS_JQ =
  '.[] | {nameWithOwner: .full_name, description: .description, isPrivate: .private, updatedAt: .pushed_at}'

const isValidDirectory = (path: string): boolean => {
  try {
    return existsSync(path) && statSync(path).isDirectory()
  } catch {
    return false
  }
}

const describeGhError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('ENOENT')) return GH_NOT_INSTALLED_ERROR
  const stderr =
    typeof error === 'object' && error !== null && 'stderr' in error
      ? String((error as { stderr: unknown }).stderr).trim()
      : ''
  return stderr || message
}

const parseRepoLine = (line: string): GithubRepo | null => {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>
    if (typeof parsed.nameWithOwner !== 'string') return null
    return {
      nameWithOwner: parsed.nameWithOwner,
      description: typeof parsed.description === 'string' ? parsed.description : null,
      isPrivate: parsed.isPrivate === true,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : ''
    }
  } catch {
    return null
  }
}

interface CloneStageRange {
  readonly pattern: RegExp
  readonly from: number
  readonly to: number
  readonly label: string
}

// git clone --progress reports these stages on stderr; map each to a slice of an
// overall 0-100 range so the renderer can show a single continuous bar.
const CLONE_STAGES: ReadonlyArray<CloneStageRange> = [
  { pattern: /remote: Counting objects:\s+(\d+)%/, from: 0, to: 5, label: 'Counting objects' },
  {
    pattern: /remote: Compressing objects:\s+(\d+)%/,
    from: 5,
    to: 10,
    label: 'Compressing objects'
  },
  { pattern: /Receiving objects:\s+(\d+)%/, from: 10, to: 90, label: 'Receiving objects' },
  { pattern: /Resolving deltas:\s+(\d+)%/, from: 90, to: 100, label: 'Resolving deltas' }
]

export const parseCloneProgress = (
  chunk: string
): { readonly stage: string; readonly percent: number } | null => {
  const lines = chunk.split(/[\r\n]+/)
  for (let i = lines.length - 1; i >= 0; i--) {
    for (const stage of CLONE_STAGES) {
      const match = lines[i].match(stage.pattern)
      if (match) {
        const stagePercent = Math.min(100, parseInt(match[1], 10) || 0)
        const percent = Math.round(stage.from + ((stage.to - stage.from) * stagePercent) / 100)
        return { stage: stage.label, percent }
      }
    }
  }
  return null
}

export interface GithubOpsRpcServiceDependencies {
  readonly eventBus?: EventBus
  readonly runCommand?: CommandRunner
  readonly spawnCommand?: SpawnRunner
}

export const makeLiveGithubOpsRpcService = (
  dependencies: GithubOpsRpcServiceDependencies = {}
): GithubOpsRpcService => {
  const runCommand = dependencies.runCommand ?? execFileAsync
  const spawnCommand = dependencies.spawnCommand ?? spawnProcess
  const eventBus = dependencies.eventBus

  const activeClones = new Map<string, { child: ChildProcess; destPath: string }>()

  const publish = (payload: GithubCloneProgressEvent): void => {
    if (!eventBus) return
    void Effect.runPromise(eventBus.publish({ channel: GITHUB_CLONE_PROGRESS_CHANNEL, payload }))
  }

  return {
    listRepositories: () =>
      Effect.tryPromise({
        try: async (): Promise<GithubListRepositoriesResult> => {
          try {
            const { stdout } = await runCommand(
              'gh',
              ['api', GH_REPOS_ENDPOINT, '--paginate', '--jq', GH_REPOS_JQ],
              { cwd: homedir(), maxBuffer: 32 * 1024 * 1024 }
            )
            const repos = stdout
              .split('\n')
              .map((line) => line.trim())
              .filter((line) => line.length > 0)
              .map(parseRepoLine)
              .filter((repo): repo is GithubRepo => repo !== null)
            return { success: true, repos }
          } catch (error) {
            return { success: false, repos: [], error: describeGhError(error) }
          }
        },
        catch: (cause) => cause
      }),

    cloneRepository: ({ nameWithOwner, parentPath, operationId }) =>
      Effect.sync((): GithubCloneStartResult => {
        if (!NAME_WITH_OWNER_PATTERN.test(nameWithOwner)) {
          return { success: false, error: 'Invalid repository name.' }
        }
        if (!isValidDirectory(parentPath)) {
          return { success: false, error: 'The selected destination is not a valid directory.' }
        }
        const repoName = nameWithOwner.split('/')[1]
        const destPath = join(parentPath, repoName)
        if (existsSync(destPath)) {
          return {
            success: false,
            error: `A folder named "${repoName}" already exists in the selected directory.`
          }
        }

        const child = spawnCommand(
          'gh',
          ['repo', 'clone', nameWithOwner, destPath, '--', '--progress'],
          {
            cwd: parentPath
          }
        )
        activeClones.set(operationId, { child, destPath })

        const stderrTail: string[] = []
        child.stderr?.on('data', (chunk: Buffer | string) => {
          if (!activeClones.has(operationId)) return
          const text = chunk.toString()
          stderrTail.push(text)
          if (stderrTail.length > 50) stderrTail.shift()
          const progress = parseCloneProgress(text)
          if (progress) {
            publish({ operationId, type: 'progress', ...progress })
          }
        })
        child.on('error', (error: NodeJS.ErrnoException) => {
          if (!activeClones.delete(operationId)) return
          publish({
            operationId,
            type: 'error',
            error: error.code === 'ENOENT' ? GH_NOT_INSTALLED_ERROR : error.message
          })
        })
        child.on('close', (code) => {
          if (!activeClones.delete(operationId)) return
          if (code === 0) {
            publish({ operationId, type: 'done', path: destPath })
          } else {
            // destPath did not exist before this clone; git can leave partial
            // state in some failure modes, which would block a retry.
            void rm(destPath, { recursive: true, force: true }).catch(() => undefined)
            const detail = stderrTail.join('').trim().split('\n').slice(-5).join('\n').trim()
            publish({
              operationId,
              type: 'error',
              error: detail || `Clone failed with exit code ${code ?? 'unknown'}`
            })
          }
        })

        return { success: true, path: destPath }
      }),

    cancelClone: (operationId) =>
      Effect.sync((): GithubCancelCloneResult => {
        const entry = activeClones.get(operationId)
        if (!entry) return { success: false }
        activeClones.delete(operationId)
        const { child, destPath } = entry
        // Remove the partial clone only once the process tree has actually
        // exited (the destination did not exist before the clone), and never
        // a path a newer clone has since reclaimed.
        child.once('close', () => {
          for (const active of activeClones.values()) {
            if (active.destPath === destPath) return
          }
          void rm(destPath, { recursive: true, force: true }).catch(() => undefined)
        })
        try {
          if (child.pid && process.platform !== 'win32') {
            // Negative pid signals the whole group: gh and the git it spawned.
            process.kill(-child.pid, 'SIGTERM')
          } else {
            child.kill('SIGTERM')
          }
        } catch {
          child.kill('SIGTERM')
        }
        return { success: true }
      })
  }
}

export const makeGithubOpsRpcHandlers = (
  service: GithubOpsRpcService = makeLiveGithubOpsRpcService()
): ReadonlyMap<string, RpcHandler> =>
  new Map<string, RpcHandler>([
    [
      'githubOps.listRepositories',
      (params) =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () => emptyParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.listRepositories()
        })
    ],
    [
      'githubOps.cloneRepository',
      (params) =>
        Effect.gen(function* () {
          const parsed = yield* Effect.try({
            try: () => cloneParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.cloneRepository(parsed)
        })
    ],
    [
      'githubOps.cancelClone',
      (params) =>
        Effect.gen(function* () {
          const { operationId } = yield* Effect.try({
            try: () => operationIdParamsSchema.parse(params),
            catch: (cause) => cause
          })
          return yield* service.cancelClone(operationId)
        })
    ]
  ])
