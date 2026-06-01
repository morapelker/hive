import { execFile, spawn } from 'child_process'
import { existsSync, mkdirSync, rmSync, cpSync, writeFileSync, unlinkSync, readdirSync, readFileSync, appendFileSync, mkdtempSync } from 'fs'
import { readFile as readFileAsync } from 'fs/promises'
import { homedir, tmpdir } from 'os'
import { basename, dirname, join } from 'path'
import { promisify } from 'util'
import { Effect, Either, Layer, Ref } from 'effect'
import simpleGit, { type SimpleGit, type BranchSummary } from 'simple-git'

import { getImageMimeType } from '@shared/types/file-utils'
import { selectUniqueBreedName } from '../../services/breed-names'
import { normalizeWorktreePath } from '../../services/path-utils'
import { classifyGitError } from './classifier'
import { GitUnknown, type GitError } from './errors'
import { Git } from './service'
import type { BreedType, GitBranchDiffFile, GitDiffStatFile, GitFileStatus } from './types'

const execFileAsync = promisify(execFile)
type GitOperation = 'merge' | 'rebase' | 'cherry-pick' | 'apply'

const normalizeBranchDisplayName = (branchName: string): string =>
  branchName.startsWith('remotes/') ? branchName.replace(/^remotes\//, '') : branchName

export const resolveGitWorktreesDir = (
  projectName: string,
  homeDir: string = homedir()
): string => join(homeDir, '.hive-worktrees', projectName)

const ensureWorktreesDir = (projectName: string): string => {
  const projectWorktreesDir = resolveGitWorktreesDir(projectName)
  if (!existsSync(projectWorktreesDir)) {
    mkdirSync(projectWorktreesDir, { recursive: true })
  }
  return projectWorktreesDir
}

const invalidBranch = (branch: string): boolean => !branch || branch.startsWith('-')

export type WorktreeCreateMode = 'new' | 'existing' | 'duplicate'

/**
 * Default execution deadline for a worktree create script. Bounded so a stalled
 * script (waiting on a lock, network call, etc.) cannot hang worktree creation
 * indefinitely. Five minutes is generous for legitimate work on large repos
 * (fetching, decrypting, checking out tens of thousands of files) while still
 * surfacing genuine hangs in a reasonable time.
 */
const WORKTREE_CREATE_SCRIPT_TIMEOUT_MS = 5 * 60 * 1000

export interface RunWorktreeCreateScriptOptions {
  readonly script: string
  readonly projectPath: string
  readonly worktreePath: string
  readonly branchName: string
  /**
   * Human-readable name of the branch the new worktree is based on. Always a
   * branch name when set (e.g. `main`, `feature-foo`); never an arbitrary git
   * ref. Use for naming decisions, conditional logic, etc.
   */
  readonly baseBranch: string
  /**
   * Git ref the new worktree should be created from. For most flows this
   * equals `baseBranch`; for pull-request checkouts it is `FETCH_HEAD` (the
   * PR head has already been fetched into the main repo before the script
   * runs). Use this with `git worktree add`.
   */
  readonly baseRef: string
  readonly mode: WorktreeCreateMode
  readonly sourceWorktreePath?: string
  readonly sourceBranch?: string
  /** Override the default timeout for testing. */
  readonly timeoutMs?: number
}

export interface RunWorktreeCreateScriptResult {
  readonly success: boolean
  readonly output: string
  readonly error?: string
}

/**
 * Picks the shell used to run a user-supplied worktree create script.
 *
 * If the script begins with `#!/usr/bin/env bash` or `#!/bin/bash` (with
 * optional whitespace tolerance), bash is used directly. Otherwise sh is the
 * default. This matters in practice because the documented git-crypt example
 * uses `set -euo pipefail` and other bash-isms; on Linux distros where
 * `/bin/sh` is dash, those would fail before the worktree is created.
 * Other shebangs (zsh, fish, python, etc.) are deliberately not supported --
 * those are out of scope for a worktree creation hook.
 */
const detectShell = (script: string): 'bash' | 'sh' => {
  const match = script.match(/^#![ \t]*(\S+)(?:[ \t]+(\S+))?/)
  if (!match) return 'sh'
  const interpreter = match[1]
  const arg = match[2]
  if (interpreter.endsWith('/env') && arg === 'bash') return 'bash'
  if (interpreter.endsWith('/bash')) return 'bash'
  return 'sh'
}

/**
 * Signals the entire process group launched by `spawn` with `detached: true`.
 * Falls back to a direct signal to the immediate child on Windows or when
 * the group send fails (process already dead). Using `-pid` covers grand-
 * children inherited from the spawned shell -- a `sh -c '… git worktree add
 * …'` script would otherwise leave `git worktree add` running after the
 * shell exits, racing with our cleanup.
 */
const signalProcessGroup = (
  proc: ReturnType<typeof spawn>,
  signal: NodeJS.Signals
): void => {
  if (proc.pid === undefined) return
  if (process.platform === 'win32') {
    try {
      proc.kill(signal)
    } catch {
      // already exited
    }
    return
  }
  try {
    process.kill(-proc.pid, signal)
  } catch {
    try {
      proc.kill(signal)
    } catch {
      // already exited
    }
  }
}

export const runWorktreeCreateScript = (
  opts: RunWorktreeCreateScriptOptions
): Promise<RunWorktreeCreateScriptResult> =>
  new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HIVE_PROJECT_PATH: opts.projectPath,
      HIVE_WORKTREE_PATH: opts.worktreePath,
      HIVE_BRANCH_NAME: opts.branchName,
      HIVE_BASE_BRANCH: opts.baseBranch,
      HIVE_BASE_REF: opts.baseRef,
      HIVE_WORKTREE_MODE: opts.mode
    }
    if (opts.sourceWorktreePath !== undefined) {
      env.HIVE_SOURCE_WORKTREE_PATH = opts.sourceWorktreePath
    }
    if (opts.sourceBranch !== undefined) {
      env.HIVE_SOURCE_BRANCH = opts.sourceBranch
    }

    const shell = detectShell(opts.script)
    const proc = spawn(shell, ['-c', opts.script], {
      cwd: opts.projectPath,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Own process group on Unix so `-pid` kills the shell AND any
      // foreground children it spawned (git, cp, etc.). Without this,
      // killing the shell leaves descendants running and they can race
      // with cleanup.
      detached: process.platform !== 'win32'
    })
    if (proc.stdin) proc.stdin.end()

    let output = ''
    proc.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    proc.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })

    let settled = false
    let timedOut = false
    let killTimer: NodeJS.Timeout | null = null
    const timeoutMs = opts.timeoutMs ?? WORKTREE_CREATE_SCRIPT_TIMEOUT_MS
    // On timeout: signal the whole process group but DO NOT resolve yet.
    // The `exit` handler resolves once the script process has actually died,
    // so callers don't start cleanup while git commands spawned by the
    // script are still running (which could race and recreate the worktree
    // we just removed).
    const timeoutTimer = setTimeout(() => {
      if (settled) return
      timedOut = true
      signalProcessGroup(proc, 'SIGTERM')
      killTimer = setTimeout(() => {
        signalProcessGroup(proc, 'SIGKILL')
      }, 500)
    }, timeoutMs)
    // Listen on `exit` (process died) rather than `close` (all stdio closed).
    // If the script spawned a grandchild that inherited stdout/stderr, `close`
    // would not fire until that grandchild also closes the pipes -- which
    // would defeat the timeout (the shell can be SIGKILLed but an orphaned
    // grandchild like `sleep` can keep the pipes open). `exit` accurately
    // signals "the script process is gone, cleanup can run safely".
    const onExit = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timeoutTimer)
      if (killTimer !== null) clearTimeout(killTimer)
      if (timedOut) {
        resolve({
          success: false,
          output,
          error: `Worktree create script timed out after ${timeoutMs}ms`
        })
      } else if (code === 0) {
        resolve({ success: true, output })
      } else {
        resolve({
          success: false,
          output,
          error: `Worktree create script exited with code ${code ?? 'null'}`
        })
      }
    }
    proc.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutTimer)
      if (killTimer !== null) clearTimeout(killTimer)
      resolve({ success: false, output, error: err.message })
    })
    proc.on('exit', onExit)
  })

/**
 * Best-effort cleanup of a partial worktree left behind by a failed create
 * script. The script may have already run `git worktree add` and created a
 * branch before failing in a later step (key copy, checkout, post-create
 * setup, etc.); without cleanup, those artefacts remain on disk and in the
 * repo's worktree list with no Hive DB row to track them, forcing the user
 * to prune them by hand. Errors are swallowed: if there is nothing to clean
 * up, or the cleanup itself fails, the original script failure is still the
 * one reported to the user.
 *
 * Deliberately conservative about deleting the path on disk: only removes
 * directories git itself owns (registered as a linked worktree). A pre-
 * existing dir at the same path that was *not* created by our script attempt
 * is left alone, so a misconfigured collision can never wipe user data.
 * The other create flows include existing dirs in their collision detection
 * to prevent that case from arising in the first place.
 */
const cleanupFailedWorktreeCreate = async (
  git: SimpleGit,
  worktreePath: string,
  branchName: string
): Promise<void> => {
  let worktreeWasRegistered = false
  try {
    const list = await git.raw(['worktree', 'list', '--porcelain'])
    worktreeWasRegistered = list
      .split('\n')
      .some((line) => line === `worktree ${worktreePath}`)
  } catch {
    // If we can't list, fall through; we'll attempt remove anyway and just
    // not do the rmSync fallback.
  }
  try {
    await git.raw(['worktree', 'remove', worktreePath, '--force'])
  } catch {
    // Worktree may not exist, or removal may fail; fall through.
  }
  if (worktreeWasRegistered) {
    // Only rmSync paths git itself was tracking. A directory we never
    // registered may have been pre-existing user data.
    try {
      if (existsSync(worktreePath)) {
        rmSync(worktreePath, { recursive: true, force: true })
      }
    } catch {
      // Best-effort.
    }
  }
  try {
    await git.raw(['worktree', 'prune'])
  } catch {
    // Best-effort.
  }
  try {
    await git.raw(['branch', '-D', branchName])
  } catch {
    // Branch may not have been created, or may already be gone.
  }
}

const parseShortStat = (shortstat: string) => {
  const filesMatch = shortstat.match(/(\d+) files? changed/)
  const insMatch = shortstat.match(/(\d+) insertions?/)
  const delMatch = shortstat.match(/(\d+) deletions?/)
  return {
    filesChanged: filesMatch ? parseInt(filesMatch[1], 10) : 0,
    insertions: insMatch ? parseInt(insMatch[1], 10) : 0,
    deletions: delMatch ? parseInt(delMatch[1], 10) : 0
  }
}

const parseNumstat = (line: string): GitDiffStatFile | null => {
  const [add, del, ...pathParts] = line.split('\t')
  const path = pathParts.join('\t')
  if (!path) return null
  const binary = add === '-' || del === '-'
  return {
    path,
    additions: binary ? 0 : parseInt(add, 10) || 0,
    deletions: binary ? 0 : parseInt(del, 10) || 0,
    binary
  }
}

const make = Effect.gen(function* () {
  const gitCache = yield* Ref.make<Map<string, SimpleGit>>(new Map())
  const semaphores = yield* Ref.make<Map<string, Effect.Semaphore>>(new Map())
  const GLOBAL_GIT_CONCURRENCY = 6
  const globalGitSem = yield* Effect.makeSemaphore(GLOBAL_GIT_CONCURRENCY)

  const getGit = (repoPath: string) =>
    Effect.gen(function* () {
      const cache = yield* Ref.get(gitCache)
      const cached = cache.get(repoPath)
      if (cached) return cached
      const git = simpleGit(repoPath)
      yield* Ref.update(gitCache, (m) => new Map(m).set(repoPath, git))
      return git
    })

  const getSemaphore = (repoPath: string) =>
    Effect.gen(function* () {
      const cache = yield* Ref.get(semaphores)
      const cached = cache.get(repoPath)
      if (cached) return cached
      const semaphore = yield* Effect.makeSemaphore(1)
      yield* Ref.update(semaphores, (m) => new Map(m).set(repoPath, semaphore))
      return semaphore
    })

  const tryGit = <A>(
    repoPath: string,
    command: string,
    operation: GitOperation | undefined,
    body: (git: SimpleGit) => Promise<A>
  ): Effect.Effect<A, GitError> =>
    globalGitSem.withPermits(1)(
      Effect.flatMap(getGit(repoPath), (git) =>
        Effect.tryPromise({
          try: () => body(git),
          catch: (err) => classifyGitError(err, { worktreePath: repoPath, command, operation })
        })
      )
    )

  const writeOp = <A>(
    repoPath: string,
    command: string,
    body: (git: SimpleGit) => Promise<A>,
    operation?: GitOperation
  ): Effect.Effect<A, GitError> =>
    Effect.flatMap(getSemaphore(repoPath), (sem) =>
      sem.withPermits(1)(tryGit(repoPath, command, operation, body))
    )

  const execGit = <A>(
    repoPath: string,
    command: string,
    args: readonly string[],
    map: (stdout: string) => A,
    options?: { maxBuffer?: number }
  ): Effect.Effect<A, GitError> =>
    globalGitSem.withPermits(1)(
      Effect.tryPromise({
        try: async () => {
          const { stdout } = await execFileAsync('git', [...args], {
            cwd: repoPath,
            maxBuffer: options?.maxBuffer
          })
          return map(stdout)
        },
        catch: (err) => classifyGitError(err, { worktreePath: repoPath, command })
      })
    )

  const getAllBranches = (repoPath: string) =>
    tryGit(repoPath, 'git branch -a', undefined, async (git) => {
      const branches: BranchSummary = await git.branch(['-a'])
      return branches.all.map((b) =>
        b.startsWith('remotes/origin/') ? b.replace('remotes/origin/', '') : b
      )
    })

  const getCurrentBranch = (repoPath: string) =>
    tryGit(repoPath, 'git branch', undefined, async (git) => {
      const result = await git.branch()
      return result.current
    })

  const listWorktrees = (repoPath: string) =>
    tryGit(repoPath, 'git worktree list --porcelain', undefined, async (git) => {
      const result = await git.raw(['worktree', 'list', '--porcelain'])
      const worktrees: Array<{ path: string; branch: string; isMain: boolean }> = []
      const normalizedRepoPath = normalizeWorktreePath(repoPath)
      const lines = result.split('\n')
      let currentWorktree: Partial<{ path: string; branch: string }> = {}

      for (const line of lines) {
        if (line.startsWith('worktree ')) {
          currentWorktree.path = line.replace('worktree ', '')
        } else if (line.startsWith('branch ')) {
          currentWorktree.branch = line.replace('branch ', '').replace('refs/heads/', '')
        } else if (line === 'detached') {
          currentWorktree.branch = ''
        } else if (line === '') {
          const worktreePath = currentWorktree.path
          const worktreeBranch = currentWorktree.branch
          if (worktreePath && worktreeBranch !== undefined) {
            worktrees.push({
              path: worktreePath,
              branch: worktreeBranch,
              isMain: normalizeWorktreePath(worktreePath) === normalizedRepoPath
            })
          }
          currentWorktree = {}
        }
      }
      return worktrees
    })

  const getDefaultBranch = (repoPath: string) =>
    Effect.map(getAllBranches(repoPath), (branches) => {
      if (branches.includes('main')) return 'main'
      if (branches.includes('master')) return 'master'
      return branches[0] || 'main'
    })

  const branchExists = (repoPath: string, branchName: string) =>
    Effect.map(getAllBranches(repoPath), (branches) => branches.includes(branchName)).pipe(
      Effect.catchAll(() => Effect.succeed(false))
    )

  const getMergeBase = (repoPath: string, branch: string) =>
    invalidBranch(branch)
      ? Effect.succeed<string | null>(null)
      : tryGit(repoPath, `git merge-base ${branch} HEAD`, undefined, (git) =>
          git.raw(['merge-base', branch, 'HEAD']).then((result) => result.trim() || null)
        ).pipe(Effect.catchAll(() => Effect.succeed(null)))

  const getRefContent = (repoPath: string, ref: string, filePath: string) =>
    tryGit(repoPath, `git show ${ref}:${filePath}`, undefined, async (git) => {
      const refSpec = ref ? `${ref}:${filePath}` : `:${filePath}`
      return { success: true as const, content: await git.show([refSpec]) }
    })

  const getRefContentBase64 = (repoPath: string, ref: string, filePath: string) =>
    Effect.tryPromise({
      try: async () => {
        const refSpec = ref ? `${ref}:${filePath}` : `:${filePath}`
        const { stdout } = await execFileAsync('git', ['show', refSpec], {
          encoding: 'buffer',
          cwd: repoPath,
          maxBuffer: 20 * 1024 * 1024
        })
        return {
          success: true as const,
          data: Buffer.from(stdout as Buffer).toString('base64'),
          mimeType: getImageMimeType(filePath) ?? undefined
        }
      },
      catch: (err) => classifyGitError(err, { worktreePath: repoPath, command: 'git show' })
    })

  const pullBaseBranch = (
    repoPath: string,
    branchName: string,
    options?: { silent?: boolean; skipPull?: boolean }
  ) => {
    if (options?.skipPull) return Effect.succeed({ success: true as const, updated: false })

    return writeOp(repoPath, `git pull --ff-only origin ${branchName}`, async (git) => {
      const remotes = await git.getRemotes()
      if (!remotes.find((r) => r.name === 'origin')) return { success: true as const, updated: false }

      const branches = await git.branch(['-a'])
      const allBranches = branches.all.map((b) =>
        b.startsWith('remotes/origin/') ? b.replace('remotes/origin/', '') : b
      )
      if (!allBranches.some((b) => b === branchName)) return { success: true as const, updated: false }

      const current = await git.branch()
      let updated = false
      if (current.current === branchName) {
        const result = await git.pull('origin', branchName, { '--ff-only': null })
        updated = (result.files?.length || 0) > 0 || result.summary.changes > 0
      } else {
        const beforeSha = await git.revparse([branchName])
        await git.fetch('origin', `${branchName}:${branchName}`)
        const afterSha = await git.revparse([branchName])
        updated = beforeSha !== afterSha
      }
      return { success: true as const, updated }
    }).pipe(
      Effect.catchAll((error) =>
        Effect.succeed({
          success: false as const,
          updated: false,
          error: error.stderrExcerpt ?? 'Unknown error'
        })
      )
    )
  }

  const deleteRemoteTrackingBranch = (repoPath: string, branchName: string, remote = 'origin') => {
    if (!branchName) return Effect.void
    return tryGit(repoPath, `git branch -dr ${remote}/${branchName}`, undefined, (git) =>
      git.branch(['-dr', `${remote}/${branchName}`]).then(() => undefined)
    ).pipe(Effect.catchAll(() => Effect.void))
  }

  const applyPatchString = (
    repoPath: string,
    patch: string,
    options: string[],
    command: string
  ) =>
    writeOp(
      repoPath,
      command,
      async (git) => {
        const tmpFile = join(tmpdir(), `hive-patch-${Date.now()}-${Math.random().toString(36).slice(2)}.patch`)
        try {
          writeFileSync(tmpFile, patch, 'utf-8')
          await git.applyPatch(tmpFile, options)
        } finally {
          try {
            unlinkSync(tmpFile)
          } catch {
            /* ignore cleanup errors */
          }
        }
        return { success: true as const }
      },
      'apply'
    )

  const duplicateWorktree = (
    repoPath: string,
    sourceBranch: string,
    sourceWorktreePath: string,
    projectName: string,
    nameHint?: string,
    options?: { worktreeCreateScript?: string | null }
  ) =>
    writeOp(repoPath, 'git worktree add duplicate', async (git) => {
      const projectWorktreesDir = ensureWorktreesDir(projectName)
      const MAX_ATTEMPTS = 3
      const createScript = options?.worktreeCreateScript ?? null
      let newBranchName = ''
      let worktreePath = ''
      let created = false

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const allBranches = (await git.branch(['-a'])).all.map((b) =>
          b.startsWith('remotes/origin/') ? b.replace('remotes/origin/', '') : b
        )
        // Include existing dirs in collision detection, matching the create
        // and createFromBranch flows. Prevents a stale/user-created dir at
        // ~/.hive-worktrees/<project>/<project>--<name> from colliding with
        // a fresh attempt and getting wiped by the failure-cleanup path.
        let existingDirs: string[] = []
        try {
          existingDirs = readdirSync(projectWorktreesDir).map((d) =>
            d.startsWith(`${projectName}--`) ? d.slice(projectName.length + 2) : d
          )
        } catch {
          // Missing or unreadable worktrees dir; just reduces collision hints.
        }
        const existingNames = new Set([...allBranches, ...existingDirs])
        if (nameHint) {
          newBranchName = nameHint
          if (existingNames.has(newBranchName)) {
            let suffix = 2
            while (existingNames.has(`${nameHint}-${suffix}`) && suffix <= 9999) suffix += 1
            newBranchName = `${nameHint}-${suffix}`
          }
        } else {
          const baseName = sourceBranch.replace(/-v\d+$/, '')
          const versionPattern = new RegExp(`^${baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-v(\\d+)$`)
          let maxVersion = 1
          for (const name of existingNames) {
            const match = name.match(versionPattern)
            if (match) maxVersion = Math.max(maxVersion, parseInt(match[1], 10))
          }
          newBranchName = `${baseName}-v${maxVersion + 1}`
        }
        worktreePath = join(projectWorktreesDir, `${projectName}--${newBranchName}`)
        try {
          if (createScript) {
            const scriptResult = await runWorktreeCreateScript({
              script: createScript,
              projectPath: repoPath,
              worktreePath,
              branchName: newBranchName,
              baseBranch: sourceBranch,
              baseRef: sourceBranch,
              mode: 'duplicate',
              sourceWorktreePath,
              sourceBranch
            })
            if (!scriptResult.success) {
              await cleanupFailedWorktreeCreate(git, worktreePath, newBranchName)
              throw new Error(
                `${scriptResult.error ?? 'Script failed'}\n${scriptResult.output}`
              )
            }
            if (!existsSync(worktreePath)) {
              await cleanupFailedWorktreeCreate(git, worktreePath, newBranchName)
              throw new Error(
                `Worktree create script exited successfully but no worktree exists at ${worktreePath}`
              )
            }
          } else {
            await git.raw(['worktree', 'add', '-b', newBranchName, worktreePath, sourceBranch])
          }
          created = true
          break
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error'
          if (message.toLowerCase().includes('already exists') && attempt < MAX_ATTEMPTS) continue
          throw error
        }
      }
      if (!created) {
        return { success: false as const, error: 'Failed to duplicate worktree after 3 attempts due to name collisions' }
      }

      const sourceGit = simpleGit(sourceWorktreePath)
      const stashRef = (await sourceGit.raw(['stash', 'create'])).trim()
      if (stashRef) {
        try {
          await simpleGit(worktreePath).raw(['stash', 'apply', stashRef])
        } catch {
          // Best-effort carryover; leave the duplicated worktree even if stash application fails.
        }
      }
      const untrackedRaw = await sourceGit.raw(['ls-files', '--others', '--exclude-standard'])
      for (const file of untrackedRaw.trim().split('\n').filter(Boolean)) {
        const srcPath = join(sourceWorktreePath, file)
        const destPath = join(worktreePath, file)
        mkdirSync(dirname(destPath), { recursive: true })
        cpSync(srcPath, destPath)
      }
      return { success: true as const, name: newBranchName, branchName: newBranchName, path: worktreePath, baseBranch: sourceBranch }
    })

  return Git.of({
    repo: {
      getAllBranches,
      getCurrentBranch,
      hasCommits: (repoPath) =>
        tryGit(repoPath, 'git rev-parse HEAD', undefined, (git) =>
          git.raw(['rev-parse', 'HEAD']).then(() => true)
        ).pipe(Effect.catchAll(() => Effect.succeed(false))),
      getDefaultBranch,
      hasUncommittedChanges: (repoPath) =>
        tryGit(repoPath, 'git status --porcelain', undefined, (git) =>
          git.raw(['status', '--porcelain']).then((output) => output.trim().length > 0)
        ).pipe(Effect.catchAll(() => Effect.succeed(false))),
      needsPush: (repoPath) =>
        execGit(repoPath, "git rev-list --count @{u}..HEAD", ['rev-list', '--count', '@{u}..HEAD'], (stdout) =>
          parseInt(stdout.trim(), 10) > 0
        ).pipe(Effect.catchAll(() => Effect.succeed(true))),
      getRemoteUrl: (repoPath, remote = 'origin') =>
        tryGit(repoPath, `git remote get-url ${remote}`, undefined, async (git) => {
          const remotes = await git.getRemotes(true)
          const target = remotes.find((r) => r.name === remote)
          return {
            success: true as const,
            url: target?.refs?.fetch || target?.refs?.push || null,
            remote: target?.name || null
          }
        })
    },
    worktree: {
      list: listWorktrees,
      create: (repoPath, projectName, breedType: BreedType = 'dogs', options) =>
        writeOp(repoPath, 'git worktree add', async (git) => {
          const MAX_ATTEMPTS = 3
          const projectWorktreesDir = ensureWorktreesDir(projectName)
          const defaultBranch = (await git.branch()).current
          const autoPull = options?.autoPull !== false
          const createScript = options?.worktreeCreateScript ?? null
          let pullResult: { success: boolean; updated: boolean } = { success: true, updated: false }
          if (autoPull) {
            try {
              const remotes = await git.getRemotes()
              if (remotes.find((r) => r.name === 'origin')) {
                const result = await git.pull('origin', defaultBranch, { '--ff-only': null })
                pullResult = {
                  success: true,
                  updated: (result.files?.length || 0) > 0 || result.summary.changes > 0
                }
              }
            } catch {
              pullResult = { success: false, updated: false }
            }
          }

          for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            const existingBranches = (await git.branch(['-a'])).all.map((b) =>
              b.startsWith('remotes/origin/') ? b.replace('remotes/origin/', '') : b
            )
            const worktreeOutput = await git.raw(['worktree', 'list', '--porcelain'])
            const existingWorktreeBranches = worktreeOutput
              .split('\n')
              .filter((line) => line.startsWith('branch '))
              .map((line) => line.replace('branch refs/heads/', '').replace('branch ', ''))
            let existingDirs: string[] = []
            try {
              existingDirs = readdirSync(projectWorktreesDir).map((d) =>
                d.startsWith(`${projectName}--`) ? d.slice(projectName.length + 2) : d
              )
            } catch {
              // Missing or unreadable worktree directory only reduces collision hints.
            }
            const breedName = selectUniqueBreedName(
              new Set([...existingBranches, ...existingWorktreeBranches, ...existingDirs]),
              breedType
            )
            const worktreePath = join(projectWorktreesDir, `${projectName}--${breedName}`)
            try {
              if (createScript) {
                const scriptResult = await runWorktreeCreateScript({
                  script: createScript,
                  projectPath: repoPath,
                  worktreePath,
                  branchName: breedName,
                  baseBranch: defaultBranch,
                  baseRef: defaultBranch,
                  mode: 'new'
                })
                if (!scriptResult.success) {
                  await cleanupFailedWorktreeCreate(git, worktreePath, breedName)
                  throw new Error(
                    `${scriptResult.error ?? 'Script failed'}\n${scriptResult.output}`
                  )
                }
                if (!existsSync(worktreePath)) {
                  await cleanupFailedWorktreeCreate(git, worktreePath, breedName)
                  throw new Error(
                    `Worktree create script exited successfully but no worktree exists at ${worktreePath}`
                  )
                }
              } else {
                await git.raw(['worktree', 'add', '-b', breedName, worktreePath, defaultBranch])
              }
              return {
                success: true as const,
                name: breedName,
                branchName: breedName,
                path: worktreePath,
                baseBranch: defaultBranch,
                pullInfo: { pulled: pullResult.success && autoPull, updated: pullResult.updated || false }
              }
            } catch (error) {
              const message = error instanceof Error ? error.message : 'Unknown error'
              if (message.toLowerCase().includes('already exists') && attempt < MAX_ATTEMPTS) continue
              throw error
            }
          }
          return { success: false as const, error: 'Failed to create worktree after 3 attempts due to name collisions' }
        }),
      remove: (repoPath, worktreePath) =>
        writeOp(repoPath, `git worktree remove ${worktreePath}`, async (git) => {
          try {
            await git.raw(['worktree', 'remove', worktreePath, '--force'])
          } catch {
            if (existsSync(worktreePath)) rmSync(worktreePath, { recursive: true, force: true })
            await git.raw(['worktree', 'prune'])
          }
          return { success: true as const }
        }),
      archive: (repoPath, worktreePath, branchName) =>
        Effect.gen(function* () {
          const removeResult = yield* writeOp(repoPath, `git worktree remove ${worktreePath}`, async (git) => {
            try {
              await git.raw(['worktree', 'remove', worktreePath, '--force'])
            } catch {
              if (existsSync(worktreePath)) rmSync(worktreePath, { recursive: true, force: true })
              await git.raw(['worktree', 'prune'])
            }
            return { success: true as const }
          })
          if (!removeResult.success) return removeResult
          yield* tryGit(repoPath, `git branch -D ${branchName}`, undefined, (git) =>
            git.branch(['-D', branchName]).then(() => undefined)
          ).pipe(Effect.catchAll(() => Effect.void))
          yield* deleteRemoteTrackingBranch(repoPath, branchName)
          return { success: true as const }
        }),
      prune: (repoPath) =>
        writeOp(repoPath, 'git worktree prune', (git) =>
          git.raw(['worktree', 'prune']).then(() => undefined)
        ).pipe(Effect.catchAll(() => Effect.void)),
      exists: (_repoPath, worktreePath) => Effect.sync(() => existsSync(worktreePath)),
      duplicate: duplicateWorktree,
      createFromBranch: (repoPath, projectName, branchName, breedType: BreedType = 'dogs', prNumber, options) =>
        Effect.gen(function* () {
          if (prNumber == null) {
            const worktrees = yield* listWorktrees(repoPath)
            const checkedOutWorktree = worktrees.find((worktree) => worktree.branch === branchName)
            if (checkedOutWorktree) {
              const dup = yield* duplicateWorktree(
                repoPath,
                branchName,
                checkedOutWorktree.path,
                projectName,
                options?.nameHint,
                { worktreeCreateScript: options?.worktreeCreateScript ?? null }
              )
              return { ...dup, baseBranch: branchName }
            }
          }

          return yield* writeOp(repoPath, 'git worktree add from branch', async (git) => {
            const projectWorktreesDir = ensureWorktreesDir(projectName)
            const MAX_ATTEMPTS = 3
            const autoPull = options?.autoPull !== false
            const createScript = options?.worktreeCreateScript ?? null
            let pullResult = { success: true, updated: false }
            if (prNumber != null) await git.raw(['fetch', 'origin', `pull/${prNumber}/head`])
            else if (autoPull) {
              try {
                const remotes = await git.getRemotes()
                if (remotes.find((r) => r.name === 'origin')) {
                  const result = await git.pull('origin', branchName, { '--ff-only': null })
                  pullResult = {
                    success: true,
                    updated: (result.files?.length || 0) > 0 || result.summary.changes > 0
                  }
                }
              } catch {
                pullResult = { success: false, updated: false }
              }
            }

            for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
              const existingBranches = (await git.branch(['-a'])).all.map((b) =>
                b.startsWith('remotes/origin/') ? b.replace('remotes/origin/', '') : b
              )
              const worktreeOutput = await git.raw(['worktree', 'list', '--porcelain'])
              const existingWorktreeBranches = worktreeOutput
                .split('\n')
                .filter((line) => line.startsWith('branch '))
                .map((line) => line.replace('branch refs/heads/', '').replace('branch ', ''))
              let existingDirs: string[] = []
              try {
                existingDirs = readdirSync(projectWorktreesDir).map((d) =>
                  d.startsWith(`${projectName}--`) ? d.slice(projectName.length + 2) : d
                )
              } catch {
                // Missing or unreadable worktree directory only reduces collision hints.
              }
              const existingNames = new Set([...existingBranches, ...existingWorktreeBranches, ...existingDirs])
              let worktreeName = options?.nameHint || selectUniqueBreedName(existingNames, breedType)
              if (options?.nameHint && existingNames.has(worktreeName)) {
                let suffix = 2
                while (existingNames.has(`${options.nameHint}-${suffix}`) && suffix <= 9999) suffix += 1
                worktreeName = `${options.nameHint}-${suffix}`
              }
              const worktreePath = join(projectWorktreesDir, `${projectName}--${worktreeName}`)
              const baseRef = prNumber != null ? 'FETCH_HEAD' : branchName
              try {
                if (createScript) {
                  const scriptResult = await runWorktreeCreateScript({
                    script: createScript,
                    projectPath: repoPath,
                    worktreePath,
                    branchName: worktreeName,
                    baseBranch: branchName,
                    baseRef,
                    mode: 'existing'
                  })
                  if (!scriptResult.success) {
                    await cleanupFailedWorktreeCreate(git, worktreePath, worktreeName)
                    throw new Error(
                      `${scriptResult.error ?? 'Script failed'}\n${scriptResult.output}`
                    )
                  }
                  if (!existsSync(worktreePath)) {
                    await cleanupFailedWorktreeCreate(git, worktreePath, worktreeName)
                    throw new Error(
                      `Worktree create script exited successfully but no worktree exists at ${worktreePath}`
                    )
                  }
                } else {
                  await git.raw(['worktree', 'add', '-b', worktreeName, worktreePath, baseRef])
                }
                return {
                  success: true as const,
                  path: worktreePath,
                  branchName: worktreeName,
                  name: worktreeName,
                  baseBranch: branchName,
                  pullInfo: { pulled: prNumber == null && pullResult.success && autoPull, updated: pullResult.updated || false }
                }
              } catch (error) {
                const message = error instanceof Error ? error.message : 'Unknown error'
                if (message.toLowerCase().includes('already exists') && attempt < MAX_ATTEMPTS) continue
                throw error
              }
            }
            return { success: false as const, error: 'Failed to create worktree from branch after 3 attempts due to name collisions' }
          })
        })
    },
    branch: {
      exists: branchExists,
      rename: (_repoPath, worktreePath, oldBranch, newBranch) =>
        writeOp(worktreePath, `git branch -m ${oldBranch} ${newBranch}`, (git) =>
          git.branch(['-m', oldBranch, newBranch]).then(() => ({ success: true as const }))
        ),
      delete: (repoPath, branchName) =>
        writeOp(repoPath, `git branch -D ${branchName}`, (git) =>
          git.branch(['-D', branchName]).then(() => ({ success: true as const }))
        ),
      isMerged: (repoPath, branch) =>
        tryGit(repoPath, `git rev-list --count HEAD..${branch}`, undefined, (git) =>
          git.raw(['rev-list', '--count', `HEAD..${branch}`]).then((result) => ({
            success: true as const,
            isMerged: (parseInt(result.trim(), 10) || 0) === 0
          }))
        ).pipe(Effect.catchAll(() => Effect.succeed({ success: true as const, isMerged: false }))),
      info: (repoPath) =>
        tryGit(repoPath, 'git status', undefined, async (git) => {
          const status = await git.status()
          return {
            success: true as const,
            branch: {
              name: status.current || 'HEAD',
              tracking: status.tracking || null,
              ahead: status.tracking ? status.ahead : 0,
              behind: status.tracking ? status.behind : 0
            }
          }
        }),
      listWithStatus: (repoPath) =>
        tryGit(repoPath, 'git branch -a && git worktree list --porcelain', undefined, async (git) => {
          const [branchSummary, worktreeList] = await Promise.all([
            git.branch(['-a']),
            git.raw(['worktree', 'list', '--porcelain'])
          ])
          const checkedOut = new Map<string, string>()
          for (const block of worktreeList.split('\n\n').filter(Boolean)) {
            const lines = block.split('\n')
            const wtPath = lines.find((l) => l.startsWith('worktree '))?.replace('worktree ', '')
            const branch = lines.find((l) => l.startsWith('branch '))?.replace('branch refs/heads/', '')
            if (wtPath && branch) checkedOut.set(branch, wtPath)
          }
          return Object.entries(branchSummary.branches).map(([name, info]) => ({
            name: normalizeBranchDisplayName(name),
            isRemote: name.startsWith('remotes/'),
            isCheckedOut: checkedOut.has(info.name),
            worktreePath: checkedOut.get(info.name)
          }))
        })
    },
    file: {
      status: (repoPath) =>
        tryGit(repoPath, 'git status', undefined, async (git) => {
          const status = await git.status()
          const files: GitFileStatus[] = []
          const conflictedSet = new Set(status.conflicted)
          for (const fileStatus of status.files) {
            const filePath = fileStatus.path
            const fullPath = join(repoPath, filePath)
            const idx = fileStatus.index
            const wd = fileStatus.working_dir
            if (conflictedSet.has(filePath)) {
              files.push({ path: fullPath, relativePath: filePath, status: 'C', staged: false })
              continue
            }
            if (idx === '?' && wd === '?') {
              files.push({ path: fullPath, relativePath: filePath, status: '?', staged: false })
              continue
            }
            if (idx === 'M' || idx === 'A' || idx === 'D' || idx === 'R' || idx === 'C') {
              files.push({ path: fullPath, relativePath: filePath, status: idx === 'D' ? 'D' : idx === 'M' ? 'M' : 'A', staged: true })
            }
            if (wd === 'M' || wd === 'D') {
              files.push({ path: fullPath, relativePath: filePath, status: wd === 'D' ? 'D' : 'M', staged: false })
            }
          }
          return { success: true as const, files }
        }),
      stage: (repoPath, filePath) =>
        writeOp(repoPath, `git add ${filePath}`, (git) =>
          git.add(filePath).then(() => ({ success: true as const }))
        ),
      unstage: (repoPath, filePath) =>
        writeOp(repoPath, `git reset HEAD -- ${filePath}`, (git) =>
          git.reset(['HEAD', '--', filePath]).then(() => ({ success: true as const }))
        ),
      stageAll: (repoPath) =>
        writeOp(repoPath, 'git add -A', (git) => git.add(['-A']).then(() => ({ success: true as const }))),
      unstageAll: (repoPath) =>
        writeOp(repoPath, 'git reset HEAD', (git) =>
          git.reset(['HEAD']).then(() => ({ success: true as const }))
        ),
      discard: (repoPath, filePath) =>
        writeOp(repoPath, `git checkout -- ${filePath}`, async (git) => {
          const status = await git.status()
          if (status.not_added.includes(filePath)) {
            const fullPath = join(repoPath, filePath)
            if (existsSync(fullPath)) unlinkSync(fullPath)
          } else {
            await git.checkout(['--', filePath])
          }
          return { success: true as const }
        }),
      addToGitignore: (repoPath, pattern) =>
        writeOp(repoPath, `add ${pattern} to .gitignore`, async () => {
          const gitignorePath = join(repoPath, '.gitignore')
          let content = ''
          if (existsSync(gitignorePath)) content = readFileSync(gitignorePath, 'utf-8')
          const lines = content.split('\n').map((l) => l.trim())
          if (lines.includes(pattern)) return { success: true as const }
          const newLine = content.endsWith('\n') || content === '' ? pattern : `\n${pattern}`
          if (content === '') writeFileSync(gitignorePath, `${pattern}\n`)
          else appendFileSync(gitignorePath, `${newLine}\n`)
          return { success: true as const }
        }),
      stageHunk: (repoPath, patch) => applyPatchString(repoPath, patch, ['--cached', '--unidiff-zero'], 'git apply --cached'),
      unstageHunk: (repoPath, patch) => applyPatchString(repoPath, patch, ['--cached', '--reverse', '--unidiff-zero'], 'git apply --cached --reverse'),
      revertHunk: (repoPath, patch) => applyPatchString(repoPath, patch, ['--reverse', '--unidiff-zero'], 'git apply --reverse')
    },
    commit: {
      commit: (repoPath, message) =>
        writeOp(repoPath, 'git commit', async (git) => {
          if (!message || message.trim() === '') {
            return { success: false as const, error: 'Commit message is required' }
          }
          const status = await git.status()
          const hasStagedChanges = status.staged.length > 0 || status.created.length > 0
          if (!hasStagedChanges) return { success: false as const, error: 'No staged changes to commit' }
          const result = await git.commit(message)
          return { success: true as const, commitHash: result.commit }
        }),
      push: (repoPath, remote, branch, force) =>
        writeOp(repoPath, 'git push', async (git) => {
          const remoteName = remote || 'origin'
          const branchName = branch || (await git.branch()).current
          const options: string[] = []
          if (force) options.push('--force')
          const status = await git.status()
          if (!status.tracking) options.push('--set-upstream')
          await git.push(remoteName, branchName, options)
          return { success: true as const, pushed: true }
        }),
      pull: (repoPath, remote, branch, rebase) =>
        writeOp(repoPath, 'git pull', async (git) => {
          const remoteName = remote || 'origin'
          const branchName = branch || (await git.branch()).current
          const options: Record<string, null | string | number> = {}
          if (rebase) options['--rebase'] = null
          const result = await git.pull(remoteName, branchName, options)
          return {
            success: true as const,
            updated: (result.files?.length || 0) > 0 || result.summary.changes > 0
          }
        }),
      pullBaseBranch,
      merge: (repoPath, sourceBranch) =>
        writeOp(repoPath, `git merge ${sourceBranch}`, (git) =>
          git.merge([sourceBranch]).then(() => ({ success: true as const }))
        , 'merge'),
      mergeAbort: (repoPath) =>
        writeOp(repoPath, 'git merge --abort', (git) =>
          git.raw(['merge', '--abort']).then(() => ({ success: true as const }))
        )
    },
    diff: {
      getDiff: (repoPath, filePath, staged = false, contextLines) =>
        tryGit(repoPath, 'git diff', undefined, async (git) => {
          const args = ['diff']
          if (contextLines !== undefined) args.push(`-U${contextLines}`)
          if (staged) args.push('--cached')
          args.push('--', filePath)
          const result = await git.raw(args)
          return { success: true as const, diff: result || '', fileName: basename(filePath) || filePath }
        }),
      getUntrackedFileDiff: (repoPath, filePath) =>
        Effect.try({
          try: () => {
            const content = readFileSync(join(repoPath, filePath), 'utf-8')
            const lines = content.split('\n')
            return {
              success: true as const,
              diff: [
                `diff --git a/${filePath} b/${filePath}`,
                'new file mode 100644',
                '--- /dev/null',
                `+++ b/${filePath}`,
                `@@ -0,0 +1,${lines.length} @@`,
                ...lines.map((line) => `+${line}`)
              ].join('\n'),
              fileName: basename(filePath) || filePath
            }
          },
          catch: (err) => classifyGitError(err, { worktreePath: repoPath, command: 'read untracked file' })
        }),
      getDiffStat: (repoPath) =>
        tryGit(repoPath, 'git diff --numstat', undefined, async (git) => {
          const files: GitDiffStatFile[] = []
          const seen = new Set<string>()
          const addFile = (file: GitDiffStatFile) => {
            if (seen.has(file.path)) {
              const existing = files.find((f) => f.path === file.path)
              if (existing && !file.binary) {
                existing.additions += file.additions
                existing.deletions += file.deletions
              }
              return
            }
            seen.add(file.path)
            files.push(file)
          }
          for (const line of (await git.raw(['diff', '--cached', '--numstat'])).trim().split('\n')) {
            if (!line) continue
            const parsed = parseNumstat(line)
            if (parsed) addFile(parsed)
          }
          for (const line of (await git.raw(['diff', '--numstat'])).trim().split('\n')) {
            if (!line) continue
            const parsed = parseNumstat(line)
            if (parsed) addFile(parsed)
          }
          const status = await git.status()
          for (const file of status.not_added) {
            if (seen.has(file)) continue
            seen.add(file)
            const text = await readFileAsync(join(repoPath, file), 'utf-8').catch(() => null)
            files.push({ path: file, additions: text ? text.split('\n').length : 0, deletions: 0, binary: false })
          }
          return { success: true as const, files }
        }),
      branchDiffShortStat: (repoPath, baseBranch) =>
        tryGit(repoPath, `git diff --shortstat ${baseBranch}...HEAD`, undefined, async (git) => {
          const stat = parseShortStat(await git.raw(['diff', '--shortstat', `${baseBranch}...HEAD`]))
          const revList = await git.raw(['rev-list', '--count', `${baseBranch}..HEAD`])
          return {
            success: true as const,
            ...stat,
            commitsAhead: parseInt(revList.trim(), 10) || 0
          }
        }),
      branchDiffFiles: (repoPath, branch) =>
        invalidBranch(branch)
          ? Effect.succeed({ success: false as const, error: 'Invalid branch name' })
          : Effect.gen(function* () {
              const mergeBase = yield* getMergeBase(repoPath, branch)
              const diffRef = mergeBase ?? branch
              return yield* tryGit(repoPath, `git diff ${diffRef}`, undefined, async (git) => {
                const [nameStatusResult, numstatResult] = await Promise.all([
                  git.raw(['diff', '--name-status', '--no-renames', diffRef]),
                  git.raw(['diff', '--numstat', '--no-renames', diffRef])
                ])
                const files = new Map<string, GitBranchDiffFile>()
                for (const line of nameStatusResult.trim().split('\n')) {
                  if (!line) continue
                  const [status, ...pathParts] = line.split('\t')
                  const relativePath = pathParts.join('\t')
                  if (status && relativePath) {
                    files.set(relativePath, { relativePath, status, additions: 0, deletions: 0, binary: false })
                  }
                }
                for (const line of numstatResult.trim().split('\n')) {
                  if (!line) continue
                  const [add, del, ...pathParts] = line.split('\t')
                  const relativePath = pathParts.join('\t')
                  if (!relativePath) continue
                  const binary = add === '-' || del === '-'
                  files.set(relativePath, {
                    relativePath,
                    status: files.get(relativePath)?.status ?? '',
                    additions: binary ? 0 : parseInt(add, 10) || 0,
                    deletions: binary ? 0 : parseInt(del, 10) || 0,
                    binary
                  })
                }
                return {
                  success: true as const,
                  files: Array.from(files.values()).sort((a, b) => {
                    const aMissingStatus = a.status === ''
                    const bMissingStatus = b.status === ''
                    if (aMissingStatus === bMissingStatus) return 0
                    return aMissingStatus ? 1 : -1
                  })
                }
              })
            }),
      branchFileDiff: (repoPath, branch, filePath) =>
        invalidBranch(branch)
          ? Effect.succeed({ success: false as const, error: 'Invalid branch name' })
          : Effect.gen(function* () {
              const mergeBase = yield* getMergeBase(repoPath, branch)
              const diffRef = mergeBase ?? branch
              return yield* tryGit(repoPath, `git diff ${diffRef} -- ${filePath}`, undefined, (git) =>
                git.raw(['diff', diffRef, '--', filePath]).then((result) => ({ success: true as const, diff: result || '' }))
              )
            }),
      getRangeDiff: (repoPath, baseBranch) => {
        if (invalidBranch(baseBranch)) return Effect.succeed({ commitSummary: '', diffSummary: '', diffPatch: '', commitCount: 0 })
        const MAX_SUMMARY = 20 * 1024
        const MAX_PATCH = 60 * 1024
        const emptyOnFail = <A>(effect: Effect.Effect<A, GitError>, fallback: A) =>
          Effect.either(effect).pipe(Effect.map((result) => (Either.isRight(result) ? result.right : fallback)))
        return Effect.all([
          emptyOnFail(execGit(repoPath, 'git log', ['log', '--oneline', `${baseBranch}..HEAD`], (stdout) => stdout), ''),
          emptyOnFail(execGit(repoPath, 'git diff --stat', ['diff', '--stat', `${baseBranch}...HEAD`], (stdout) => stdout), ''),
          emptyOnFail(execGit(repoPath, 'git diff --patch', ['diff', '--patch', '--minimal', `${baseBranch}...HEAD`], (stdout) => stdout, { maxBuffer: MAX_PATCH * 2 }), ''),
          emptyOnFail(execGit(repoPath, 'git rev-list --count', ['rev-list', '--count', `${baseBranch}..HEAD`], (stdout) => parseInt(stdout.trim(), 10) || 0), 0)
        ]).pipe(
          Effect.map(([commitLog, diffStat, diffPatch, revCount]) => ({
            commitSummary: commitLog.slice(0, MAX_SUMMARY),
            diffSummary: diffStat.slice(0, MAX_SUMMARY),
            diffPatch: diffPatch.slice(0, MAX_PATCH),
            commitCount: revCount
          }))
        )
      }
    },
    content: {
      getRefContent,
      getRefContentBase64,
      getBranchBaseContent: (repoPath, branch, filePath) =>
        invalidBranch(branch)
          ? Effect.succeed({ success: false as const, error: 'Invalid branch name' })
          : Effect.gen(function* () {
              const mergeBase = yield* getMergeBase(repoPath, branch)
              return yield* getRefContent(repoPath, mergeBase ?? branch, filePath)
            }),
      getBranchBaseContentBase64: (repoPath, branch, filePath) =>
        invalidBranch(branch)
          ? Effect.succeed({ success: false as const, error: 'Invalid branch name' })
          : Effect.gen(function* () {
              const mergeBase = yield* getMergeBase(repoPath, branch)
              return yield* getRefContentBase64(repoPath, mergeBase ?? branch, filePath)
            })
    },
    pr: {
      createPullRequest: (repoPath, options) => {
        if (invalidBranch(options.baseBranch)) {
          return Effect.succeed({ success: false as const, error: 'Invalid branch name' })
        }
        return writeOp(repoPath, 'gh pr create', async () => {
          const baseBranch = options.baseBranch.replace(/^[^/]+\//, '')
          const tempDir = mkdtempSync(join(tmpdir(), 'hive-gh-pr-'))
          const tempFile = join(tempDir, 'body.md')
          try {
            writeFileSync(tempFile, options.body, 'utf-8')
            const { stdout } = await execFileAsync('gh', ['pr', 'create', '--base', baseBranch, '--title', options.title, '--body-file', tempFile], { cwd: repoPath })
            const url = stdout.trim()
            const match = url.match(/\/pull\/(\d+)/)
            return { success: true as const, url, number: match ? parseInt(match[1], 10) : undefined }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (/already exists/i.test(message)) {
              const urlMatch = message.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/)
              const prUrl = urlMatch?.[0]
              const numMatch = prUrl?.match(/\/pull\/(\d+)/)
              return {
                success: false as const,
                error: message,
                url: prUrl,
                number: numMatch ? parseInt(numMatch[1], 10) : undefined
              }
            }
            throw error
          } finally {
            try {
              rmSync(tempDir, { recursive: true, force: true })
            } catch {
              // Temporary cleanup failure should not mask the pull request result.
            }
          }
        }).pipe(
          Effect.mapError((error) =>
            /spawn gh ENOENT|gh: command not found/i.test(error.stderrExcerpt ?? '')
              ? new GitUnknown({ ...error, stderrExcerpt: 'GitHub CLI is not installed or not in PATH' })
              : error
          )
        )
      }
    }
  })
})

export const GitLive = Layer.effect(Git, make)
