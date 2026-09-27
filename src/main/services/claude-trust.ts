import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import type { Project } from '../db/types'
import { atomicWriteJson } from './atomic-json'
import { getUserEnvironmentVariables } from './env-vars'
import { createLogger } from './logger'

const log = createLogger({ component: 'ClaudeTrust' })

/** The slice of DatabaseService the trust pre-flight needs (kept narrow for tests). */
interface TrustCheckDb {
  getProject(id: string): Project | null
  updateProjectTrustCheck(projectId: string, done: boolean): void
  getSetting(key: string): string | null
}

/** Mirror the claude CLI's own config resolution — `$CLAUDE_CONFIG_DIR/.claude.json`
 * when the variable is set, else `~/.claude.json`. `env` must be the environment
 * the spawned CLI will actually see, or the trust write lands in a file the CLI
 * never reads. */
export function resolveClaudeConfigPath(env: Record<string, string | undefined>): string {
  return join(env.CLAUDE_CONFIG_DIR || homedir(), '.claude.json')
}

// Serializes read-modify-write cycles on the config file so concurrent session
// launches (e.g. a multi-model ticket launching several sessions at once)
// can't interleave and drop each other's writes.
let writeChain: Promise<unknown> = Promise.resolve()

/**
 * Ensure `projects[folderPath].hasTrustDialogAccepted === true` in the claude
 * CLI config at `configPath`, creating the file or the entry as needed while
 * preserving everything else. Returns false without touching the file when it
 * exists but can't be parsed — it also holds oauth state, so clobbering it is
 * far worse than letting the CLI show its trust dialog.
 */
export async function ensureFolderTrustedInClaudeConfig(
  configPath: string,
  folderPath: string
): Promise<boolean> {
  return ensureFoldersTrustedInClaudeConfig(configPath, [folderPath])
}

/** Multi-folder form of `ensureFolderTrustedInClaudeConfig`: one read-modify-write
 * for all `folderPaths`, so a launch that needs both the repo root and its
 * worktree trusted costs a single config rewrite. */
export async function ensureFoldersTrustedInClaudeConfig(
  configPath: string,
  folderPaths: string[]
): Promise<boolean> {
  const run = writeChain.then(() => ensureFoldersTrusted(configPath, folderPaths))
  writeChain = run.catch(() => undefined)
  return run
}

async function ensureFoldersTrusted(configPath: string, folderPaths: string[]): Promise<boolean> {
  let config: Record<string, unknown> = {}
  if (existsSync(configPath)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(configPath, 'utf-8'))
    } catch (error) {
      log.warn('Claude config exists but is unparseable; leaving it untouched', {
        configPath,
        error: error instanceof Error ? error.message : String(error)
      })
      return false
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      log.warn('Claude config is not a JSON object; leaving it untouched', { configPath })
      return false
    }
    config = parsed as Record<string, unknown>
  }

  const projects =
    typeof config.projects === 'object' &&
    config.projects !== null &&
    !Array.isArray(config.projects)
      ? (config.projects as Record<string, unknown>)
      : {}

  const newlyTrusted: string[] = []
  for (const folderPath of new Set(folderPaths)) {
    const entry =
      typeof projects[folderPath] === 'object' && projects[folderPath] !== null
        ? (projects[folderPath] as Record<string, unknown>)
        : {}
    if (entry.hasTrustDialogAccepted === true) continue
    projects[folderPath] = { ...entry, hasTrustDialogAccepted: true }
    newlyTrusted.push(folderPath)
  }
  if (newlyTrusted.length === 0) {
    return true
  }

  config.projects = projects
  await atomicWriteJson(configPath, config, { pretty: true })
  log.info('Marked folders trusted in claude config', { configPath, folderPaths: newlyTrusted })
  return true
}

/**
 * Pre-flight before spawning a claude CLI session: make sure every folder the
 * CLI could resolve trust from is trusted in ~/.claude.json, so it doesn't
 * stall on the folder-trust dialog (which would swallow an argv prompt behind
 * an interactive question).
 *
 * The CLI keys trust by cwd and inherits it from ancestor directories only.
 * Sessions run inside `~/.hive-worktrees/<project>/<branch>`, which is *not*
 * under the repo root, so trusting the root alone still leaves the dialog up
 * for every worktree (unless the user happens to have trusted `~` itself).
 * The worktree path is therefore trusted on every launch — an already-trusted
 * entry is a single config read with no rewrite. The repo root is checked once
 * per project and then stamped `trust_check_done`.
 *
 * Connection projects are skipped — their sessions run against remote hosts,
 * where the local config has no bearing. Never throws: a failed pre-flight
 * must not block the session launch.
 */
export async function ensureProjectTrustCheck(
  db: TrustCheckDb,
  projectId: string,
  opts?: { configPath?: string; worktreePath?: string | null }
): Promise<void> {
  try {
    const project = db.getProject(projectId)
    if (!project) return
    if ((project.kind ?? 'git') !== 'git') return

    const needsRootCheck = !project.trust_check_done
    const folders: string[] = []
    if (needsRootCheck) folders.push(project.path)
    if (opts?.worktreePath && opts.worktreePath !== project.path) {
      folders.push(opts.worktreePath)
    }
    if (folders.length === 0) return

    // The spawned CLI's env is process.env with the user's settings env vars
    // assigned on top (see pty-service/claude-cli-spawner) — resolve the config
    // path from that same view.
    const configPath =
      opts?.configPath ??
      resolveClaudeConfigPath({ ...process.env, ...getUserEnvironmentVariables(db) })
    const trusted = await ensureFoldersTrustedInClaudeConfig(configPath, folders)
    if (trusted && needsRootCheck) {
      db.updateProjectTrustCheck(project.id, true)
    }
  } catch (error) {
    log.warn('Claude trust pre-flight failed; continuing session launch', {
      projectId,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}
