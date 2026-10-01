import { execFileSync } from 'child_process'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile
} from 'fs/promises'
import { homedir, tmpdir } from 'os'
import { dirname, join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

import {
  listProjectSkills,
  listSkillsInDir,
  resolveClaudeConfigDir,
  setDisabledProjectSkills
} from '../claude-skills'

let root: string
let configDir: string
let projectDir: string
let projectSkillsDir: string
let localSettingsPath: string

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'claude-skills-test-')))
  configDir = join(root, 'config')
  projectDir = join(root, 'project')
  projectSkillsDir = join(projectDir, '.claude', 'skills')
  localSettingsPath = join(projectDir, '.claude', 'settings.local.json')
  await mkdir(configDir)
  await mkdir(projectDir)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

async function writeSkill(skillsDir: string, id: string, content?: string): Promise<void> {
  await mkdir(join(skillsDir, id), { recursive: true })
  await writeFile(
    join(skillsDir, id, 'SKILL.md'),
    content ?? `---\nname: ${id}\ndescription: Does ${id}\n---\n\nBody\n`
  )
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(value))
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf-8'))
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false
  )
}

/** Enabled state per project skill id, as the dialog would show it. */
async function enabledById(): Promise<Record<string, boolean>> {
  const { projectSkills } = await listProjectSkills(projectDir, { configDir })
  return Object.fromEntries(projectSkills.map((skill) => [skill.id, skill.enabled]))
}

describe('resolveClaudeConfigDir', () => {
  it('uses $CLAUDE_CONFIG_DIR when the variable is set', () => {
    expect(resolveClaudeConfigDir({ CLAUDE_CONFIG_DIR: '/custom/cfg' })).toBe('/custom/cfg')
  })

  it('falls back to ~/.claude when unset, empty or blank', () => {
    const fallback = join(homedir(), '.claude')
    expect(resolveClaudeConfigDir({})).toBe(fallback)
    expect(resolveClaudeConfigDir({ CLAUDE_CONFIG_DIR: '' })).toBe(fallback)
    expect(resolveClaudeConfigDir({ CLAUDE_CONFIG_DIR: '   ' })).toBe(fallback)
  })
})

describe('listSkillsInDir', () => {
  let skillsDir: string

  beforeEach(() => {
    skillsDir = join(root, 'skills')
  })

  it('returns an empty list when the directory is missing', async () => {
    await expect(listSkillsInDir(skillsDir)).resolves.toEqual([])
  })

  it('lists skills sorted by id with their frontmatter name and description', async () => {
    await writeSkill(skillsDir, 'zeta')
    await writeSkill(skillsDir, 'alpha')
    await writeSkill(skillsDir, 'Mid')

    await expect(listSkillsInDir(skillsDir)).resolves.toEqual([
      { id: 'alpha', name: 'alpha', description: 'Does alpha' },
      { id: 'Mid', name: 'Mid', description: 'Does Mid' },
      { id: 'zeta', name: 'zeta', description: 'Does zeta' }
    ])
  })

  it('follows a symlinked skill directory and names the skill after the symlink', async () => {
    const target = join(root, 'elsewhere', 'real-skill')
    await writeSkill(join(root, 'elsewhere'), 'real-skill')
    await mkdir(skillsDir)
    await symlink(target, join(skillsDir, 'linked'), 'dir')

    await expect(listSkillsInDir(skillsDir)).resolves.toEqual([
      { id: 'linked', name: 'real-skill', description: 'Does real-skill' }
    ])
  })

  it('only looks one level deep', async () => {
    await writeSkill(join(skillsDir, 'group'), 'nested')

    await expect(listSkillsInDir(skillsDir)).resolves.toEqual([])
  })

  it('skips dot-directories and the reserved "synced" directory', async () => {
    await writeSkill(skillsDir, '.trash')
    await writeSkill(skillsDir, 'synced')
    await writeSkill(skillsDir, 'kept')

    const skills = await listSkillsInDir(skillsDir)

    expect(skills.map((skill) => skill.id)).toEqual(['kept'])
  })

  it('skips entries that have no SKILL.md file', async () => {
    await mkdir(join(skillsDir, 'empty-dir'), { recursive: true })
    await writeFile(join(skillsDir, 'empty-dir', 'README.md'), '# not a skill')
    await writeFile(join(skillsDir, 'loose-file.md'), '# not a skill')
    // A directory called SKILL.md is not a skill file either.
    await mkdir(join(skillsDir, 'dir-as-file', 'SKILL.md'), { recursive: true })

    await expect(listSkillsInDir(skillsDir)).resolves.toEqual([])
  })

  it('lists a skill without frontmatter under its directory name', async () => {
    await writeSkill(skillsDir, 'plain', '# Plain\n\nJust instructions.\n')

    await expect(listSkillsInDir(skillsDir)).resolves.toEqual([
      { id: 'plain', name: 'plain', description: null }
    ])
  })

  it('keeps the directory name as the id when the frontmatter name differs', async () => {
    await writeSkill(
      skillsDir,
      'dir-name',
      '---\nname: Display Name\ndescription: "  Padded  "\n---\n'
    )

    await expect(listSkillsInDir(skillsDir)).resolves.toEqual([
      { id: 'dir-name', name: 'Display Name', description: 'Padded' }
    ])
  })

  it('falls back to the id and a null description for unusable field values', async () => {
    await writeSkill(skillsDir, 'blank', '---\nname: ""\ndescription: "   "\n---\n')
    await writeSkill(skillsDir, 'typed', '---\nname: 42\ndescription:\n  - a\n  - b\n---\n')
    await writeSkill(skillsDir, 'scalar', '---\njust a string\n---\n')

    await expect(listSkillsInDir(skillsDir)).resolves.toEqual([
      { id: 'blank', name: 'blank', description: null },
      { id: 'scalar', name: 'scalar', description: null },
      { id: 'typed', name: 'typed', description: null }
    ])
  })

  it('keeps a multi-line block description', async () => {
    await writeSkill(skillsDir, 'block', '---\ndescription: |\n  First line\n  Second line\n---\n')

    await expect(listSkillsInDir(skillsDir)).resolves.toEqual([
      { id: 'block', name: 'block', description: 'First line\nSecond line' }
    ])
  })

  it('still lists a skill whose frontmatter is invalid YAML', async () => {
    await writeSkill(skillsDir, 'broken', '---\n{ unclosed: [\n\t- : :\n---\nBody\n')

    await expect(listSkillsInDir(skillsDir)).resolves.toEqual([
      { id: 'broken', name: 'broken', description: null }
    ])
  })

  it('recovers single-line fields from frontmatter with an unquoted colon', async () => {
    await writeSkill(
      skillsDir,
      'colon',
      '---\nname: Colon Skill\ndescription: Use when: the user asks\n---\n'
    )

    await expect(listSkillsInDir(skillsDir)).resolves.toEqual([
      { id: 'colon', name: 'Colon Skill', description: 'Use when: the user asks' }
    ])
  })

  it('parses CRLF frontmatter', async () => {
    await writeSkill(
      skillsDir,
      'windows',
      '---\r\nname: Windows Skill\r\ndescription: Line endings\r\n---\r\n\r\nBody\r\n'
    )

    await expect(listSkillsInDir(skillsDir)).resolves.toEqual([
      { id: 'windows', name: 'Windows Skill', description: 'Line endings' }
    ])
  })

  it('still lists a skill whose SKILL.md is binary garbage', async () => {
    await mkdir(join(skillsDir, 'garbage'), { recursive: true })
    await writeFile(join(skillsDir, 'garbage', 'SKILL.md'), Buffer.from([0xff, 0xfe, 0x00, 0x2d]))

    await expect(listSkillsInDir(skillsDir)).resolves.toEqual([
      { id: 'garbage', name: 'garbage', description: null }
    ])
  })

  // chmod can't make a file unreadable on Windows or for root.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'still lists a skill whose SKILL.md cannot be read',
    async () => {
      await writeSkill(skillsDir, 'locked')
      await chmod(join(skillsDir, 'locked', 'SKILL.md'), 0o000)

      await expect(listSkillsInDir(skillsDir)).resolves.toEqual([
        { id: 'locked', name: 'locked', description: null }
      ])
    }
  )
})

describe('listProjectSkills', () => {
  it('lists global skills from the config dir and project skills from the project', async () => {
    await writeSkill(join(configDir, 'skills'), 'global-one')
    await writeSkill(projectSkillsDir, 'project-one')

    await expect(listProjectSkills(projectDir, { configDir })).resolves.toEqual({
      globalSkills: [{ id: 'global-one', name: 'global-one', description: 'Does global-one' }],
      projectSkills: [
        { id: 'project-one', name: 'project-one', description: 'Does project-one', enabled: true }
      ]
    })
  })

  it('returns empty lists when neither skills directory exists', async () => {
    await expect(listProjectSkills(projectDir, { configDir })).resolves.toEqual({
      globalSkills: [],
      projectSkills: []
    })
  })

  it('marks a skill disabled when any settings layer turns it off', async () => {
    for (const id of ['by-local', 'by-project', 'by-user', 'untouched']) {
      await writeSkill(projectSkillsDir, id)
    }
    await writeJson(localSettingsPath, { skillOverrides: { 'by-local': 'off' } })
    await writeJson(join(projectDir, '.claude', 'settings.json'), {
      skillOverrides: { 'by-project': 'off' }
    })
    await writeJson(join(configDir, 'settings.json'), { skillOverrides: { 'by-user': 'off' } })

    await expect(enabledById()).resolves.toEqual({
      'by-local': false,
      'by-project': false,
      'by-user': false,
      untouched: true
    })
  })

  it('resolves each skill from the highest-precedence layer that mentions it', async () => {
    for (const id of ['local-on', 'local-off', 'project-on', 'project-off']) {
      await writeSkill(projectSkillsDir, id)
    }
    await writeJson(localSettingsPath, {
      skillOverrides: { 'local-on': 'on', 'local-off': 'off' }
    })
    await writeJson(join(projectDir, '.claude', 'settings.json'), {
      skillOverrides: {
        'local-on': 'off',
        'local-off': 'on',
        'project-on': 'on',
        'project-off': 'off'
      }
    })
    await writeJson(join(configDir, 'settings.json'), {
      skillOverrides: { 'local-on': 'off', 'project-on': 'off', 'project-off': 'on' }
    })

    await expect(enabledById()).resolves.toEqual({
      'local-on': true,
      'local-off': false,
      'project-on': true,
      'project-off': false
    })
  })

  it('treats the partial visibility modes as enabled', async () => {
    await writeSkill(projectSkillsDir, 'name-only')
    await writeSkill(projectSkillsDir, 'user-only')
    await writeJson(localSettingsPath, {
      skillOverrides: { 'name-only': 'name-only', 'user-only': 'user-invocable-only' }
    })

    await expect(enabledById()).resolves.toEqual({ 'name-only': true, 'user-only': true })
  })

  it('ignores settings files that are missing, unparseable or have no usable overrides', async () => {
    await writeSkill(projectSkillsDir, 'deploy')
    await mkdir(join(projectDir, '.claude'), { recursive: true })
    await writeFile(localSettingsPath, '{ not json')
    await writeJson(join(projectDir, '.claude', 'settings.json'), { skillOverrides: ['deploy'] })
    await writeJson(join(configDir, 'settings.json'), ['deploy'])

    await expect(enabledById()).resolves.toEqual({ deploy: true })
  })

  it('drops a whole layer over one invalid value, as the CLI does', async () => {
    await writeSkill(projectSkillsDir, 'deploy')
    await writeSkill(projectSkillsDir, 'release')
    await writeJson(localSettingsPath, { skillOverrides: { deploy: 'off', release: false } })
    await writeJson(join(configDir, 'settings.json'), { skillOverrides: { release: 'off' } })

    await expect(enabledById()).resolves.toEqual({ deploy: true, release: false })
  })

  it('never applies overrides to global skills', async () => {
    await writeSkill(join(configDir, 'skills'), 'shared')
    await writeJson(localSettingsPath, { skillOverrides: { shared: 'off' } })

    const { globalSkills } = await listProjectSkills(projectDir, { configDir })

    expect(globalSkills).toEqual([{ id: 'shared', name: 'shared', description: 'Does shared' }])
  })
})

describe('setDisabledProjectSkills', () => {
  beforeEach(async () => {
    await writeSkill(projectSkillsDir, 'deploy')
    await writeSkill(projectSkillsDir, 'release')
  })

  it('creates the local settings file with "off" for a newly disabled skill', async () => {
    await expect(setDisabledProjectSkills(projectDir, ['deploy'], { configDir })).resolves.toEqual({
      success: true
    })

    expect(await readFile(localSettingsPath, 'utf-8')).toBe(
      JSON.stringify({ skillOverrides: { deploy: 'off' } }, null, 2)
    )
    await expect(enabledById()).resolves.toEqual({ deploy: false, release: true })
  })

  it('preserves unrelated top-level keys and unrelated overrides when disabling', async () => {
    await writeJson(localSettingsPath, {
      permissions: { allow: ['Bash(ls:*)'] },
      skillOverrides: {
        release: 'name-only',
        'removed-skill': 'off',
        'another-gone': 'user-invocable-only'
      },
      env: { FOO: 'bar' }
    })

    await expect(setDisabledProjectSkills(projectDir, ['deploy'], { configDir })).resolves.toEqual({
      success: true
    })

    expect(await readJson(localSettingsPath)).toEqual({
      permissions: { allow: ['Bash(ls:*)'] },
      skillOverrides: {
        release: 'name-only',
        'removed-skill': 'off',
        'another-gone': 'user-invocable-only',
        deploy: 'off'
      },
      env: { FOO: 'bar' }
    })
  })

  it('re-enables by deleting the key and drops an emptied skillOverrides', async () => {
    await writeJson(localSettingsPath, {
      permissions: { allow: [] },
      skillOverrides: { deploy: 'off' }
    })

    await expect(setDisabledProjectSkills(projectDir, [], { configDir })).resolves.toEqual({
      success: true
    })

    expect(await readJson(localSettingsPath)).toEqual({ permissions: { allow: [] } })
  })

  it('re-enables one skill while leaving the other entries in place', async () => {
    await writeJson(localSettingsPath, {
      skillOverrides: { deploy: 'off', release: 'off', 'removed-skill': 'off' }
    })

    await setDisabledProjectSkills(projectDir, ['release'], { configDir })

    expect(await readJson(localSettingsPath)).toEqual({
      skillOverrides: { release: 'off', 'removed-skill': 'off' }
    })
  })

  it('writes "on" to re-enable a skill the project settings.json turns off', async () => {
    await writeJson(join(projectDir, '.claude', 'settings.json'), {
      skillOverrides: { deploy: 'off' }
    })

    await expect(setDisabledProjectSkills(projectDir, [], { configDir })).resolves.toEqual({
      success: true
    })

    expect(await readJson(localSettingsPath)).toEqual({ skillOverrides: { deploy: 'on' } })
    await expect(enabledById()).resolves.toEqual({ deploy: true, release: true })
  })

  it('writes "on" to re-enable a skill the user settings.json turns off', async () => {
    await writeJson(join(configDir, 'settings.json'), { skillOverrides: { release: 'off' } })
    await writeJson(localSettingsPath, { skillOverrides: { release: 'off' } })

    await setDisabledProjectSkills(projectDir, [], { configDir })

    expect(await readJson(localSettingsPath)).toEqual({ skillOverrides: { release: 'on' } })
  })

  it('does not create the file when nothing changes', async () => {
    await expect(setDisabledProjectSkills(projectDir, [], { configDir })).resolves.toEqual({
      success: true
    })

    expect(await exists(localSettingsPath)).toBe(false)
  })

  it('does not rewrite the file when the requested state is already in effect', async () => {
    const original = '{"skillOverrides":{"deploy":"off","release":"name-only"}}'
    await mkdir(dirname(localSettingsPath), { recursive: true })
    await writeFile(localSettingsPath, original)

    await expect(setDisabledProjectSkills(projectDir, ['deploy'], { configDir })).resolves.toEqual({
      success: true
    })

    // A rewrite would pretty-print; byte equality proves the file was untouched.
    expect(await readFile(localSettingsPath, 'utf-8')).toBe(original)
  })

  it('leaves a skill alone when a lower layer already disables it', async () => {
    await writeJson(join(projectDir, '.claude', 'settings.json'), {
      skillOverrides: { deploy: 'off' }
    })

    await setDisabledProjectSkills(projectDir, ['deploy'], { configDir })

    expect(await exists(localSettingsPath)).toBe(false)
  })

  it('ignores ids that are not skills in the project', async () => {
    await writeSkill(join(configDir, 'skills'), 'global-one')

    await expect(
      setDisabledProjectSkills(projectDir, ['global-one', 'never-existed', '__proto__'], {
        configDir
      })
    ).resolves.toEqual({ success: true })

    expect(await exists(localSettingsPath)).toBe(false)
  })

  // The CLI refuses to store an override under "__proto__", so writing one would
  // report success while the skill stays active.
  it('refuses to disable a skill named __proto__ and never reads an entry for it', async () => {
    await writeSkill(projectSkillsDir, '__proto__')
    await writeJson(localSettingsPath, { skillOverrides: { ['__proto__']: 'off' } })

    const { projectSkills } = await listProjectSkills(projectDir, { configDir })
    expect(projectSkills.find((s) => s.id === '__proto__')).toMatchObject({ enabled: true })

    const result = await setDisabledProjectSkills(projectDir, ['__proto__'], { configDir })
    expect(result).toEqual({
      success: false,
      error: expect.stringContaining('"__proto__"')
    })
    await expect(setDisabledProjectSkills(projectDir, [], { configDir })).resolves.toEqual({
      success: true
    })
  })

  it('leaves an unparseable local settings file untouched and reports failure', async () => {
    await mkdir(dirname(localSettingsPath), { recursive: true })
    await writeFile(localSettingsPath, '{ this is not json')

    const result = await setDisabledProjectSkills(projectDir, ['deploy'], { configDir })

    expect(result.success).toBe(false)
    expect(result.error).toContain(localSettingsPath)
    expect(await readFile(localSettingsPath, 'utf-8')).toBe('{ this is not json')
  })

  it('leaves a non-object local settings file untouched and reports failure', async () => {
    await mkdir(dirname(localSettingsPath), { recursive: true })
    await writeFile(localSettingsPath, '[1,2,3]')

    const result = await setDisabledProjectSkills(projectDir, ['deploy'], { configDir })

    expect(result.success).toBe(false)
    expect(result.error).toContain(localSettingsPath)
    expect(await readFile(localSettingsPath, 'utf-8')).toBe('[1,2,3]')
  })

  it('refuses to write on top of a skillOverrides the CLI would reject', async () => {
    const original = '{"skillOverrides":{"release":false}}'
    await mkdir(dirname(localSettingsPath), { recursive: true })
    await writeFile(localSettingsPath, original)

    const result = await setDisabledProjectSkills(projectDir, ['deploy'], { configDir })

    expect(result.success).toBe(false)
    expect(result.error).toContain(localSettingsPath)
    expect(await readFile(localSettingsPath, 'utf-8')).toBe(original)
    // With nothing to change there is nothing to refuse.
    await expect(setDisabledProjectSkills(projectDir, [], { configDir })).resolves.toEqual({
      success: true
    })
  })

  it('treats an empty local settings file as an empty object', async () => {
    await mkdir(dirname(localSettingsPath), { recursive: true })
    await writeFile(localSettingsPath, '')

    await expect(setDisabledProjectSkills(projectDir, ['deploy'], { configDir })).resolves.toEqual({
      success: true
    })

    expect(await readJson(localSettingsPath)).toEqual({ skillOverrides: { deploy: 'off' } })
  })

  it('reports failure when the project path is missing or not a directory', async () => {
    const filePath = join(root, 'a-file')
    await writeFile(filePath, 'x')

    for (const path of [join(root, 'missing'), filePath]) {
      const result = await setDisabledProjectSkills(path, ['deploy'], { configDir })
      expect(result.success).toBe(false)
      expect(result.error).toContain(path)
    }
  })

  it('applies overlapping saves one after another', async () => {
    const results = await Promise.all([
      setDisabledProjectSkills(projectDir, ['deploy'], { configDir }),
      setDisabledProjectSkills(projectDir, ['deploy', 'release'], { configDir }),
      setDisabledProjectSkills(projectDir, ['release'], { configDir })
    ])

    expect(results).toEqual([{ success: true }, { success: true }, { success: true }])
    expect(await readJson(localSettingsPath)).toEqual({ skillOverrides: { release: 'off' } })
  })

  describe.skipIf(process.platform === 'win32')('file permissions', () => {
    it('creates the file with the mode a plain create would get under the umask', async () => {
      await setDisabledProjectSkills(projectDir, ['deploy'], { configDir })

      expect((await stat(localSettingsPath)).mode & 0o777).toBe(0o666 & ~process.umask())
    })

    it('creates a private file under a restrictive umask', async () => {
      const previous = process.umask(0o077)
      try {
        await setDisabledProjectSkills(projectDir, ['deploy'], { configDir })
      } finally {
        process.umask(previous)
      }

      expect((await stat(localSettingsPath)).mode & 0o777).toBe(0o600)
    })

    it('refuses to replace a symlink whose target is missing', async () => {
      const target = join(root, 'dotfiles', 'settings.local.json')
      await mkdir(dirname(localSettingsPath), { recursive: true })
      await symlink(target, localSettingsPath)

      const result = await setDisabledProjectSkills(projectDir, ['deploy'], { configDir })

      expect(result).toEqual({
        success: false,
        error: expect.stringContaining('symlink whose target is missing')
      })
      expect((await lstat(localSettingsPath)).isSymbolicLink()).toBe(true)
      expect(await exists(target)).toBe(false)
    })

    it("preserves an existing file's mode", async () => {
      await writeJson(localSettingsPath, { permissions: {} })
      await chmod(localSettingsPath, 0o600)

      await setDisabledProjectSkills(projectDir, ['deploy'], { configDir })

      expect((await stat(localSettingsPath)).mode & 0o777).toBe(0o600)
      expect(await readJson(localSettingsPath)).toEqual({
        permissions: {},
        skillOverrides: { deploy: 'off' }
      })
    })

    it('writes through a symlinked settings file instead of replacing the link', async () => {
      const target = join(root, 'dotfiles', 'settings.local.json')
      await writeJson(target, { env: { FOO: 'bar' } })
      await mkdir(dirname(localSettingsPath), { recursive: true })
      await symlink(target, localSettingsPath)

      await setDisabledProjectSkills(projectDir, ['deploy'], { configDir })

      expect(await realpath(localSettingsPath)).toBe(target)
      expect(await readJson(target)).toEqual({
        env: { FOO: 'bar' },
        skillOverrides: { deploy: 'off' }
      })
    })
  })
})

const gitAvailable = ((): boolean => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

describe.skipIf(!gitAvailable)('setDisabledProjectSkills git exclude', () => {
  const IGNORE_LINE = '.claude/settings.local.json'
  let excludePath: string

  beforeEach(async () => {
    // Keep the developer's own git config and global ignore file (which may well
    // already list settings.local.json) out of the temp repo's ignore rules.
    vi.stubEnv('GIT_CONFIG_GLOBAL', join(root, 'no-gitconfig'))
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
    vi.stubEnv('XDG_CONFIG_HOME', join(root, 'no-xdg'))
    execFileSync('git', ['init', '-q', projectDir])
    excludePath = join(projectDir, '.git', 'info', 'exclude')
    await writeSkill(projectSkillsDir, 'deploy')
    await writeSkill(projectSkillsDir, 'release')
  })

  function isIgnored(cwd: string): boolean {
    try {
      execFileSync('git', ['check-ignore', '-q', '--', IGNORE_LINE], { cwd, stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  }

  async function excludeLines(): Promise<string[]> {
    return (await readFile(excludePath, 'utf-8')).split('\n')
  }

  it('adds the file to info/exclude when the save creates it', async () => {
    await mkdir(dirname(excludePath), { recursive: true })
    await writeFile(excludePath, '# local excludes\n*.log')

    await setDisabledProjectSkills(projectDir, ['deploy'], { configDir })

    expect(await readFile(excludePath, 'utf-8')).toBe(`# local excludes\n*.log\n${IGNORE_LINE}\n`)
    expect(isIgnored(projectDir)).toBe(true)
  })

  it('creates info/exclude when the repo has none', async () => {
    await rm(join(projectDir, '.git', 'info'), { recursive: true, force: true })

    await setDisabledProjectSkills(projectDir, ['deploy'], { configDir })

    expect(await readFile(excludePath, 'utf-8')).toBe(`${IGNORE_LINE}\n`)
  })

  it('does not add the line again on later saves', async () => {
    await setDisabledProjectSkills(projectDir, ['deploy'], { configDir })
    await setDisabledProjectSkills(projectDir, ['deploy', 'release'], { configDir })
    await setDisabledProjectSkills(projectDir, [], { configDir })

    expect((await excludeLines()).filter((line) => line === IGNORE_LINE)).toHaveLength(1)
  })

  it('does not touch info/exclude when the settings file already existed', async () => {
    await writeJson(localSettingsPath, { permissions: {} })
    const before = await readFile(excludePath, 'utf-8').catch(() => null)

    await setDisabledProjectSkills(projectDir, ['deploy'], { configDir })

    expect(await readFile(excludePath, 'utf-8').catch(() => null)).toBe(before)
  })

  it('does not add the line when .gitignore already covers the file', async () => {
    await writeFile(join(projectDir, '.gitignore'), '.claude/*.local.json\n')
    const before = await readFile(excludePath, 'utf-8').catch(() => null)

    await setDisabledProjectSkills(projectDir, ['deploy'], { configDir })

    expect(await exists(localSettingsPath)).toBe(true)
    expect(await readFile(excludePath, 'utf-8').catch(() => null)).toBe(before)
  })

  it('does not add the line when it is already in info/exclude without a trailing newline', async () => {
    await mkdir(dirname(excludePath), { recursive: true })
    await writeFile(excludePath, `*.log\n${IGNORE_LINE}`)

    await setDisabledProjectSkills(projectDir, ['deploy'], { configDir })

    expect(await readFile(excludePath, 'utf-8')).toBe(`*.log\n${IGNORE_LINE}`)
  })

  it('does not add a useless rule when the file is tracked but missing from the tree', async () => {
    const git = (args: string[]): void => {
      execFileSync('git', args, { cwd: projectDir, stdio: 'ignore' })
    }
    await writeJson(localSettingsPath, {})
    git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', IGNORE_LINE])
    git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'track'])
    await rm(localSettingsPath)

    await setDisabledProjectSkills(projectDir, ['deploy'], { configDir })
    await rm(localSettingsPath)
    await setDisabledProjectSkills(projectDir, ['deploy'], { configDir })

    expect(await readFile(excludePath, 'utf-8').catch(() => '')).not.toContain(IGNORE_LINE)
  })

  it('does not touch info/exclude when the save writes nothing', async () => {
    const before = await readFile(excludePath, 'utf-8').catch(() => null)

    await setDisabledProjectSkills(projectDir, [], { configDir })

    expect(await readFile(excludePath, 'utf-8').catch(() => null)).toBe(before)
  })

  it('anchors the rule to a project that lives in a subdirectory of the repo', async () => {
    const subProject = join(projectDir, 'packages', 'app')
    await writeSkill(join(subProject, '.claude', 'skills'), 'lint')

    await expect(setDisabledProjectSkills(subProject, ['lint'], { configDir })).resolves.toEqual({
      success: true
    })

    expect(await excludeLines()).toContain(`packages/app/${IGNORE_LINE}`)
    expect(isIgnored(subProject)).toBe(true)
  })

  it('saves normally in a folder that is not a git repo', async () => {
    const plainProject = join(root, 'plain')
    await writeSkill(join(plainProject, '.claude', 'skills'), 'lint')

    await expect(setDisabledProjectSkills(plainProject, ['lint'], { configDir })).resolves.toEqual({
      success: true
    })

    expect(await exists(join(plainProject, '.git'))).toBe(false)
    expect(await readJson(join(plainProject, '.claude', 'settings.local.json'))).toEqual({
      skillOverrides: { lint: 'off' }
    })
  })
})
