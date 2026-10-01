import { execFile } from 'child_process'
import { appendFile, lstat, mkdir, readFile, readdir, realpath, stat } from 'fs/promises'
import { homedir } from 'os'
import { dirname, join, resolve } from 'path'
import { promisify } from 'util'
import YAML from 'yaml'
import type { ProjectSkillsListing, SetDisabledSkillsResult, SkillInfo } from '@shared/types/skills'
import { atomicWriteJson } from './atomic-json'
import { getUserEnvironmentVariables } from './env-vars'
import { createLogger } from './logger'

const log = createLogger({ component: 'ClaudeSkills' })

const execFileAsync = promisify(execFile)

const SKILL_FILE = 'SKILL.md'
// Account-synced skills live under `skills/synced/` and are namespaced separately
// by the CLI, so the directory itself is never a skill.
const RESERVED_SKILL_DIR = 'synced'
const LOCAL_SETTINGS_FILE = 'settings.local.json'
const LOCAL_SETTINGS_GIT_PATH = `.claude/${LOCAL_SETTINGS_FILE}`
const GIT_TIMEOUT_MS = 5000

const SKILL_OVERRIDE_VALUES = ['on', 'name-only', 'user-invocable-only', 'off'] as const
type SkillOverride = (typeof SKILL_OVERRIDE_VALUES)[number]
/** One settings file's `skillOverrides`, keyed by skill directory name. */
type SkillOverrides = Map<string, SkillOverride>

/** Mirror the claude CLI's own config dir resolution — `$CLAUDE_CONFIG_DIR` when the
 * variable is set and non-blank, else `~/.claude`. `env` must be the environment the
 * spawned CLI will actually see, or we list skills from a directory it never reads. */
export function resolveClaudeConfigDir(env: Record<string, string | undefined>): string {
  const configured = env.CLAUDE_CONFIG_DIR
  return typeof configured === 'string' && configured.trim().length > 0
    ? configured
    : join(homedir(), '.claude')
}

// The spawned CLI's env is process.env with the user's settings env vars assigned
// on top (see claude-trust) — resolve the config dir from that same view. The db is
// imported lazily so this module stays loadable without one; if it can't be
// reached, process.env alone is the best view we have.
async function resolveDefaultConfigDir(): Promise<string> {
  let userEnv: Record<string, string> = {}
  try {
    const { getDatabase } = await import('../db')
    userEnv = getUserEnvironmentVariables(getDatabase())
  } catch (error) {
    log.warn('Could not read user environment variables; using process.env only', {
      error: errorMessage(error)
    })
  }
  return resolveClaudeConfigDir({ ...process.env, ...userEnv })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stripBom(raw: string): string {
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
}

/** Fallback for frontmatter the YAML parser rejects — most often an unquoted value
 * containing ": " (`description: Use when: ...`). Picks out single-line top-level
 * `name` / `description` values; block scalars are left alone. */
function scanFrontmatterLines(block: string): Record<string, unknown> {
  const fields: Record<string, unknown> = {}
  for (const line of block.split(/\r?\n/)) {
    const match = line.match(/^(name|description):[ \t]*(.*)$/)
    if (!match) continue
    const value = match[2].trim()
    if (/^[|>][+-]?\d*$/.test(value)) continue
    fields[match[1]] = value.replace(/^(['"])(.*)\1$/, '$2')
  }
  return fields
}

/** Lenient frontmatter read: never throws, and anything unusable is just `{}`. */
function parseSkillFrontmatter(raw: string): Record<string, unknown> {
  const match = stripBom(raw).match(/^---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/)
  if (!match) return {}
  try {
    const document = YAML.parseDocument(match[1])
    if (document.errors.length > 0) return scanFrontmatterLines(match[1])
    const data: unknown = document.toJSON()
    return isPlainObject(data) ? data : {}
  } catch {
    return scanFrontmatterLines(match[1])
  }
}

async function readSkill(skillsDir: string, id: string): Promise<SkillInfo | null> {
  const skillFile = join(skillsDir, id, SKILL_FILE)
  try {
    // stat follows symlinks, so a symlinked skill directory resolves here too. It
    // also rejects plain files and directories that have no SKILL.md.
    if (!(await stat(skillFile)).isFile()) return null
  } catch {
    return null
  }

  let frontmatter: Record<string, unknown> = {}
  try {
    frontmatter = parseSkillFrontmatter(await readFile(skillFile, 'utf-8'))
  } catch (error) {
    log.warn('Could not read skill file; listing the skill without metadata', {
      skillFile,
      error: errorMessage(error)
    })
  }

  const name = typeof frontmatter.name === 'string' ? frontmatter.name.trim() : ''
  const description =
    typeof frontmatter.description === 'string' ? frontmatter.description.trim() : ''
  return { id, name: name || id, description: description || null }
}

/**
 * List the skills directly inside `skillsDir` (`<skillsDir>/<id>/SKILL.md`), the
 * way the claude CLI discovers them: one level deep, symlinked directories
 * followed, dot-directories and the reserved `synced` directory skipped. The id
 * is the directory name exactly as the filesystem reports it — that is the key
 * the CLI uses in `skillOverrides`, whatever the frontmatter `name` says.
 */
export async function listSkillsInDir(skillsDir: string): Promise<SkillInfo[]> {
  let entries: string[]
  try {
    entries = await readdir(skillsDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('Could not read skills directory', { skillsDir, error: errorMessage(error) })
    }
    return []
  }

  const skills = await Promise.all(
    entries
      .filter((entry) => !entry.startsWith('.') && entry !== RESERVED_SKILL_DIR)
      .map((entry) => readSkill(skillsDir, entry))
  )
  return skills
    .filter((skill): skill is SkillInfo => skill !== null)
    .sort((a, b) => a.id.localeCompare(b.id))
}

function isSkillOverride(value: unknown): value is SkillOverride {
  return (SKILL_OVERRIDE_VALUES as readonly unknown[]).includes(value)
}

// The CLI refuses to store an override under this key ("rename its folder"), so an
// entry for it is neither read nor written.
const isConfigurableSkillId = (id: string): boolean => id !== '__proto__'

/** The overrides the CLI would take from a parsed settings file's `skillOverrides`,
 * or null when it would reject them. The CLI drops a whole settings file over a
 * single invalid value, so one bad entry voids every entry beside it. */
function toSkillOverrides(value: unknown): SkillOverrides | null {
  if (!isPlainObject(value)) return null
  const overrides: SkillOverrides = new Map()
  for (const [id, override] of Object.entries(value)) {
    if (!isSkillOverride(override)) return null
    if (isConfigurableSkillId(id)) overrides.set(id, override)
  }
  return overrides
}

/** Lenient read of one settings layer: a missing or unusable file has no overrides. */
async function readSkillOverrides(settingsPath: string): Promise<SkillOverrides> {
  try {
    const parsed: unknown = JSON.parse(stripBom(await readFile(settingsPath, 'utf-8')))
    return (isPlainObject(parsed) ? toSkillOverrides(parsed.skillOverrides) : null) ?? new Map()
  } catch {
    return new Map()
  }
}

/** First layer that mentions the skill wins; `layers` is ordered highest precedence first. */
function effectiveOverride(id: string, layers: SkillOverrides[]): SkillOverride | undefined {
  for (const layer of layers) {
    const override = layer.get(id)
    if (override !== undefined) return override
  }
  return undefined
}

/**
 * Global skills (read-only) plus the project's own skills with their effective
 * enabled state. A skill is disabled when its `skillOverrides` value is "off",
 * resolved per key as `.claude/settings.local.json` > `.claude/settings.json` >
 * `<configDir>/settings.json`.
 */
export async function listProjectSkills(
  projectPath: string,
  opts?: { configDir?: string }
): Promise<ProjectSkillsListing> {
  const configDir = opts?.configDir ?? (await resolveDefaultConfigDir())
  const claudeDir = join(projectPath, '.claude')
  const [globalSkills, projectSkills, ...layers] = await Promise.all([
    listSkillsInDir(join(configDir, 'skills')),
    listSkillsInDir(join(claudeDir, 'skills')),
    readSkillOverrides(join(claudeDir, LOCAL_SETTINGS_FILE)),
    readSkillOverrides(join(claudeDir, 'settings.json')),
    readSkillOverrides(join(configDir, 'settings.json'))
  ])

  return {
    globalSkills,
    projectSkills: projectSkills.map((skill) => ({
      ...skill,
      enabled: effectiveOverride(skill.id, layers) !== 'off'
    }))
  }
}

// Serializes read-modify-write cycles on settings.local.json so overlapping saves
// can't interleave and drop each other's writes.
let writeChain: Promise<unknown> = Promise.resolve()

/**
 * Make `disabledSkills` the set of disabled skills for the project by editing
 * `skillOverrides` in `<projectPath>/.claude/settings.local.json` — the same file
 * and key the CLI's own /skills menu writes. Only skills that exist in the project
 * and whose effective state actually differs are touched; everything else in the
 * file is preserved, and nothing is written when nothing changes. Never throws.
 */
export async function setDisabledProjectSkills(
  projectPath: string,
  disabledSkills: string[],
  opts?: { configDir?: string }
): Promise<SetDisabledSkillsResult> {
  const run = writeChain.then(() => applyDisabledProjectSkills(projectPath, disabledSkills, opts))
  writeChain = run.catch(() => undefined)
  try {
    return await run
  } catch (error) {
    log.error(
      'Failed to save disabled skills',
      error instanceof Error ? error : new Error(String(error)),
      { projectPath }
    )
    return { success: false, error: errorMessage(error) }
  }
}

async function applyDisabledProjectSkills(
  projectPath: string,
  disabledSkills: string[],
  opts?: { configDir?: string }
): Promise<SetDisabledSkillsResult> {
  const fail = (error: string): SetDisabledSkillsResult => {
    log.warn('Not saving disabled skills', { projectPath, error })
    return { success: false, error }
  }

  const projectStat = await stat(projectPath).catch(() => null)
  if (!projectStat?.isDirectory()) {
    return fail(`Project folder not found: ${projectPath}`)
  }

  const claudeDir = join(projectPath, '.claude')
  const localPath = join(claudeDir, LOCAL_SETTINGS_FILE)

  let settings: Record<string, unknown> = {}
  let localExists = true
  let raw = ''
  try {
    raw = stripBom(await readFile(localPath, 'utf-8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return fail(`Could not read ${localPath}: ${errorMessage(error)}`)
    }
    // ENOENT also comes back for a symlink whose target is missing (e.g. a dotfiles
    // checkout that isn't mounted); renaming over the link would silently replace it.
    const link = await lstat(localPath).catch(() => null)
    if (link?.isSymbolicLink()) {
      return fail(
        `${localPath} is a symlink whose target is missing. Restore the target or remove the link, then try again.`
      )
    }
    localExists = false
  }
  // An empty file holds nothing to clobber; anything else must parse to an object,
  // or we leave it alone — it carries the user's permissions and other settings.
  if (raw.trim() !== '') {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return fail(`${localPath} is not valid JSON. Fix or remove it, then try again.`)
    }
    if (!isPlainObject(parsed)) {
      return fail(`${localPath} is not a JSON object. Fix or remove it, then try again.`)
    }
    settings = parsed
  }

  const configDir = opts?.configDir ?? (await resolveDefaultConfigDir())
  const [projectSkills, projectOverrides, userOverrides] = await Promise.all([
    listSkillsInDir(join(claudeDir, 'skills')),
    readSkillOverrides(join(claudeDir, 'settings.json')),
    readSkillOverrides(join(configDir, 'settings.json'))
  ])
  const localOverrides = toSkillOverrides(settings.skillOverrides)
  const lowerLayers = [projectOverrides, userOverrides]
  const allLayers = [localOverrides ?? new Map(), ...lowerLayers]

  // Edited as a Map and rebuilt with Object.fromEntries so a skill named like an
  // Object.prototype member (e.g. "__proto__") stays an ordinary own key.
  const nextOverrides = new Map<string, unknown>(localOverrides ?? [])
  const disabled = new Set(disabledSkills)
  let changed = false
  for (const { id } of projectSkills) {
    const wantEnabled = !disabled.has(id)
    if (!isConfigurableSkillId(id)) {
      if (wantEnabled) continue
      return fail(
        `Claude Code can't store a setting for a skill named "${id}". Rename its folder to configure it.`
      )
    }
    if ((effectiveOverride(id, allLayers) !== 'off') === wantEnabled) continue
    changed = true
    if (!wantEnabled) {
      nextOverrides.set(id, 'off')
    } else if (effectiveOverride(id, lowerLayers) === 'off') {
      // A shared settings file disables it, so dropping our key would not re-enable it.
      nextOverrides.set(id, 'on')
    } else {
      nextOverrides.delete(id)
    }
  }
  if (!changed) return { success: true }

  // The CLI ignores a settings file with an invalid skillOverrides, so a write on
  // top of one would report success and change nothing.
  if (settings.skillOverrides !== undefined && localOverrides === null) {
    return fail(
      `${localPath} has a "skillOverrides" value Claude Code does not accept ` +
        `(expected an object of "on", "name-only", "user-invocable-only" or "off"). ` +
        `Fix it, then try again.`
    )
  }

  if (nextOverrides.size > 0) {
    settings.skillOverrides = Object.fromEntries(nextOverrides)
  } else {
    delete settings.skillOverrides
  }

  // Write through a symlinked settings file rather than replacing the link, and
  // keep the permissions the file already has. A new file gets what a plain create
  // would under the user's umask — the CLI later adds permissions and env values
  // (often tokens) to it, so it must not end up more readable than they expect.
  const writePath = localExists ? await realpath(localPath).catch(() => localPath) : localPath
  const existingStat = localExists ? await stat(writePath).catch(() => null) : null
  await atomicWriteJson(writePath, settings, {
    pretty: true,
    mode: existingStat ? existingStat.mode & 0o777 : 0o666 & ~process.umask()
  })
  log.info('Updated project skill overrides', { localPath })

  if (!localExists) {
    await ensureLocalSettingsGitIgnored(projectPath)
  }
  return { success: true }
}

/**
 * After creating `.claude/settings.local.json` in a git repo that doesn't already
 * ignore it, add it to the repo's `info/exclude` so personal settings aren't
 * committed by accident — the CLI adds an ignore rule too when it creates the file
 * itself. Best-effort: never fails the save.
 */
async function ensureLocalSettingsGitIgnored(projectPath: string): Promise<void> {
  const git = (args: string[]): Promise<{ stdout: string }> =>
    execFileAsync('git', args, { cwd: projectPath, timeout: GIT_TIMEOUT_MS })

  try {
    await git(['check-ignore', '-q', '--', LOCAL_SETTINGS_GIT_PATH])
    return
  } catch (error) {
    // Exit 1 means "not ignored". Anything else — 128 outside a repo, ENOENT when
    // git isn't installed — leaves nothing for us to do.
    if ((error as { code?: unknown }).code !== 1) return
  }
  // check-ignore also says "not ignored" for a tracked file (e.g. committed, then
  // deleted from the working tree), where an exclude rule would do nothing.
  try {
    await git(['ls-files', '--error-unmatch', '--', LOCAL_SETTINGS_GIT_PATH])
    return
  } catch (error) {
    if ((error as { code?: unknown }).code !== 1) return
  }

  try {
    const { stdout } = await git(['rev-parse', '--show-prefix', '--git-path', 'info/exclude'])
    const [prefix = '', gitPath = ''] = stdout.split(/\r?\n/)
    if (!gitPath) return
    // info/exclude patterns are anchored at the repo root, so a project in a
    // subdirectory needs its prefix. One we'd have to glob-escape is skipped.
    if (!/^[\w./ -]*$/.test(prefix)) {
      log.warn('Not adding a git exclude rule for a project path with special characters', {
        projectPath
      })
      return
    }
    const excludePath = resolve(projectPath, gitPath)
    const line = `${prefix}${LOCAL_SETTINGS_GIT_PATH}`
    const existing = await readFile(excludePath, 'utf-8').catch(() => '')
    if (existing.split(/\r?\n/).includes(line)) return
    await mkdir(dirname(excludePath), { recursive: true })
    const separator = existing === '' || existing.endsWith('\n') ? '' : '\n'
    await appendFile(excludePath, `${separator}${line}\n`)
    log.info('Added settings.local.json to git info/exclude', { excludePath })
  } catch (error) {
    log.warn('Could not add settings.local.json to git info/exclude', {
      projectPath,
      error: errorMessage(error)
    })
  }
}
