import { spawn as nodeSpawn } from 'child_process'
import { createHash } from 'crypto'
import {
  access,
  appendFile,
  chmod,
  constants,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile
} from 'fs/promises'
import { homedir, tmpdir } from 'os'
import { basename, dirname, join, resolve, sep } from 'path'
import { compareAppVersions } from '@shared/lib/version-compare'
import type {
  CliToolActionResult,
  CliToolId,
  CliToolOutputEvent,
  CliToolSkillStatus,
  CliToolStatus,
  CliToolsListing
} from '@shared/types/cli-tools'
import {
  listProjectSkills,
  resolveClaudeConfigDir,
  setDisabledProjectSkills
} from '../claude-skills'
import { getUserEnvironmentVariables } from '../env-vars'
import { createLogger } from '../logger'
import { loadShellEnv } from '../shell-env'
import {
  CLI_TOOL_CATALOG,
  CLI_TOOL_ORDER,
  tcuLatestAssetUrl,
  tcuReleaseAssetUrl,
  type CliToolCatalogEntry
} from './catalog'
import { execFileText, findExecutable, knownBinDirs, probeVersion } from './find-executable'

const log = createLogger({ component: 'CliTools' })

const SKILL_FILE = 'SKILL.md'
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000
const QUICK_TIMEOUT_MS = 5000
const TCU_DOCTOR_TIMEOUT_MS = 10_000
const LOCAL_BIN_PATH_LINE = 'export PATH="$HOME/.local/bin:$PATH"'
const TCU_PERMISSIONS_HINT =
  'Grant Accessibility and Screen Recording to Tedooo Code in System Settings, then restart Tedooo Code.'

export type OutputPublisher = (event: CliToolOutputEvent) => void

/** Everything that touches the machine, so tests can run against a temp home. */
export type ToolInstallerDeps = {
  home: string
  configDir: string
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  fetch: typeof fetch
  spawn: typeof nodeSpawn
  execFileText: typeof execFileText
  findExecutable: typeof findExecutable
  probeVersion: typeof probeVersion
  /** Re-read the login shell env into process.env after a PATH change. */
  reloadShellEnv: () => void
  tmpdir: () => string
  /** PATH as the login shell set it, before resolveDeps appended the known bin dirs. */
  loginPathDirs: string[]
}

const pathDirs = (env: NodeJS.ProcessEnv): string[] => (env.PATH ?? '').split(':').filter(Boolean)

/** The env with `dirs` appended to PATH (never prepended: PATH order is the user's). */
function withExtraPath(env: NodeJS.ProcessEnv, dirs: string[]): NodeJS.ProcessEnv {
  const current = pathDirs(env)
  const extra = dirs.filter((dir) => dir && !current.includes(dir))
  if (extra.length === 0) return env
  env.PATH = [...current, ...extra].join(':')
  return env
}

async function resolveDeps(opts: Partial<ToolInstallerDeps> = {}): Promise<ToolInstallerDeps> {
  const home = opts.home ?? homedir()
  const platform = opts.platform ?? process.platform
  // A backend started before loadShellEnv ran (or after it failed) has a stripped
  // PATH; the `#!/usr/bin/env node` shims then can't even find node. Append the
  // user-level bin dirs so probes and npm work, without changing the user's order.
  const loginPathDirs = opts.loginPathDirs ?? pathDirs(opts.env ?? process.env)
  const env = withExtraPath(opts.env ?? process.env, platform === 'win32' ? [] : knownBinDirs(home))
  let configDir = opts.configDir
  if (!configDir) {
    let userEnv: Record<string, string> = {}
    try {
      const { getDatabase } = await import('../../db')
      userEnv = getUserEnvironmentVariables(getDatabase())
    } catch {
      // No database (tests, early startup): process.env alone is the best view we have.
    }
    configDir = resolveClaudeConfigDir({ ...env, ...userEnv })
  }
  return {
    home,
    configDir,
    platform,
    env,
    fetch: opts.fetch ?? globalThis.fetch,
    spawn: opts.spawn ?? nodeSpawn,
    execFileText: opts.execFileText ?? execFileText,
    findExecutable: opts.findExecutable ?? findExecutable,
    probeVersion: opts.probeVersion ?? probeVersion,
    reloadShellEnv: opts.reloadShellEnv ?? loadShellEnv,
    tmpdir: opts.tmpdir ?? tmpdir,
    loginPathDirs
  }
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function isWritable(path: string): Promise<boolean> {
  try {
    await access(path, constants.W_OK)
    return true
  } catch {
    return false
  }
}

const normalizeSkillText = (text: string): string => text.replace(/\r\n/g, '\n')

async function readSkillFile(dir: string): Promise<string | null> {
  try {
    return normalizeSkillText(await readFile(join(dir, SKILL_FILE), 'utf-8'))
  } catch {
    return null
  }
}

// ── Catalog-driven paths ─────────────────────────────────────────────

const projectSkillDir = (projectPath: string, skillId: string): string =>
  join(projectPath, '.claude', 'skills', skillId)

const tcuShareDir = (home: string): string => join(home, '.local', 'share', 'tcu')
const tcuVersionDir = (home: string, version: string): string => join(tcuShareDir(home), version)
const localBinDir = (home: string): string => join(home, '.local', 'bin')

const tcuSkillSourceDir = (home: string, version: string, skillId: string): string =>
  join(tcuVersionDir(home, version), 'skills', skillId)

/**
 * Where the skill shipped with an installed playwright-cli lives: the CLI's own
 * nested playwright-core first, then a hoisted one, then the package's bundled copy.
 */
async function playwrightSkillSourceDir(
  binaryPath: string,
  skillId: string,
  deps: ToolInstallerDeps
): Promise<string | null> {
  let packageDir: string | null = null
  try {
    packageDir = dirname(await realpath(binaryPath))
  } catch {
    packageDir = null
  }
  if (packageDir) {
    const candidates = [
      join(packageDir, 'node_modules', 'playwright-core', 'lib', 'tools', 'skills', skillId),
      join(packageDir, '..', '..', 'playwright-core', 'lib', 'tools', 'skills', skillId),
      join(packageDir, 'skills', skillId)
    ]
    for (const candidate of candidates) {
      if (await exists(join(candidate, SKILL_FILE))) return candidate
    }
  }
  // Shim-based installs (pnpm, volta, corepack) resolve to the shim, not the package;
  // the CLI's own help names the bundled skill file.
  try {
    const { stdout } = await deps.execFileText(binaryPath, ['--help'], {
      cwd: deps.home,
      env: { ...deps.env, NO_UPDATE_NOTIFIER: '1' },
      timeout: QUICK_TIMEOUT_MS
    })
    const match = stdout.match(/^\s*Agent skill:\s*(.+?SKILL\.md)\s*$/m)
    if (match) {
      const dir = dirname(resolve(packageDir ?? deps.home, match[1]))
      if (await exists(join(dir, SKILL_FILE))) return dir
    }
  } catch {
    // The CLI did not answer; the skill source stays unknown.
  }
  return null
}

async function skillSourceDir(
  entry: CliToolCatalogEntry,
  binaryPath: string | null,
  installedVersion: string | null,
  deps: ToolInstallerDeps
): Promise<string | null> {
  if (!binaryPath) return null
  if (entry.kind === 'npm') return playwrightSkillSourceDir(binaryPath, entry.skillId, deps)
  if (!installedVersion) return null
  const dir = tcuSkillSourceDir(deps.home, installedVersion, entry.skillId)
  return (await exists(join(dir, SKILL_FILE))) ? dir : null
}

function manualInstallCommand(entry: CliToolCatalogEntry): string {
  return entry.kind === 'npm'
    ? `npm install -g ${entry.npmPackage}@latest`
    : `curl -fsSL ${tcuLatestAssetUrl(entry.releasesRepo, 'install.sh')} | bash`
}

/**
 * How to run npm: directly, or on Windows through cmd.exe — npm is a `.cmd` shim
 * there, and Node refuses to spawn .cmd/.bat files without a shell (EINVAL, the
 * CVE-2024-27980 mitigation). The args are catalog constants, never user input.
 */
export function npmCommand(
  platform: NodeJS.Platform,
  args: string[],
  env: NodeJS.ProcessEnv
): { file: string; args: string[] } {
  if (platform !== 'win32') return { file: 'npm', args }
  return { file: env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', ['npm', ...args].join(' ')] }
}

/** Whether `npm install -g` would succeed without sudo. Also false when npm is missing. */
async function npmGlobalPrefixWritable(deps: ToolInstallerDeps): Promise<boolean> {
  let prefix: string
  try {
    const npm = npmCommand(deps.platform, ['prefix', '-g'], deps.env)
    const { stdout } = await deps.execFileText(npm.file, npm.args, {
      env: deps.env,
      timeout: QUICK_TIMEOUT_MS
    })
    prefix = stdout.trim()
  } catch {
    return false
  }
  if (!prefix) return false
  const candidates =
    deps.platform === 'win32'
      ? [join(prefix, 'node_modules'), prefix]
      : [join(prefix, 'lib', 'node_modules'), join(prefix, 'lib'), prefix]
  for (const candidate of candidates) {
    if (await exists(candidate)) return isWritable(candidate)
  }
  return false
}

// ── Status ───────────────────────────────────────────────────────────

async function skillStatus(
  entry: CliToolCatalogEntry,
  projectPath: string,
  sourceDir: string | null,
  deps: ToolInstallerDeps
): Promise<CliToolSkillStatus> {
  const projectDir = projectSkillDir(projectPath, entry.skillId)
  const [projectText, globalText] = await Promise.all([
    readSkillFile(projectDir),
    readSkillFile(join(deps.configDir, 'skills', entry.skillId))
  ])
  const sourceText = sourceDir ? await readSkillFile(sourceDir) : null
  const outdated = (text: string | null): boolean =>
    text !== null && sourceText !== null && sourceText !== text
  return {
    inProject: projectText !== null,
    inGlobal: globalText !== null,
    projectOutdated: outdated(projectText),
    globalOutdated: outdated(globalText)
  }
}

/**
 * A binary found through the login shell or a known dir is invisible to agents the
 * backend spawns with process.env (e.g. installed from a terminal after the app
 * started). Reload the login shell env, and keep the directory on PATH either way.
 */
function exposeToBackendPath(dir: string, deps: ToolInstallerDeps): void {
  if (pathDirs(deps.env).includes(dir)) return
  try {
    deps.reloadShellEnv()
  } catch (error) {
    log.warn('Could not reload shell env', { error: errorMessage(error) })
  }
  if (!pathDirs(deps.env).includes(dir)) {
    deps.env.PATH = `${dir}:${deps.env.PATH ?? ''}`
  }
}

/** `tcu doctor --json` → a hint when the host app is missing a permission. Never throws. */
async function tcuPermissionsHint(
  binaryPath: string,
  deps: ToolInstallerDeps
): Promise<string | undefined> {
  let raw = ''
  try {
    raw = (
      await deps.execFileText(binaryPath, ['doctor', '--json'], {
        env: deps.env,
        timeout: TCU_DOCTOR_TIMEOUT_MS
      })
    ).stdout
  } catch (error) {
    raw = (error as { stdout?: string }).stdout ?? ''
    if (!raw) return TCU_PERMISSIONS_HINT
  }
  try {
    const parsed = JSON.parse(raw) as { ok?: boolean; data?: Record<string, unknown> }
    const data = parsed.data ?? {}
    if (parsed.ok === false || data.accessibility === false || data.screenRecording === false) {
      return TCU_PERMISSIONS_HINT
    }
    return undefined
  } catch {
    return undefined
  }
}

async function describeTool(
  entry: CliToolCatalogEntry,
  projectPath: string,
  deps: ToolInstallerDeps,
  opts: { checkPermissions?: boolean } = {}
): Promise<CliToolStatus> {
  const platformSupported = entry.platforms.includes(deps.platform)
  const binaryPath = platformSupported
    ? await deps.findExecutable(entry.binary, { env: deps.env, home: deps.home })
    : null
  if (binaryPath) exposeToBackendPath(dirname(binaryPath), deps)
  const probe = binaryPath ? await deps.probeVersion(binaryPath, { env: deps.env }) : null
  const installedVersion = probe?.version ?? null
  const upToDate =
    installedVersion !== null && compareAppVersions(installedVersion, entry.latestVersion) >= 0

  const sourceDir = await skillSourceDir(entry, binaryPath, installedVersion, deps)
  const skill = await skillStatus(entry, projectPath, sourceDir, deps)

  let canAutoInstall = platformSupported
  if (entry.kind === 'npm' && platformSupported) {
    canAutoInstall = await npmGlobalPrefixWritable(deps)
  }

  let installHint: string | undefined
  if (probe?.timedOut) {
    installHint = `${entry.binary} did not respond to --version. If it was downloaded by a browser, run: xattr -d com.apple.quarantine "${binaryPath}"`
  } else if (entry.kind === 'github-release' && binaryPath && opts.checkPermissions) {
    installHint = await tcuPermissionsHint(binaryPath, deps)
  }

  return {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    skillId: entry.skillId,
    latestVersion: entry.latestVersion,
    platformSupported,
    binaryPath,
    installedVersion,
    upToDate,
    skill,
    manualInstallCommand: manualInstallCommand(entry),
    canAutoInstall,
    ...(installHint ? { installHint } : {})
  }
}

/** Status of every catalog tool for the project. Never throws. */
export async function listCliTools(
  projectPath: string,
  opts: Partial<ToolInstallerDeps> = {}
): Promise<CliToolsListing> {
  const deps = await resolveDeps(opts)
  const tools = await Promise.all(
    CLI_TOOL_ORDER.map((id) =>
      describeTool(CLI_TOOL_CATALOG[id], projectPath, deps, { checkPermissions: true }).catch(
        (error): CliToolStatus => {
          log.warn('Could not describe CLI tool', { id, error: errorMessage(error) })
          const entry = CLI_TOOL_CATALOG[id]
          return {
            id,
            name: entry.name,
            description: entry.description,
            skillId: entry.skillId,
            latestVersion: entry.latestVersion,
            platformSupported: entry.platforms.includes(deps.platform),
            binaryPath: null,
            installedVersion: null,
            upToDate: false,
            skill: {
              inProject: false,
              inGlobal: false,
              projectOutdated: false,
              globalOutdated: false
            },
            manualInstallCommand: manualInstallCommand(entry),
            canAutoInstall: false,
            installHint: `Could not check ${entry.name}: ${errorMessage(error)}`
          }
        }
      )
    )
  )
  return { tools }
}

// ── Running commands with streamed output ────────────────────────────

type StreamedRun = { exitCode: number | null; output: string; error?: string }

function runStreaming(
  deps: ToolInstallerDeps,
  file: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeout: number },
  publish: OutputPublisher
): Promise<StreamedRun> {
  return new Promise((resolve) => {
    let output = ''
    let settled = false
    const emit = (data: string): void => {
      if (!data) return
      output += data
      publish({ type: 'output', data })
    }
    publish({ type: 'command-start', command: [file, ...args].join(' ') })

    let child: ReturnType<typeof nodeSpawn>
    try {
      child = deps.spawn(file, args, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (error) {
      resolve({ exitCode: null, output, error: errorMessage(error) })
      return
    }

    const finish = (result: StreamedRun): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM')
      } catch {
        // already gone
      }
      finish({
        exitCode: null,
        output,
        error: `Timed out after ${Math.round(opts.timeout / 60000)} minutes`
      })
    }, opts.timeout)

    child.stdout?.on('data', (chunk: Buffer | string) => emit(String(chunk)))
    child.stderr?.on('data', (chunk: Buffer | string) => emit(String(chunk)))
    child.on('error', (error) => finish({ exitCode: null, output, error: error.message }))
    child.on('close', (code) => finish({ exitCode: code, output }))
  })
}

const lastLines = (text: string, count = 8): string =>
  text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(-count)
    .join('\n')

const failureMessage = (what: string, run: StreamedRun): string => {
  const tail = lastLines(run.output)
  const reason = run.error ?? `exited with code ${run.exitCode}`
  return tail ? `${what} ${reason}:\n${tail}` : `${what} ${reason}`
}

// ── Install / update a CLI ───────────────────────────────────────────

async function installNpmTool(
  entry: Extract<CliToolCatalogEntry, { kind: 'npm' }>,
  projectPath: string,
  publish: OutputPublisher,
  deps: ToolInstallerDeps
): Promise<CliToolActionResult> {
  if (!(await npmGlobalPrefixWritable(deps))) {
    const status = await describeTool(entry, projectPath, deps)
    return {
      success: false,
      error: `Tedooo Code can't write to npm's global folder. Run this in a terminal: ${manualInstallCommand(entry)}`,
      status
    }
  }
  const npm = npmCommand(
    deps.platform,
    ['install', '-g', `${entry.npmPackage}@latest`, '--no-fund', '--no-audit', '--loglevel=error'],
    deps.env
  )
  const run = await runStreaming(
    deps,
    npm.file,
    npm.args,
    { cwd: deps.home, env: { ...deps.env, NO_UPDATE_NOTIFIER: '1' }, timeout: INSTALL_TIMEOUT_MS },
    publish
  )
  if (run.exitCode !== 0) {
    return { success: false, error: failureMessage('npm install', run), output: run.output }
  }
  const status = await describeTool(entry, projectPath, deps)
  if (!status.binaryPath) {
    return {
      success: false,
      error: `npm install finished but ${entry.binary} is not on PATH. Open a new terminal and check \`npm prefix -g\`.`,
      output: run.output,
      status
    }
  }
  // `which` may still resolve a copy that precedes npm's bin dir on PATH (nvm, a
  // stray /usr/local copy); reporting success would just re-offer the update forever.
  if (!status.upToDate) {
    return {
      success: false,
      error: `npm installed ${entry.npmPackage}@${entry.latestVersion}, but ${status.binaryPath} (${status.installedVersion ?? 'unknown version'}) comes first on PATH. Check \`npm prefix -g\` and your PATH order.`,
      output: run.output,
      status
    }
  }
  return { success: true, output: run.output, status }
}

async function downloadToFile(url: string, dest: string, deps: ToolInstallerDeps): Promise<void> {
  const response = await deps.fetch(url, { redirect: 'follow' })
  if (!response.ok) {
    const release = url.match(/\/releases\/download\/(v[^/]+)\//)
    if (response.status === 404 && release) {
      throw new Error(`tcu release ${release[1]} is not published yet (${url})`)
    }
    throw new Error(`Download failed (${response.status}) for ${url}`)
  }
  await writeFile(dest, Buffer.from(await response.arrayBuffer()))
}

async function sha256File(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

/** Parse `shasum -a 256` output (`<hex>  <name>`) into name → hex. */
export function parseSha256Sums(raw: string): Map<string, string> {
  const sums = new Map<string, string>()
  for (const line of raw.split(/\r?\n/)) {
    const match = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/)
    if (match) sums.set(match[2].trim().replace(/^\.\//, ''), match[1].toLowerCase())
  }
  return sums
}

async function verifyChecksum(
  filePath: string,
  assetName: string,
  sumsPath: string
): Promise<void> {
  const sums = parseSha256Sums(await readFile(sumsPath, 'utf-8'))
  const expected = sums.get(assetName)
  if (!expected) throw new Error(`SHA256SUMS has no entry for ${assetName}`)
  const actual = await sha256File(filePath)
  if (actual !== expected) {
    throw new Error(`Checksum mismatch for ${assetName} (expected ${expected}, got ${actual})`)
  }
}

async function extractTarball(
  tarball: string,
  into: string,
  deps: ToolInstallerDeps
): Promise<void> {
  await mkdir(into, { recursive: true })
  await deps.execFileText('/usr/bin/tar', ['-xzf', tarball, '-C', into], {
    env: deps.env,
    timeout: 60_000
  })
}

/**
 * Make sure `~/.local/bin` is on the login shell PATH: append the export line to
 * `~/.zprofile` (`~/.bash_profile` for bash) when neither it nor an equivalent mention is
 * there, then reload the
 * backend's env so agents started from now on find the new binary.
 */
async function ensureLocalBinOnPath(
  deps: ToolInstallerDeps,
  publish: OutputPublisher
): Promise<void> {
  const binDir = localBinDir(deps.home)
  // Judge by the login shell's own PATH: resolveDeps appends ~/.local/bin to the
  // backend env so probes work, which says nothing about new terminals.
  if (deps.loginPathDirs.includes(binDir)) return

  // Login shells read different files: bash never reads ~/.zprofile.
  const profileName = /\/bash$/.test(deps.env.SHELL ?? '') ? '.bash_profile' : '.zprofile'
  const profilePath = join(deps.home, profileName)
  let existing = ''
  try {
    existing = await readFile(profilePath, 'utf-8')
  } catch {
    existing = ''
  }
  if (!existing.includes('.local/bin')) {
    const separator = existing === '' || existing.endsWith('\n') ? '' : '\n'
    await appendFile(
      profilePath,
      `${separator}\n# Added by Tedooo Code so tcu is found\n${LOCAL_BIN_PATH_LINE}\n`
    )
    publish({ type: 'output', data: `Added ${LOCAL_BIN_PATH_LINE} to ~/${profileName}\n` })
    log.info('Appended ~/.local/bin to the login shell profile', { profileName })
  }
  // Take effect in this backend right away, whatever the reload yields.
  deps.env.PATH = `${binDir}:${deps.env.PATH ?? ''}`
  try {
    deps.reloadShellEnv()
  } catch (error) {
    log.warn('Could not reload shell env after PATH change', { error: errorMessage(error) })
  }
  if (!pathDirs(deps.env).includes(binDir)) {
    deps.env.PATH = `${binDir}:${deps.env.PATH ?? ''}`
  }
  deps.loginPathDirs = pathDirs(deps.env)
}

async function installTcu(
  entry: Extract<CliToolCatalogEntry, { kind: 'github-release' }>,
  projectPath: string,
  publish: OutputPublisher,
  deps: ToolInstallerDeps
): Promise<CliToolActionResult> {
  if (deps.platform !== 'darwin') {
    return { success: false, error: `${entry.name} is only available on macOS.` }
  }
  const version = entry.latestVersion
  const assetName = `tcu-${version}-macos-universal.tar.gz`
  const tarballUrl = tcuReleaseAssetUrl(entry.releasesRepo, version, assetName)
  const sumsUrl = tcuReleaseAssetUrl(entry.releasesRepo, version, 'SHA256SUMS')
  const say = (line: string): void => publish({ type: 'output', data: `${line}\n` })

  const tmp = await mkdtemp(join(deps.tmpdir(), 'tcu-install-'))
  try {
    publish({ type: 'command-start', command: `download ${tarballUrl}` })
    const tarball = join(tmp, assetName)
    const sums = join(tmp, 'SHA256SUMS')
    say(`Downloading tcu ${version}...`)
    await downloadToFile(tarballUrl, tarball, deps)
    await downloadToFile(sumsUrl, sums, deps)
    await verifyChecksum(tarball, assetName, sums)
    say('Checksum verified')

    const extracted = join(tmp, 'extracted')
    await extractTarball(tarball, extracted, deps)
    const extractedBinary = join(extracted, 'tcu')
    if (!(await exists(extractedBinary))) {
      throw new Error('The release archive does not contain a tcu binary')
    }

    await chmod(extractedBinary, 0o755)
    try {
      await deps.execFileText('/usr/bin/xattr', ['-d', 'com.apple.quarantine', extractedBinary], {
        env: deps.env,
        timeout: QUICK_TIMEOUT_MS
      })
    } catch {
      // No quarantine attribute (the normal case for a fetch() download).
    }

    // Prove the new binary runs before anything live is touched, so a build that
    // Gatekeeper kills or a wrong-arch download leaves the previous install intact.
    const staged = await deps.probeVersion(extractedBinary, { env: deps.env })
    if (staged.timedOut) {
      throw new Error('The downloaded tcu did not respond to --version')
    }
    if (staged.version !== version) {
      throw new Error(
        `The downloaded tcu reports version ${staged.version ?? 'unknown'}, expected ${version}`
      )
    }

    const versionDir = tcuVersionDir(deps.home, version)
    await rm(versionDir, { recursive: true, force: true })
    await mkdir(dirname(versionDir), { recursive: true })
    await cp(extracted, versionDir, { recursive: true })
    const binary = join(versionDir, 'tcu')
    await chmod(binary, 0o755)

    const binDir = localBinDir(deps.home)
    await mkdir(binDir, { recursive: true })
    const link = join(binDir, 'tcu')
    const tmpLink = join(binDir, `.tcu.${process.pid}.tmp`)
    await rm(tmpLink, { force: true })
    await symlink(binary, tmpLink)
    await rename(tmpLink, link)
    say(`Installed ${link} → ${binary}`)

    // A cursor overlay started by the previous binary would keep drawing the old cursor.
    try {
      await deps.execFileText('/usr/bin/pkill', ['-f', 'tcu cursor-overla[y]'], {
        env: deps.env,
        timeout: QUICK_TIMEOUT_MS
      })
    } catch {
      // nothing was running
    }

    const probe = await deps.probeVersion(link, { env: deps.env })
    if (probe.version !== version) {
      throw new Error(
        `${link} does not resolve to tcu ${version} (got ${probe.version ?? 'no answer'})`
      )
    }
    say(`tcu ${probe.version} is ready`)

    await ensureLocalBinOnPath(deps, publish)

    const status = await describeTool(entry, projectPath, deps, { checkPermissions: true })
    if (status.installedVersion !== version || status.binaryPath !== link) {
      // Another copy earlier on PATH shadows the one just installed; a "success"
      // here would show the old version and offer the same update again.
      const shadow = status.binaryPath ?? 'nothing'
      const shadowVersion = status.installedVersion ? ` (${status.installedVersion})` : ''
      return {
        success: false,
        error: `tcu ${version} was installed to ${link}, but ${shadow}${shadowVersion} comes first on PATH. Remove it or move ${binDir} earlier in your PATH.`,
        status
      }
    }
    if (status.installHint) say(status.installHint)
    return { success: true, status }
  } catch (error) {
    log.error('tcu install failed', error instanceof Error ? error : new Error(String(error)))
    return { success: false, error: errorMessage(error) }
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined)
  }
}

// One install or skill install per tool at a time: the dialog can be closed and
// reopened while npm or a download is still running, and a second run would race
// the first on the same files.
const inFlight = new Map<CliToolId, Promise<CliToolActionResult>>()

async function guarded(
  id: CliToolId,
  name: string,
  run: () => Promise<CliToolActionResult>
): Promise<CliToolActionResult> {
  if (inFlight.has(id)) return { success: false, error: `${name} is already being installed` }
  const promise = run()
  inFlight.set(id, promise)
  try {
    return await promise
  } finally {
    inFlight.delete(id)
  }
}

/** Install or update a CLI tool globally. Never throws. */
export async function installCliTool(
  id: CliToolId,
  projectPath: string,
  publish: OutputPublisher = () => undefined,
  opts: Partial<ToolInstallerDeps> = {}
): Promise<CliToolActionResult> {
  const entry = CLI_TOOL_CATALOG[id]
  if (!entry) return { success: false, error: `Unknown tool: ${id}` }
  return guarded(id, entry.name, () => runInstallCliTool(entry, projectPath, publish, opts))
}

async function runInstallCliTool(
  entry: CliToolCatalogEntry,
  projectPath: string,
  publish: OutputPublisher,
  opts: Partial<ToolInstallerDeps>
): Promise<CliToolActionResult> {
  const id = entry.id
  const deps = await resolveDeps(opts)
  let result: CliToolActionResult
  try {
    result =
      entry.kind === 'npm'
        ? await installNpmTool(entry, projectPath, publish, deps)
        : await installTcu(entry, projectPath, publish, deps)
  } catch (error) {
    log.error(
      'CLI tool install failed',
      error instanceof Error ? error : new Error(String(error)),
      {
        id
      }
    )
    result = { success: false, error: errorMessage(error) }
  }
  publish(result.success ? { type: 'done' } : { type: 'error', exitCode: 1 })
  return result
}

// ── Install a skill into the project ─────────────────────────────────

/** Drop a `skillOverrides[skillId] = "off"` so a freshly installed skill is live. */
async function enableProjectSkill(
  projectPath: string,
  skillId: string,
  deps: ToolInstallerDeps
): Promise<void> {
  const listing = await listProjectSkills(projectPath, { configDir: deps.configDir })
  const skill = listing.projectSkills.find((candidate) => candidate.id === skillId)
  if (!skill || skill.enabled) return
  const disabled = listing.projectSkills
    .filter((candidate) => !candidate.enabled && candidate.id !== skillId)
    .map((candidate) => candidate.id)
  const result = await setDisabledProjectSkills(projectPath, disabled, {
    configDir: deps.configDir
  })
  if (!result.success) {
    log.warn('Installed skill stays disabled by skillOverrides', { skillId, error: result.error })
  }
}

async function installPlaywrightSkill(
  entry: CliToolCatalogEntry,
  binaryPath: string,
  projectPath: string,
  publish: OutputPublisher,
  deps: ToolInstallerDeps
): Promise<string | undefined> {
  const run = await runStreaming(
    deps,
    binaryPath,
    ['install', '--skills'],
    {
      cwd: projectPath,
      env: { ...deps.env, NO_UPDATE_NOTIFIER: '1' },
      timeout: INSTALL_TIMEOUT_MS
    },
    publish
  )
  const skillFile = join(projectSkillDir(projectPath, entry.skillId), SKILL_FILE)
  if (run.exitCode !== 0) {
    if (!(await exists(skillFile))) return failureMessage('playwright-cli install --skills', run)
    // The skill is copied before the browser setup step; a slow download that
    // times out (or a failed download) must not read as "no skill".
    publish({
      type: 'output',
      data: `\nSkill installed, but browser setup did not finish (${run.error ?? `exited with code ${run.exitCode}`}). Run \`playwright-cli install-browser\` in the project to finish it.\n`
    })
    return undefined
  }
  if (!(await exists(skillFile))) {
    return `playwright-cli install --skills finished but ${skillFile} is missing`
  }
  return undefined
}

/**
 * The tcu skill from the installed version's share dir, or — for a tcu built
 * locally — the skill archive of that version from the releases repo (latest as a
 * last resort). Returns the directory holding SKILL.md.
 */
async function resolveTcuSkillSource(
  entry: Extract<CliToolCatalogEntry, { kind: 'github-release' }>,
  installedVersion: string | null,
  tmp: string,
  publish: OutputPublisher,
  deps: ToolInstallerDeps
): Promise<string> {
  if (installedVersion) {
    const local = tcuSkillSourceDir(deps.home, installedVersion, entry.skillId)
    if (await exists(join(local, SKILL_FILE))) return local
  }

  const attempts: Array<{ url: string; sumsUrl: string | null; name: string }> = []
  if (installedVersion) {
    const name = `tcu-skill-${installedVersion}.tar.gz`
    attempts.push({
      url: tcuReleaseAssetUrl(entry.releasesRepo, installedVersion, name),
      sumsUrl: tcuReleaseAssetUrl(entry.releasesRepo, installedVersion, 'SHA256SUMS'),
      name
    })
  }
  attempts.push({
    url: tcuLatestAssetUrl(entry.releasesRepo, 'tcu-skill.tar.gz'),
    sumsUrl: null,
    name: 'tcu-skill.tar.gz'
  })

  let lastError = 'no download attempted'
  for (const attempt of attempts) {
    const archive = join(tmp, attempt.name)
    try {
      publish({ type: 'output', data: `Downloading ${attempt.url}\n` })
      await downloadToFile(attempt.url, archive, deps)
      if (attempt.sumsUrl) {
        const sums = join(tmp, 'SHA256SUMS')
        try {
          await downloadToFile(attempt.sumsUrl, sums, deps)
        } catch {
          // No checksum file alongside: install unverified rather than fail.
        }
        if (await exists(sums)) await verifyChecksum(archive, attempt.name, sums)
      }
      const extracted = join(tmp, `extracted-${attempts.indexOf(attempt)}`)
      await extractTarball(archive, extracted, deps)
      const dir = join(extracted, entry.skillId)
      if (await exists(join(dir, SKILL_FILE))) return dir
      lastError = `${attempt.name} does not contain ${entry.skillId}/SKILL.md`
    } catch (error) {
      lastError = errorMessage(error)
    }
  }
  throw new Error(`Could not get the ${entry.skillId} skill: ${lastError}`)
}

async function copySkillDir(source: string, dest: string): Promise<void> {
  await mkdir(dirname(dest), { recursive: true })
  // `.claude/skills` may itself be a symlink; rm on `<link>/<skill>` follows it, so
  // never delete a directory that is (or contains) the skill's own source.
  const realSource = await realpath(source)
  const realDest = join(await realpath(dirname(dest)), basename(dest))
  if (realDest === realSource || realSource.startsWith(realDest + sep)) {
    throw new Error(`Refusing to replace ${dest}: it resolves to the skill source ${realSource}`)
  }
  await rm(dest, { recursive: true, force: true })
  await cp(source, dest, { recursive: true, dereference: true })
}

/** Install (or refresh) a tool's skill in `<project>/.claude/skills`. Never throws. */
export async function installCliSkill(
  id: CliToolId,
  projectPath: string,
  publish: OutputPublisher = () => undefined,
  opts: Partial<ToolInstallerDeps> = {}
): Promise<CliToolActionResult> {
  const entry = CLI_TOOL_CATALOG[id]
  if (!entry) return { success: false, error: `Unknown tool: ${id}` }
  return guarded(id, entry.name, () => runInstallCliSkill(entry, projectPath, publish, opts))
}

async function runInstallCliSkill(
  entry: CliToolCatalogEntry,
  projectPath: string,
  publish: OutputPublisher,
  opts: Partial<ToolInstallerDeps>
): Promise<CliToolActionResult> {
  const id = entry.id
  const deps = await resolveDeps(opts)
  const finish = (result: CliToolActionResult): CliToolActionResult => {
    publish(result.success ? { type: 'done' } : { type: 'error', exitCode: 1 })
    return result
  }

  try {
    const projectStat = await stat(projectPath).catch(() => null)
    if (!projectStat?.isDirectory()) {
      return finish({ success: false, error: `Project folder not found: ${projectPath}` })
    }
    const before = await describeTool(entry, projectPath, deps)
    if (!before.binaryPath) {
      return finish({
        success: false,
        error: `Install ${entry.name} first, then add its skill.`,
        status: before
      })
    }

    if (entry.kind === 'npm') {
      const error = await installPlaywrightSkill(
        entry,
        before.binaryPath,
        projectPath,
        publish,
        deps
      )
      if (error) return finish({ success: false, error, status: before })
    } else {
      const tmp = await mkdtemp(join(deps.tmpdir(), 'tcu-skill-'))
      try {
        const source = await resolveTcuSkillSource(
          entry,
          before.installedVersion,
          tmp,
          publish,
          deps
        )
        await copySkillDir(source, projectSkillDir(projectPath, entry.skillId))
        publish({ type: 'output', data: `Copied ${entry.skillId} into .claude/skills\n` })
      } finally {
        await rm(tmp, { recursive: true, force: true }).catch(() => undefined)
      }
    }

    await enableProjectSkill(projectPath, entry.skillId, deps)
    const status = await describeTool(entry, projectPath, deps)
    log.info('Installed CLI tool skill', { id, projectPath })
    return finish({ success: true, status })
  } catch (error) {
    log.error('Skill install failed', error instanceof Error ? error : new Error(String(error)), {
      id,
      projectPath
    })
    return finish({ success: false, error: errorMessage(error) })
  }
}
