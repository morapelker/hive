import { EventEmitter } from 'events'
import { execFileSync } from 'child_process'
import { createHash } from 'crypto'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  writeFile
} from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CliToolOutputEvent, CliToolStatus } from '@shared/types/cli-tools'

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

import { execFileText as realExecFileText } from '../find-executable'
import {
  installCliSkill,
  installCliTool,
  listCliTools,
  npmCommand,
  parseSha256Sums,
  type ToolInstallerDeps
} from '../tool-installers'
import { CLI_TOOL_CATALOG } from '../catalog'

// The pinned tcu version: tests follow the catalog so a bump there does not break them.
const LATEST_TCU = CLI_TOOL_CATALOG.tcu.latestVersion

let root: string
let home: string
let configDir: string
let projectDir: string

const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex')

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'cli-tools-test-')))
  home = join(root, 'home')
  configDir = join(root, 'claude')
  projectDir = join(root, 'project')
  await mkdir(home)
  await mkdir(configDir)
  await mkdir(projectDir)
  await mkdir(join(root, 'tmp'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false
  )
}

async function writeSkill(dir: string, body = 'Body\n'): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), `---\nname: x\n---\n\n${body}`)
}

/** A fake spawn: runs `onRun`, emits `output`, closes with `exitCode`. */
function fakeSpawn(opts: {
  exitCode?: number
  output?: string
  onRun?: (
    file: string,
    args: string[],
    spawnOpts: { cwd?: string; env?: NodeJS.ProcessEnv }
  ) => void | Promise<void>
}): ToolInstallerDeps['spawn'] {
  return ((file: string, args: string[], spawnOpts: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn()
    })
    void Promise.resolve(opts.onRun?.(file, args, spawnOpts)).then(() => {
      if (opts.output) child.stdout.emit('data', Buffer.from(opts.output))
      child.emit('close', opts.exitCode ?? 0)
    })
    return child
  }) as unknown as ToolInstallerDeps['spawn']
}

/** execFileText that answers `npm prefix -g` and otherwise behaves per `extra`. */
function fakeExec(
  prefix: string | null,
  extra?: (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }> | undefined
): ToolInstallerDeps['execFileText'] {
  return async (file, args, opts) => {
    const handled = extra?.(file, args)
    if (handled) return handled
    const isNpmPrefix =
      (file === 'npm' && args[0] === 'prefix') ||
      (file.toLowerCase().endsWith('cmd.exe') && args[3] === 'npm prefix -g')
    if (isNpmPrefix) {
      if (prefix === null) throw new Error('npm: command not found')
      return { stdout: `${prefix}\n`, stderr: '' }
    }
    if (file === '/usr/bin/tar') return realExecFileText(file, args, opts)
    if (file === '/usr/bin/xattr' || file === '/usr/bin/pkill') return { stdout: '', stderr: '' }
    throw new Error(`unexpected exec: ${file} ${args.join(' ')}`)
  }
}

type Installed = Partial<
  Record<'playwright-cli' | 'tcu', { path: string; version: string | null; timedOut?: boolean }>
>

function makeDeps(
  installed: Installed,
  overrides: Partial<ToolInstallerDeps> = {}
): Partial<ToolInstallerDeps> {
  return {
    home,
    configDir,
    platform: 'darwin',
    env: { PATH: '/usr/bin:/bin', SHELL: '/bin/zsh' },
    fetch: vi.fn(async () => new Response('not found', { status: 404 })) as unknown as typeof fetch,
    spawn: fakeSpawn({ exitCode: 0 }),
    execFileText: fakeExec(null),
    findExecutable: async (name) => installed[name as keyof Installed]?.path ?? null,
    probeVersion: async (path) => {
      const entry = Object.values(installed).find((candidate) => candidate?.path === path)
      return { version: entry?.version ?? null, timedOut: entry?.timedOut ?? false }
    },
    reloadShellEnv: vi.fn(),
    tmpdir: () => join(root, 'tmp'),
    ...overrides
  }
}

const toolById = (tools: CliToolStatus[], id: string): CliToolStatus => {
  const tool = tools.find((candidate) => candidate.id === id)
  if (!tool) throw new Error(`missing tool ${id}`)
  return tool
}

/** A playwright-cli layout: `<pkg>/playwright-cli.js` with the skill in nested playwright-core. */
async function makePlaywrightInstall(
  skillBody = 'PW body\n'
): Promise<{ bin: string; skillDir: string }> {
  const pkg = join(root, 'npm', 'lib', 'node_modules', '@playwright', 'cli')
  const skillDir = join(
    pkg,
    'node_modules',
    'playwright-core',
    'lib',
    'tools',
    'skills',
    'playwright-cli'
  )
  await writeSkill(skillDir, skillBody)
  await writeFile(join(skillDir, 'extra.md'), 'extra')
  const bin = join(pkg, 'playwright-cli.js')
  await writeFile(bin, '#!/usr/bin/env node\n')
  await chmod(bin, 0o755)
  return { bin, skillDir }
}

async function makeTcuShareInstall(version: string, skillBody = 'TCU body\n'): Promise<string> {
  const dir = join(home, '.local', 'share', 'tcu', version)
  await writeSkill(join(dir, 'skills', 'tedooo-computer-use'), skillBody)
  await mkdir(join(dir, 'skills', 'tedooo-computer-use', 'references'), { recursive: true })
  await writeFile(join(dir, 'skills', 'tedooo-computer-use', 'references', 'keys.md'), 'keys')
  const bin = join(dir, 'tcu')
  await writeFile(bin, `#!/bin/sh\necho ${version}\n`)
  await chmod(bin, 0o755)
  return bin
}

/** Build a release tarball the way the pipeline does, served by a fake fetch. */
async function makeTcuRelease(
  version: string,
  opts: { doctorOk?: boolean; badChecksum?: boolean } = {}
) {
  const stage = join(root, 'stage')
  await mkdir(stage, { recursive: true })
  await writeFile(
    join(stage, 'tcu'),
    `#!/bin/sh\nif [ "$1" = "doctor" ]; then echo '{"ok":${opts.doctorOk === false ? 'false' : 'true'},"data":{"accessibility":${opts.doctorOk === false ? 'false' : 'true'},"screenRecording":true}}'; exit ${opts.doctorOk === false ? 3 : 0}; fi\necho ${version}\n`
  )
  await chmod(join(stage, 'tcu'), 0o755)
  await writeSkill(join(stage, 'skills', 'tedooo-computer-use'), 'released skill\n')
  await writeFile(join(stage, 'VERSION'), `${version}\n`)
  const assetName = `tcu-${version}-macos-universal.tar.gz`
  const tarball = join(root, assetName)
  execFileSync('/usr/bin/tar', ['-czf', tarball, '-C', stage, '.'])
  const tarBytes = await readFile(tarball)
  const skillTarball = join(root, `tcu-skill-${version}.tar.gz`)
  execFileSync('/usr/bin/tar', ['-czf', skillTarball, '-C', join(stage, 'skills'), '.'])
  const skillBytes = await readFile(skillTarball)
  const sums =
    `${opts.badChecksum ? '0'.repeat(64) : sha256(tarBytes)}  ${assetName}\n` +
    `${sha256(skillBytes)}  tcu-skill-${version}.tar.gz\n`
  const urls = new Map<string, Buffer | string>([
    [
      `https://github.com/TedoooTeam/tedooo-computer-use-releases/releases/download/v${version}/${assetName}`,
      tarBytes
    ],
    [
      `https://github.com/TedoooTeam/tedooo-computer-use-releases/releases/download/v${version}/SHA256SUMS`,
      sums
    ],
    [
      `https://github.com/TedoooTeam/tedooo-computer-use-releases/releases/download/v${version}/tcu-skill-${version}.tar.gz`,
      skillBytes
    ],
    [
      'https://github.com/TedoooTeam/tedooo-computer-use-releases/releases/latest/download/tcu-skill.tar.gz',
      skillBytes
    ]
  ])
  const fetchMock = vi.fn(async (url: string) => {
    const body = urls.get(url)
    if (body === undefined) return new Response('not found', { status: 404 })
    return new Response(typeof body === 'string' ? body : new Uint8Array(body), { status: 200 })
  })
  return { fetch: fetchMock as unknown as typeof fetch, fetchMock }
}

describe('parseSha256Sums', () => {
  it('reads shasum output, including binary-mode markers and ./ prefixes', () => {
    const hex = 'a'.repeat(64)
    const sums = parseSha256Sums(`${hex}  tcu.tar.gz\n${'b'.repeat(64)} *./other.tar.gz\njunk\n`)
    expect(sums.get('tcu.tar.gz')).toBe(hex)
    expect(sums.get('other.tar.gz')).toBe('b'.repeat(64))
    expect(sums.size).toBe(2)
  })
})

describe('listCliTools', () => {
  it('reports both tools as not installed on a bare machine', async () => {
    const { tools } = await listCliTools(projectDir, makeDeps({}))

    expect(tools.map((tool) => tool.id)).toEqual(['playwright-cli', 'tcu'])
    const playwright = toolById(tools, 'playwright-cli')
    expect(playwright).toMatchObject({
      name: 'Playwright CLI',
      skillId: 'playwright-cli',
      latestVersion: '0.1.22',
      platformSupported: true,
      binaryPath: null,
      installedVersion: null,
      upToDate: false,
      skill: { inProject: false, inGlobal: false, projectOutdated: false },
      manualInstallCommand: 'npm install -g @playwright/cli@latest',
      canAutoInstall: false // npm missing
    })
    expect(toolById(tools, 'tcu')).toMatchObject({
      skillId: 'tedooo-computer-use',
      latestVersion: LATEST_TCU,
      platformSupported: true,
      installedVersion: null,
      canAutoInstall: true,
      manualInstallCommand:
        'curl -fsSL https://github.com/TedoooTeam/tedooo-computer-use-releases/releases/latest/download/install.sh | bash'
    })
  })

  it('marks tcu unsupported off macOS', async () => {
    const { tools } = await listCliTools(projectDir, makeDeps({}, { platform: 'linux' }))
    expect(toolById(tools, 'tcu')).toMatchObject({
      platformSupported: false,
      canAutoInstall: false,
      binaryPath: null
    })
  })

  it('detects an outdated install and whether npm can be written without sudo', async () => {
    const { bin } = await makePlaywrightInstall()
    const prefix = join(root, 'npm')
    const deps = makeDeps(
      { 'playwright-cli': { path: bin, version: '0.1.19' } },
      { execFileText: fakeExec(prefix) }
    )

    const { tools } = await listCliTools(projectDir, deps)

    expect(toolById(tools, 'playwright-cli')).toMatchObject({
      binaryPath: bin,
      installedVersion: '0.1.19',
      upToDate: false,
      canAutoInstall: true
    })
  })

  it('treats a newer-than-known version as up to date', async () => {
    const { bin } = await makePlaywrightInstall()
    const { tools } = await listCliTools(
      projectDir,
      makeDeps({ 'playwright-cli': { path: bin, version: '0.2.0' } })
    )
    expect(toolById(tools, 'playwright-cli')).toMatchObject({
      installedVersion: '0.2.0',
      upToDate: true
    })
  })

  it('reports the skill as global, in-project, and outdated against the shipped copy', async () => {
    const { bin } = await makePlaywrightInstall('PW body\n')
    await writeSkill(join(configDir, 'skills', 'playwright-cli'))
    await writeSkill(join(projectDir, '.claude', 'skills', 'playwright-cli'), 'PW body\r\n')
    await makeTcuShareInstall(LATEST_TCU, 'TCU body\n')
    await writeSkill(join(projectDir, '.claude', 'skills', 'tedooo-computer-use'), 'old body\n')

    const { tools } = await listCliTools(
      projectDir,
      makeDeps(
        {
          'playwright-cli': { path: bin, version: '0.1.22' },
          tcu: { path: join(home, '.local', 'bin', 'tcu'), version: LATEST_TCU }
        },
        {
          execFileText: fakeExec(null, (file, args) =>
            file.endsWith('tcu') && args[0] === 'doctor'
              ? Promise.resolve({
                  stdout: '{"ok":true,"data":{"accessibility":true,"screenRecording":true}}',
                  stderr: ''
                })
              : undefined
          )
        }
      )
    )

    // CRLF differences are not "outdated"; the global copy (default body) is
    expect(toolById(tools, 'playwright-cli').skill).toEqual({
      inProject: true,
      inGlobal: true,
      projectOutdated: false,
      globalOutdated: true
    })
    expect(toolById(tools, 'tcu').skill).toEqual({
      inProject: true,
      inGlobal: false,
      projectOutdated: true,
      globalOutdated: false
    })
    expect(toolById(tools, 'tcu').installHint).toBeUndefined()
    expect(toolById(tools, 'tcu').binaryPath).toBe(join(home, '.local', 'bin', 'tcu'))
  })

  it('hints about permissions when tcu doctor reports them missing', async () => {
    const { tools } = await listCliTools(
      projectDir,
      makeDeps(
        { tcu: { path: '/x/tcu', version: LATEST_TCU } },
        {
          execFileText: fakeExec(null, (file, args) =>
            file === '/x/tcu' && args[0] === 'doctor'
              ? Promise.resolve({
                  stdout: '{"ok":false,"data":{"accessibility":false,"screenRecording":true}}',
                  stderr: ''
                })
              : undefined
          )
        }
      )
    )
    expect(toolById(tools, 'tcu').installHint).toMatch(/Accessibility and Screen Recording/)
  })

  it('hints about quarantine when the binary does not answer --version', async () => {
    const { tools } = await listCliTools(
      projectDir,
      makeDeps({ tcu: { path: '/x/tcu', version: null, timedOut: true } })
    )
    expect(toolById(tools, 'tcu')).toMatchObject({ installedVersion: null, upToDate: false })
    expect(toolById(tools, 'tcu').installHint).toContain('xattr -d com.apple.quarantine')
  })

  it('appends the known bin dirs to a stripped backend PATH so probes and npm can run', async () => {
    const deps = makeDeps({}, { env: { PATH: '/usr/bin:/bin', SHELL: '/bin/zsh' } })
    await listCliTools(projectDir, deps)
    expect(deps.env?.PATH).toBe(
      `/usr/bin:/bin:${join(home, '.local', 'bin')}:/opt/homebrew/bin:/usr/local/bin`
    )
  })

  it('makes a binary found off the backend PATH visible to agents the backend spawns', async () => {
    const deps = makeDeps(
      { tcu: { path: '/x/bin/tcu', version: LATEST_TCU } },
      {
        env: { PATH: '/usr/bin:/bin', SHELL: '/bin/zsh' },
        execFileText: fakeExec(null, (_file, args) =>
          args[0] === 'doctor' ? Promise.resolve({ stdout: '{"ok":true}', stderr: '' }) : undefined
        )
      }
    )
    const { tools } = await listCliTools(projectDir, deps)
    expect(toolById(tools, 'tcu').installedVersion).toBe(LATEST_TCU)
    expect(deps.reloadShellEnv).toHaveBeenCalled()
    expect(deps.env?.PATH?.split(':')[0]).toBe('/x/bin')
  })

  it('finds the playwright skill through `--help` for a shim-based install', async () => {
    const shim = join(root, 'shims', 'playwright-cli')
    await mkdir(join(root, 'shims'), { recursive: true })
    await writeFile(shim, '#!/bin/sh\nexec node ../lib/playwright-cli.js\n')
    await chmod(shim, 0o755)
    const skillDir = join(
      root,
      'pnpm-store',
      'playwright-core',
      'lib',
      'tools',
      'skills',
      'playwright-cli'
    )
    await writeSkill(skillDir, 'PW body\n')
    await writeSkill(join(projectDir, '.claude', 'skills', 'playwright-cli'), 'old\n')
    const deps = makeDeps(
      { 'playwright-cli': { path: shim, version: '0.1.22' } },
      {
        execFileText: fakeExec(null, (file, args) =>
          file === shim && args[0] === '--help'
            ? Promise.resolve({
                stdout: `playwright-cli - run playwright mcp commands\n\nAgent skill: ${join(skillDir, 'SKILL.md')}\n`,
                stderr: ''
              })
            : undefined
        )
      }
    )
    const { tools } = await listCliTools(projectDir, deps)
    expect(toolById(tools, 'playwright-cli').skill.projectOutdated).toBe(true)
  })
})

describe('npmCommand', () => {
  it('runs npm directly except on Windows, where it goes through cmd.exe', () => {
    expect(npmCommand('darwin', ['prefix', '-g'], {})).toEqual({
      file: 'npm',
      args: ['prefix', '-g']
    })
    expect(npmCommand('win32', ['prefix', '-g'], {})).toEqual({
      file: 'cmd.exe',
      args: ['/d', '/s', '/c', 'npm prefix -g']
    })
    expect(
      npmCommand('win32', ['install', '-g', 'x@latest'], { ComSpec: 'C:\\W\\cmd.exe' })
    ).toEqual({
      file: 'C:\\W\\cmd.exe',
      args: ['/d', '/s', '/c', 'npm install -g x@latest']
    })
  })

  it('probes the npm prefix through cmd.exe on Windows', async () => {
    const calls: string[] = []
    const deps = makeDeps(
      { 'playwright-cli': { path: 'C:\\npm\\playwright-cli.cmd', version: '0.1.19' } },
      {
        platform: 'win32',
        env: { PATH: 'C:\\npm', ComSpec: 'C:\\Windows\\cmd.exe' },
        execFileText: fakeExec(null, (file, args) => {
          calls.push(`${file} ${args.join(' ')}`)
          return undefined
        })
      }
    )
    const { tools } = await listCliTools(projectDir, deps)
    expect(toolById(tools, 'playwright-cli').installedVersion).toBe('0.1.19')
    expect(calls).toContain('C:\\Windows\\cmd.exe /d /s /c npm prefix -g')
    expect(calls.some((call) => call.startsWith('npm'))).toBe(false)
  })
})

describe('installCliTool — playwright-cli (npm)', () => {
  it('refuses with the manual command when the npm prefix is not writable', async () => {
    const events: CliToolOutputEvent[] = []
    const result = await installCliTool(
      'playwright-cli',
      projectDir,
      (e) => events.push(e),
      makeDeps({})
    )

    expect(result.success).toBe(false)
    expect(result.error).toContain('npm install -g @playwright/cli@latest')
    expect(result.status?.id).toBe('playwright-cli')
    expect(events).toEqual([{ type: 'error', exitCode: 1 }])
  })

  it('runs npm install -g with the login-shell env and streams its output', async () => {
    const prefix = join(root, 'npm')
    await mkdir(join(prefix, 'lib', 'node_modules'), { recursive: true })
    let spawned: { file: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv } | null =
      null
    const installed: Installed = {}
    const deps = makeDeps(installed, {
      execFileText: fakeExec(prefix),
      spawn: fakeSpawn({
        output: 'added 1 package\n',
        onRun: async (file, args, opts) => {
          spawned = { file, args, cwd: opts.cwd, env: opts.env }
          const { bin } = await makePlaywrightInstall()
          installed['playwright-cli'] = { path: bin, version: '0.1.22' }
        }
      })
    })
    const events: CliToolOutputEvent[] = []

    const result = await installCliTool('playwright-cli', projectDir, (e) => events.push(e), deps)

    expect(result.success).toBe(true)
    expect(result.status).toMatchObject({ installedVersion: '0.1.22', upToDate: true })
    expect(spawned).toMatchObject({
      file: 'npm',
      args: [
        'install',
        '-g',
        '@playwright/cli@latest',
        '--no-fund',
        '--no-audit',
        '--loglevel=error'
      ],
      cwd: home
    })
    expect(spawned!.env).toMatchObject({ NO_UPDATE_NOTIFIER: '1' })
    // The login-shell PATH leads; the known bin dirs are only appended
    expect(spawned!.env?.PATH?.startsWith('/usr/bin:/bin:')).toBe(true)
    expect(events).toEqual([
      {
        type: 'command-start',
        command: 'npm install -g @playwright/cli@latest --no-fund --no-audit --loglevel=error'
      },
      { type: 'output', data: 'added 1 package\n' },
      { type: 'done' }
    ])
  })

  it('fails when another copy earlier on PATH still shadows the one npm installed', async () => {
    const { bin } = await makePlaywrightInstall()
    const deps = makeDeps(
      { 'playwright-cli': { path: bin, version: '0.1.19' } },
      { execFileText: fakeExec(join(root, 'npm')) }
    )
    await mkdir(join(root, 'npm', 'lib', 'node_modules'), { recursive: true })

    const result = await installCliTool('playwright-cli', projectDir, undefined, deps)

    expect(result.success).toBe(false)
    expect(result.error).toContain(bin)
    expect(result.error).toContain('comes first on PATH')
    expect(result.status?.installedVersion).toBe('0.1.19')
  })

  it('spawns npm through cmd.exe on Windows', async () => {
    let spawned: { file: string; args: string[] } | null = null
    const deps = makeDeps(
      { 'playwright-cli': { path: 'C:\\npm\\playwright-cli.cmd', version: '0.1.22' } },
      {
        platform: 'win32',
        env: { PATH: 'C:\\npm' },
        execFileText: fakeExec('C:\\npm'),
        spawn: fakeSpawn({ onRun: (file, args) => void (spawned = { file, args }) })
      }
    )
    await mkdir(join(root, 'C:\\npm'), { recursive: true }).catch(() => undefined)
    const result = await installCliTool('playwright-cli', projectDir, undefined, deps)
    // The prefix check needs `<prefix>/node_modules` to exist — not on this Mac — so the
    // install is refused with the manual command; the spawn shape is checked only when it ran.
    if (spawned) {
      expect(spawned).toEqual({
        file: 'cmd.exe',
        args: [
          '/d',
          '/s',
          '/c',
          'npm install -g @playwright/cli@latest --no-fund --no-audit --loglevel=error'
        ]
      })
    } else {
      expect(result.error).toContain("can't write to npm's global folder")
    }
  })

  it('fails with the tail of the output when npm exits non-zero', async () => {
    const prefix = join(root, 'npm')
    await mkdir(join(prefix, 'lib', 'node_modules'), { recursive: true })
    const deps = makeDeps(
      {},
      {
        execFileText: fakeExec(prefix),
        spawn: fakeSpawn({ exitCode: 1, output: 'npm ERR! EACCES\n' })
      }
    )

    const result = await installCliTool('playwright-cli', projectDir, undefined, deps)

    expect(result.success).toBe(false)
    expect(result.error).toContain('exited with code 1')
    expect(result.error).toContain('npm ERR! EACCES')
  })
})

describe('installCliTool — tcu (GitHub release)', () => {
  it('downloads, verifies, installs under ~/.local/share, links ~/.local/bin and fixes PATH', async () => {
    const { fetch, fetchMock } = await makeTcuRelease(LATEST_TCU)
    const installed: Installed = {}
    const linkPath = join(home, '.local', 'bin', 'tcu')
    const deps = makeDeps(installed, {
      fetch,
      probeVersion: async (path) => {
        const { stdout } = await realExecFileText(path, ['--version'])
        return { version: stdout.trim(), timedOut: false }
      },
      findExecutable: async (name) =>
        name === 'tcu' && (await exists(linkPath)) ? linkPath : null,
      execFileText: fakeExec(null, (file, args) =>
        file === linkPath && args[0] === 'doctor' ? realExecFileText(file, args) : undefined
      )
    })
    const events: CliToolOutputEvent[] = []

    const result = await installCliTool('tcu', projectDir, (e) => events.push(e), deps)

    expect(result.error).toBeUndefined()
    expect(result.success).toBe(true)
    const target = join(home, '.local', 'share', 'tcu', LATEST_TCU, 'tcu')
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true)
    expect(await readlink(linkPath)).toBe(target)
    expect((await stat(target)).mode & 0o111).not.toBe(0)
    expect(
      await exists(
        join(
          home,
          '.local',
          'share',
          'tcu',
          LATEST_TCU,
          'skills',
          'tedooo-computer-use',
          'SKILL.md'
        )
      )
    ).toBe(true)
    expect(result.status).toMatchObject({
      binaryPath: linkPath,
      installedVersion: LATEST_TCU,
      upToDate: true
    })
    expect(result.status?.installHint).toBeUndefined()
    // ~/.local/bin was not on PATH: .zprofile gets the export and the env is reloaded
    const profile = await readFile(join(home, '.zprofile'), 'utf-8')
    expect(profile).toContain('export PATH="$HOME/.local/bin:$PATH"')
    expect(deps.reloadShellEnv).toHaveBeenCalledTimes(1)
    expect(deps.env?.PATH?.split(':')).toContain(join(home, '.local', 'bin'))
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(events.at(-1)).toEqual({ type: 'done' })
    expect(events.some((e) => e.type === 'output' && e.data?.includes('Checksum verified'))).toBe(
      true
    )
    // Temp download dir cleaned up
    expect(await exists(join(root, 'tmp'))).toBe(true)
    await expect(readdir(join(root, 'tmp'))).resolves.toEqual([])
  })

  it('does not touch .zprofile when it already mentions ~/.local/bin', async () => {
    const { fetch } = await makeTcuRelease(LATEST_TCU)
    const linkPath = join(home, '.local', 'bin', 'tcu')
    await writeFile(join(home, '.zprofile'), 'export PATH="$HOME/.local/bin:$PATH"\n')
    const deps = makeDeps(
      {},
      {
        fetch,
        env: { PATH: '/usr/bin', SHELL: '/bin/zsh' },
        probeVersion: async () => ({ version: LATEST_TCU, timedOut: false }),
        findExecutable: async () => linkPath,
        execFileText: fakeExec(null, (_file, args) =>
          args[0] === 'doctor' ? Promise.resolve({ stdout: '{"ok":true}', stderr: '' }) : undefined
        )
      }
    )

    const result = await installCliTool('tcu', projectDir, undefined, deps)

    expect(result.success).toBe(true)
    expect(await readFile(join(home, '.zprofile'), 'utf-8')).toBe(
      'export PATH="$HOME/.local/bin:$PATH"\n'
    )
    expect(deps.reloadShellEnv).toHaveBeenCalled()
  })

  it('fails when an older tcu earlier on PATH shadows the one just installed', async () => {
    const { fetch } = await makeTcuRelease(LATEST_TCU)
    const linkPath = join(home, '.local', 'bin', 'tcu')
    const deps = makeDeps(
      {},
      {
        fetch,
        env: { PATH: `/usr/local/bin:${join(home, '.local', 'bin')}:/usr/bin`, SHELL: '/bin/zsh' },
        findExecutable: async () => '/usr/local/bin/tcu',
        probeVersion: async (path) =>
          path === '/usr/local/bin/tcu'
            ? { version: '0.2.0', timedOut: false }
            : { version: LATEST_TCU, timedOut: false },
        execFileText: fakeExec(null, (_file, args) =>
          args[0] === 'doctor' ? Promise.resolve({ stdout: '{"ok":true}', stderr: '' }) : undefined
        )
      }
    )

    const result = await installCliTool('tcu', projectDir, undefined, deps)

    expect(result.success).toBe(false)
    expect(result.error).toContain('/usr/local/bin/tcu (0.2.0) comes first on PATH')
    expect(result.error).toContain(linkPath)
    expect(await readlink(linkPath)).toBe(join(home, '.local', 'share', 'tcu', LATEST_TCU, 'tcu'))
  })

  it('refuses a second install of the same tool while one is running', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const { fetch } = await makeTcuRelease(LATEST_TCU)
    const slowFetch = (async (url: string, init?: RequestInit) => {
      await gate
      return fetch(url, init)
    }) as unknown as typeof fetch
    const linkPath = join(home, '.local', 'bin', 'tcu')
    const deps = makeDeps(
      {},
      {
        fetch: slowFetch,
        probeVersion: async () => ({ version: LATEST_TCU, timedOut: false }),
        findExecutable: async () => linkPath,
        execFileText: fakeExec(null, (_file, args) =>
          args[0] === 'doctor' ? Promise.resolve({ stdout: '{"ok":true}', stderr: '' }) : undefined
        )
      }
    )

    const first = installCliTool('tcu', projectDir, undefined, deps)
    const second = await installCliTool('tcu', projectDir, undefined, deps)
    expect(second).toEqual({
      success: false,
      error: 'Tedooo Computer Use (tcu) is already being installed'
    })
    const skill = await installCliSkill('tcu', projectDir, undefined, deps)
    expect(skill.error).toBe('Tedooo Computer Use (tcu) is already being installed')

    release()
    expect((await first).success).toBe(true)
    // Once it finished, the tool can be installed again
    const again = await installCliTool('tcu', projectDir, undefined, deps)
    expect(again.success).toBe(true)
  })

  it('leaves the profile alone and does not reload the env when ~/.local/bin is already on PATH', async () => {
    const { fetch } = await makeTcuRelease(LATEST_TCU)
    const linkPath = join(home, '.local', 'bin', 'tcu')
    const deps = makeDeps(
      {},
      {
        fetch,
        env: { PATH: `${join(home, '.local', 'bin')}:/usr/bin`, SHELL: '/bin/zsh' },
        probeVersion: async () => ({ version: LATEST_TCU, timedOut: false }),
        findExecutable: async () => linkPath,
        execFileText: fakeExec(null, (_file, args) =>
          args[0] === 'doctor' ? Promise.resolve({ stdout: '{"ok":true}', stderr: '' }) : undefined
        )
      }
    )

    const result = await installCliTool('tcu', projectDir, undefined, deps)

    expect(result.success).toBe(true)
    expect(await exists(join(home, '.zprofile'))).toBe(false)
    expect(deps.reloadShellEnv).not.toHaveBeenCalled()
  })

  it('appends to a profile that has no trailing newline without joining lines', async () => {
    const { fetch } = await makeTcuRelease(LATEST_TCU)
    const linkPath = join(home, '.local', 'bin', 'tcu')
    await writeFile(join(home, '.zprofile'), 'export FOO=1')
    const deps = makeDeps(
      {},
      {
        fetch,
        probeVersion: async () => ({ version: LATEST_TCU, timedOut: false }),
        findExecutable: async () => linkPath,
        execFileText: fakeExec(null, (_file, args) =>
          args[0] === 'doctor' ? Promise.resolve({ stdout: '{"ok":true}', stderr: '' }) : undefined
        )
      }
    )

    const result = await installCliTool('tcu', projectDir, undefined, deps)

    expect(result.success).toBe(true)
    const profile = await readFile(join(home, '.zprofile'), 'utf-8')
    expect(profile.startsWith('export FOO=1\n')).toBe(true)
    expect(profile.trimEnd().split('\n').at(-1)).toBe('export PATH="$HOME/.local/bin:$PATH"')
  })

  it('surfaces the permissions hint from tcu doctor after installing', async () => {
    const { fetch } = await makeTcuRelease(LATEST_TCU, { doctorOk: false })
    const linkPath = join(home, '.local', 'bin', 'tcu')
    const deps = makeDeps(
      {},
      {
        fetch,
        probeVersion: async () => ({ version: LATEST_TCU, timedOut: false }),
        findExecutable: async () => linkPath,
        execFileText: fakeExec(null, (file, args) =>
          file === linkPath && args[0] === 'doctor'
            ? realExecFileText(file, args).catch((e) => ({ stdout: e.stdout, stderr: '' }))
            : undefined
        )
      }
    )

    const result = await installCliTool('tcu', projectDir, undefined, deps)

    expect(result.success).toBe(true)
    expect(result.status?.installHint).toMatch(/Grant Accessibility and Screen Recording/)
  })

  it('rejects a tarball whose checksum does not match and leaves nothing installed', async () => {
    const { fetch } = await makeTcuRelease(LATEST_TCU, { badChecksum: true })
    const result = await installCliTool('tcu', projectDir, undefined, makeDeps({}, { fetch }))

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Checksum mismatch/)
    expect(await exists(join(home, '.local', 'share', 'tcu', LATEST_TCU))).toBe(false)
    expect(await exists(join(home, '.local', 'bin', 'tcu'))).toBe(false)
  })

  it('fails cleanly when the release is missing', async () => {
    const result = await installCliTool('tcu', projectDir, undefined, makeDeps({}))
    expect(result.success).toBe(false)
    expect(result.error).toContain(`tcu release v${LATEST_TCU} is not published yet`)
  })

  it('refuses on other platforms', async () => {
    const result = await installCliTool(
      'tcu',
      projectDir,
      undefined,
      makeDeps({}, { platform: 'linux' })
    )
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('macOS') })
  })

  it('keeps the previous install when the downloaded binary does not run', async () => {
    const { fetch } = await makeTcuRelease(LATEST_TCU)
    const linkPath = join(home, '.local', 'bin', 'tcu')
    const oldDir = join(home, '.local', 'share', 'tcu', '0.2.0')
    await mkdir(oldDir, { recursive: true })
    await mkdir(join(home, '.local', 'bin'), { recursive: true })
    await writeFile(join(oldDir, 'tcu'), '#!/bin/sh\necho 0.2.0\n', { mode: 0o755 })
    await symlink(join(oldDir, 'tcu'), linkPath)
    const deps = makeDeps(
      {},
      {
        fetch,
        // The staged binary never answers (Gatekeeper kill, wrong arch...)
        probeVersion: async (path) =>
          path === linkPath
            ? { version: '0.2.0', timedOut: false }
            : { version: null, timedOut: true }
      }
    )

    const result = await installCliTool('tcu', projectDir, undefined, deps)

    expect(result.success).toBe(false)
    expect(result.error).toContain('did not respond')
    expect(await readlink(linkPath)).toBe(join(oldDir, 'tcu'))
    expect(await exists(join(home, '.local', 'share', 'tcu', LATEST_TCU))).toBe(false)
  })

  it('writes the PATH line to ~/.bash_profile for a bash login shell', async () => {
    const { fetch } = await makeTcuRelease(LATEST_TCU)
    const deps = makeDeps(
      {},
      {
        fetch,
        env: { PATH: '/usr/bin:/bin', SHELL: '/bin/bash' },
        probeVersion: async () => ({ version: LATEST_TCU, timedOut: false }),
        findExecutable: async () => join(home, '.local', 'bin', 'tcu'),
        execFileText: fakeExec(null, (_file, args) =>
          args[0] === 'doctor' ? Promise.resolve({ stdout: '{"ok":true}', stderr: '' }) : undefined
        )
      }
    )

    const result = await installCliTool('tcu', projectDir, undefined, deps)

    expect(result.success).toBe(true)
    const profile = await readFile(join(home, '.bash_profile'), 'utf-8')
    expect(profile).toContain('export PATH="$HOME/.local/bin:$PATH"')
    expect(await exists(join(home, '.zprofile'))).toBe(false)
  })

  it('replaces a tcu copied into ~/.local/bin by make install', async () => {
    const { fetch } = await makeTcuRelease(LATEST_TCU)
    const linkPath = join(home, '.local', 'bin', 'tcu')
    await mkdir(join(home, '.local', 'bin'), { recursive: true })
    await writeFile(linkPath, '#!/bin/sh\necho 0.2.0\n')
    const deps = makeDeps(
      {},
      {
        fetch,
        probeVersion: async () => ({ version: LATEST_TCU, timedOut: false }),
        findExecutable: async () => linkPath,
        execFileText: fakeExec(null, (_file, args) =>
          args[0] === 'doctor' ? Promise.resolve({ stdout: '{"ok":true}', stderr: '' }) : undefined
        )
      }
    )

    const result = await installCliTool('tcu', projectDir, undefined, deps)

    expect(result.success).toBe(true)
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true)
  })
})

describe('installCliSkill', () => {
  it('requires the CLI to be installed first', async () => {
    const result = await installCliSkill('tcu', projectDir, undefined, makeDeps({}))
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('Install') })
    expect(result.status?.id).toBe('tcu')
  })

  it('rejects a missing project folder', async () => {
    const result = await installCliSkill('tcu', join(root, 'nope'), undefined, makeDeps({}))
    expect(result.success).toBe(false)
    expect(result.error).toContain('Project folder not found')
  })

  it('runs `playwright-cli install --skills` in the project with NO_UPDATE_NOTIFIER', async () => {
    const { bin } = await makePlaywrightInstall()
    let spawned: { file: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv } | null =
      null
    const deps = makeDeps(
      { 'playwright-cli': { path: bin, version: '0.1.22' } },
      {
        spawn: fakeSpawn({
          output: '✅ skills installed\n',
          onRun: async (file, args, opts) => {
            spawned = { file, args, cwd: opts.cwd, env: opts.env }
            await writeSkill(join(projectDir, '.claude', 'skills', 'playwright-cli'), 'PW body\n')
          }
        })
      }
    )
    const events: CliToolOutputEvent[] = []

    const result = await installCliSkill('playwright-cli', projectDir, (e) => events.push(e), deps)

    expect(result.success).toBe(true)
    expect(result.status?.skill).toEqual({
      inProject: true,
      inGlobal: false,
      projectOutdated: false,
      globalOutdated: false
    })
    expect(spawned).toMatchObject({ file: bin, args: ['install', '--skills'], cwd: projectDir })
    expect(spawned!.env?.NO_UPDATE_NOTIFIER).toBe('1')
    expect(spawned!.env?.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD).toBeUndefined()
    expect(events).toEqual([
      { type: 'command-start', command: `${bin} install --skills` },
      { type: 'output', data: '✅ skills installed\n' },
      { type: 'done' }
    ])
  })

  it('still succeeds when the browser step fails after the skill was written', async () => {
    const { bin } = await makePlaywrightInstall()
    const deps = makeDeps(
      { 'playwright-cli': { path: bin, version: '0.1.22' } },
      {
        spawn: fakeSpawn({
          exitCode: 1,
          output: 'Downloading Chromium... failed\n',
          onRun: async () => {
            await writeSkill(join(projectDir, '.claude', 'skills', 'playwright-cli'), 'PW body\n')
          }
        })
      }
    )
    await mkdir(join(projectDir, '.claude'), { recursive: true })
    await writeFile(
      join(projectDir, '.claude', 'settings.local.json'),
      JSON.stringify({ skillOverrides: { 'playwright-cli': 'off' } })
    )
    const events: CliToolOutputEvent[] = []

    const result = await installCliSkill('playwright-cli', projectDir, (e) => events.push(e), deps)

    expect(result.success).toBe(true)
    expect(result.status?.skill.inProject).toBe(true)
    expect(
      events.some((e) => e.type === 'output' && e.data?.includes('playwright-cli install-browser'))
    ).toBe(true)
    const settings = JSON.parse(
      await readFile(join(projectDir, '.claude', 'settings.local.json'), 'utf-8')
    )
    expect(settings.skillOverrides).toBeUndefined()
  })

  it('reports when the installer exits cleanly but produced no skill', async () => {
    const { bin } = await makePlaywrightInstall()
    const deps = makeDeps(
      { 'playwright-cli': { path: bin, version: '0.1.22' } },
      { spawn: fakeSpawn({}) }
    )

    const result = await installCliSkill('playwright-cli', projectDir, undefined, deps)

    expect(result.success).toBe(false)
    expect(result.error).toContain('SKILL.md is missing')
  })

  it('copies the tcu skill from the installed version and re-enables it when it was switched off', async () => {
    await makeTcuShareInstall(LATEST_TCU, 'TCU body\n')
    await writeSkill(join(projectDir, '.claude', 'skills', 'tedooo-computer-use'), 'stale\n')
    await writeFile(
      join(projectDir, '.claude', 'skills', 'tedooo-computer-use', 'leftover.md'),
      'x'
    )
    await writeFile(
      join(projectDir, '.claude', 'settings.local.json'),
      JSON.stringify({
        permissions: { allow: ['Bash(ls:*)'] },
        skillOverrides: { 'tedooo-computer-use': 'off', other: 'off' }
      })
    )
    const linkPath = join(home, '.local', 'bin', 'tcu')
    const deps = makeDeps({ tcu: { path: linkPath, version: LATEST_TCU } })

    const result = await installCliSkill('tcu', projectDir, undefined, deps)

    expect(result.success).toBe(true)
    const dest = join(projectDir, '.claude', 'skills', 'tedooo-computer-use')
    expect(await readFile(join(dest, 'SKILL.md'), 'utf-8')).toContain('TCU body')
    expect(await exists(join(dest, 'references', 'keys.md'))).toBe(true)
    expect(await exists(join(dest, 'leftover.md'))).toBe(false)
    expect(result.status?.skill).toEqual({
      inProject: true,
      inGlobal: false,
      projectOutdated: false,
      globalOutdated: false
    })
    const settings = JSON.parse(
      await readFile(join(projectDir, '.claude', 'settings.local.json'), 'utf-8')
    )
    expect(settings).toEqual({
      permissions: { allow: ['Bash(ls:*)'] },
      skillOverrides: { other: 'off' }
    })
  })

  it('refuses to replace a project skills dir that resolves to the skill source', async () => {
    await makeTcuShareInstall(LATEST_TCU, 'TCU body\n')
    const shareSkills = join(home, '.local', 'share', 'tcu', LATEST_TCU, 'skills')
    await mkdir(join(projectDir, '.claude'), { recursive: true })
    await symlink(shareSkills, join(projectDir, '.claude', 'skills'))
    const deps = makeDeps({
      tcu: { path: join(home, '.local', 'bin', 'tcu'), version: LATEST_TCU }
    })

    const result = await installCliSkill('tcu', projectDir, undefined, deps)

    expect(result.success).toBe(false)
    expect(result.error).toContain('Refusing to replace')
    expect(await exists(join(shareSkills, 'tedooo-computer-use', 'SKILL.md'))).toBe(true)
  })

  it('downloads the skill archive for a locally built tcu without a share dir', async () => {
    const { fetch, fetchMock } = await makeTcuRelease('0.2.0')
    const deps = makeDeps({ tcu: { path: '/usr/local/bin/tcu', version: '0.2.0' } }, { fetch })

    const result = await installCliSkill('tcu', projectDir, undefined, deps)

    expect(result.error).toBeUndefined()
    expect(result.success).toBe(true)
    expect(
      await readFile(
        join(projectDir, '.claude', 'skills', 'tedooo-computer-use', 'SKILL.md'),
        'utf-8'
      )
    ).toContain('released skill')
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      'https://github.com/TedoooTeam/tedooo-computer-use-releases/releases/download/v0.2.0/tcu-skill-0.2.0.tar.gz',
      'https://github.com/TedoooTeam/tedooo-computer-use-releases/releases/download/v0.2.0/SHA256SUMS'
    ])
  })

  it('falls back to the latest skill archive when the installed version has no release', async () => {
    const { fetch, fetchMock } = await makeTcuRelease(LATEST_TCU)
    const deps = makeDeps({ tcu: { path: '/usr/local/bin/tcu', version: '0.1.0' } }, { fetch })

    const result = await installCliSkill('tcu', projectDir, undefined, deps)

    expect(result.success).toBe(true)
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      'https://github.com/TedoooTeam/tedooo-computer-use-releases/releases/download/v0.1.0/tcu-skill-0.1.0.tar.gz',
      'https://github.com/TedoooTeam/tedooo-computer-use-releases/releases/latest/download/tcu-skill.tar.gz'
    ])
  })

  it('fails when no skill source can be found', async () => {
    const deps = makeDeps({ tcu: { path: '/usr/local/bin/tcu', version: '0.1.0' } })
    const result = await installCliSkill('tcu', projectDir, undefined, deps)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Could not get the tedooo-computer-use skill/)
    expect(await exists(join(projectDir, '.claude', 'skills', 'tedooo-computer-use'))).toBe(false)
  })
})
