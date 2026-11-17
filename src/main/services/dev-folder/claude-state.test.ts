// Claude's history folders after a project moved. Everything lives in a temp directory: the
// `projects` roots are always passed in, and `run` below refuses a root outside that
// directory before anything is touched.
import { existsSync, realpathSync } from 'node:fs'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename as renameOnDisk,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { homedir, tmpdir, userInfo } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

import { encodePath, resolveProjectsDir } from '../claude-transcript-reader'
import {
  claudeProjectRoots,
  moveClaudeTranscripts,
  type ClaudeStateFileOps,
  type MoveClaudeTranscriptsInput
} from './claude-state'

let tmp: string
let root: string

beforeEach(async () => {
  // The real spelling: on macOS the temp directory is reached through a link.
  tmp = realpathSync(await mkdtemp(join(tmpdir(), 'claude-state-test-')))
  root = join(tmp, 'claude', 'projects')
  await mkdir(root, { recursive: true })
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(tmp, { recursive: true, force: true })
})

const run = (input: MoveClaudeTranscriptsInput, ops?: ClaudeStateFileOps): Promise<string[]> => {
  for (const entry of input.roots) {
    if (!entry.startsWith(tmp + sep)) throw new Error(`a test may not touch ${entry}`)
  }
  return moveClaudeTranscripts(input, ops)
}

const write = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

/** A transcript as Claude writes it: the first line has no `cwd`, the second records it. */
const transcript = (cwd: string | null, text = 'hello'): string =>
  [
    JSON.stringify({ type: 'file-history-snapshot', messageId: 'm1', snapshot: {} }),
    JSON.stringify({
      parentUuid: null,
      type: 'user',
      message: { role: 'user', content: text },
      ...(cwd === null ? {} : { cwd }),
      sessionId: 'session'
    }),
    ''
  ].join('\n')

/** Every file under `dir` (relative path → content): a whole folder as one comparable value. */
const tree = async (dir: string, prefix = ''): Promise<Record<string, string>> => {
  const files: Record<string, string> = {}
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      const nested = await tree(join(dir, entry.name), relative)
      if (Object.keys(nested).length === 0) files[`${relative}/`] = ''
      Object.assign(files, nested)
    } else {
      files[relative] = await readFile(join(dir, entry.name), 'utf-8')
    }
  }
  return files
}

const folderOf = (path: string, inRoot: string = root): string => join(inRoot, encodePath(path))

const errorWithCode = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code}: simulated`), { code })

const OLD = '/dev-old/app'
const NEW = '/dev-new/app'

/** Whether the temp directory is on a volume where `a` and `A` name the same entry. */
const ignoresLetterCase = existsSync(tmpdir().toUpperCase()) && existsSync(tmpdir().toLowerCase())

describe('moveClaudeTranscripts: a folder of its own', () => {
  it('renames the whole folder when the destination is free, and does nothing the second time', async () => {
    const source = folderOf(OLD)
    await write(join(source, 's1.jsonl'), transcript(OLD))
    await write(join(source, 's1', 'subagents', 'agent-a.jsonl'), 'subagent')
    await write(join(source, 'memory', 'MEMORY.md'), 'remember this')
    const before = await tree(source)
    const input = { moves: [{ from: OLD, to: NEW }], roots: [root], otherRegisteredPaths: [] }

    await expect(run(input)).resolves.toEqual([])

    expect(existsSync(source)).toBe(false)
    expect(await tree(folderOf(NEW))).toEqual(before)

    await expect(run(input)).resolves.toEqual([])
    expect(await tree(folderOf(NEW))).toEqual(before)
    expect(await readdir(root)).toEqual([encodePath(NEW)])
  })

  it('moves a folder that holds nothing but memory', async () => {
    await write(join(folderOf(OLD), 'memory', 'MEMORY.md'), 'main checkout memory')

    await expect(
      run({ moves: [{ from: OLD, to: NEW }], roots: [root], otherRegisteredPaths: [] })
    ).resolves.toEqual([])

    expect(await tree(root)).toEqual({
      [`${encodePath(NEW)}/memory/MEMORY.md`]: 'main checkout memory'
    })
  })

  it('does nothing when Claude has no folder for the old path', async () => {
    await write(join(folderOf('/dev-old/unrelated'), 's.jsonl'), transcript('/dev-old/unrelated'))
    const before = await tree(root)

    await expect(
      run({ moves: [{ from: OLD, to: NEW }], roots: [root], otherRegisteredPaths: [] })
    ).resolves.toEqual([])

    expect(await tree(root)).toEqual(before)
  })

  it('ignores a move whose old and new path derive the same folder name', async () => {
    await write(join(folderOf('/dev/my-app'), 's.jsonl'), transcript('/dev/my-app'))
    const before = await tree(root)

    await expect(
      run({
        moves: [{ from: '/dev/my-app', to: '/dev/my_app' }],
        roots: [root],
        otherRegisteredPaths: []
      })
    ).resolves.toEqual([])

    expect(await tree(root)).toEqual(before)
  })

  it('moves the checkout and a worktree nested in it, each to its own folder', async () => {
    const nestedOld = `${OLD}/.claude/worktrees/w1`
    const nestedNew = `${NEW}/.claude/worktrees/w1`
    // Claude keeps the memory of a linked worktree under the main checkout's folder.
    await write(join(folderOf(OLD), 'memory', 'MEMORY.md'), 'shared by the worktrees')
    await write(join(folderOf(nestedOld), 'w.jsonl'), transcript(nestedOld))
    await write(join(folderOf(nestedOld), 'w', 'tool-results', 'r.txt'), 'result')

    await expect(
      run({
        moves: [
          { from: OLD, to: NEW },
          { from: nestedOld, to: nestedNew }
        ],
        roots: [root],
        otherRegisteredPaths: ['/dev-old/elsewhere']
      })
    ).resolves.toEqual([])

    expect(await tree(root)).toEqual({
      [`${encodePath(NEW)}/memory/MEMORY.md`]: 'shared by the worktrees',
      [`${encodePath(nestedNew)}/w.jsonl`]: transcript(nestedOld),
      [`${encodePath(nestedNew)}/w/tool-results/r.txt`]: 'result'
    })
  })

  it('brings both spellings of the old path to the one new folder', async () => {
    const lexical = '/link/dev/app'
    const real = '/volumes/real/dev/app'
    await write(join(folderOf(lexical), 'a.jsonl'), transcript(lexical))
    await write(join(folderOf(real), 'b.jsonl'), transcript(real))
    await write(join(folderOf(real), 'memory', 'MEMORY.md'), 'memory')

    await expect(
      run({
        moves: [
          { from: lexical, to: NEW },
          { from: real, to: NEW }
        ],
        roots: [root],
        otherRegisteredPaths: []
      })
    ).resolves.toEqual([])

    expect(await tree(root)).toEqual({
      [`${encodePath(NEW)}/a.jsonl`]: transcript(lexical),
      [`${encodePath(NEW)}/b.jsonl`]: transcript(real),
      [`${encodePath(NEW)}/memory/MEMORY.md`]: 'memory'
    })
  })
})

describe('moveClaudeTranscripts: the destination folder exists', () => {
  it('moves what the destination lacks, never overwrites, and merges memory one level deep', async () => {
    const source = folderOf(OLD)
    const destination = folderOf(NEW)
    await write(join(source, 'a.jsonl'), transcript(OLD, 'older a'))
    await write(join(source, 'b.jsonl'), transcript(OLD, 'only in the old folder'))
    await write(join(source, 'b', 'subagents', 'agent.jsonl'), 'subagent of b')
    await write(join(source, 'c', 'tool-results', 'old.txt'), 'older c')
    await write(join(source, 'memory', 'MEMORY.md'), 'older memory')
    await write(join(source, 'memory', 'notes.md'), 'notes')
    await write(join(source, 'memory', 'topics', 'build.md'), 'a topic')
    await write(join(source, 'memory', 'people', 'old.md'), 'older people')
    await write(join(destination, 'a.jsonl'), transcript(NEW, 'newer a'))
    await write(join(destination, 'c', 'tool-results', 'new.txt'), 'newer c')
    await write(join(destination, 'z.jsonl'), transcript(NEW, 'only in the new folder'))
    await write(join(destination, 'memory', 'MEMORY.md'), 'newer memory')
    await write(join(destination, 'memory', 'people', 'new.md'), 'newer people')
    const input = { moves: [{ from: OLD, to: NEW }], roots: [root], otherRegisteredPaths: [] }

    const warnings = await run(input)

    expect(await tree(destination)).toEqual({
      'a.jsonl': transcript(NEW, 'newer a'),
      'b.jsonl': transcript(OLD, 'only in the old folder'),
      'b/subagents/agent.jsonl': 'subagent of b',
      'c/tool-results/new.txt': 'newer c',
      'z.jsonl': transcript(NEW, 'only in the new folder'),
      'memory/MEMORY.md': 'newer memory',
      'memory/notes.md': 'notes',
      'memory/topics/build.md': 'a topic',
      'memory/people/new.md': 'newer people'
    })
    // What the destination already had under the same name stays where it was.
    const left = {
      'a.jsonl': transcript(OLD, 'older a'),
      'c/tool-results/old.txt': 'older c',
      'memory/MEMORY.md': 'older memory',
      'memory/people/old.md': 'older people'
    }
    expect(await tree(source)).toEqual(left)
    expect(warnings).toEqual([
      `Claude already had a.jsonl, c, memory/MEMORY.md, memory/people in ${destination}, so the older copies are still in ${source}. Compare them before deleting the older ones.`
    ])

    // A second run changes nothing and says the same.
    const after = await tree(root)
    await expect(run(input)).resolves.toEqual(warnings)
    expect(await tree(root)).toEqual(after)
  })

  it('removes the old folder once it is empty', async () => {
    const source = folderOf(OLD)
    const destination = folderOf(NEW)
    await write(join(source, 'b.jsonl'), transcript(OLD))
    await write(join(source, 'memory', 'notes.md'), 'notes')
    await write(join(destination, 'memory', 'MEMORY.md'), 'newer memory')

    await expect(
      run({ moves: [{ from: OLD, to: NEW }], roots: [root], otherRegisteredPaths: [] })
    ).resolves.toEqual([])

    expect(existsSync(source)).toBe(false)
    expect(await tree(destination)).toEqual({
      'b.jsonl': transcript(OLD),
      'memory/MEMORY.md': 'newer memory',
      'memory/notes.md': 'notes'
    })
  })

  it('treats an entry that is already at the destination with the same content as moved', async () => {
    const source = folderOf(OLD)
    const destination = folderOf(NEW)
    for (const folder of [source, destination]) {
      await write(join(folder, 'a.jsonl'), transcript(OLD, 'the same'))
      await write(join(folder, 'a', 'subagents', 'agent.jsonl'), 'the same subagent')
      await write(join(folder, 'memory', 'MEMORY.md'), 'the same memory')
      await write(join(folder, 'memory', 'topics', 'build.md'), 'the same topic')
    }
    const before = await tree(destination)

    await expect(
      run({ moves: [{ from: OLD, to: NEW }], roots: [root], otherRegisteredPaths: [] })
    ).resolves.toEqual([])

    expect(existsSync(source)).toBe(false)
    expect(await tree(destination)).toEqual(before)
  })

  it('keeps a directory whose content differs from the one at the destination', async () => {
    const source = folderOf(OLD)
    const destination = folderOf(NEW)
    await write(join(source, 'a', 'subagents', 'agent.jsonl'), 'one more line')
    await write(join(source, 'b', 'subagents', 'agent.jsonl'), 'same size')
    await write(join(source, 'c', 'one.txt'), 'x')
    await write(join(destination, 'a', 'subagents', 'agent.jsonl'), 'one')
    await write(join(destination, 'b', 'subagents', 'agent.jsonl'), 'SAME SIZE')
    await write(join(destination, 'c', 'two.txt'), 'x')
    const before = await tree(root)

    await expect(
      run({ moves: [{ from: OLD, to: NEW }], roots: [root], otherRegisteredPaths: [] })
    ).resolves.toEqual([
      `Claude already had a, b, c in ${destination}, so the older copies are still in ${source}. Compare them before deleting the older ones.`
    ])

    expect(await tree(root)).toEqual(before)
  })

  it('leaves the folder alone when the new name leads to the very same folder', async () => {
    const source = folderOf(OLD)
    await write(join(source, 'a.jsonl'), transcript(OLD))
    await write(join(source, 'memory', 'MEMORY.md'), 'memory')
    await symlink(source, folderOf(NEW), 'dir')
    const before = await tree(source)

    await expect(
      run({ moves: [{ from: OLD, to: NEW }], roots: [root], otherRegisteredPaths: [] })
    ).resolves.toEqual([])

    expect(await tree(source)).toEqual(before)
  })

  it.skipIf(!ignoresLetterCase)(
    'leaves the folder alone when the names differ in letter case on a volume that ignores it',
    async () => {
      const from = '/Dev_Old/app'
      const to = '/dev-old/app'
      expect(encodePath(from)).not.toBe(encodePath(to))
      await write(join(folderOf(from), 'a.jsonl'), transcript(from))
      await write(join(folderOf(from), 'memory', 'MEMORY.md'), 'memory')
      const before = await tree(root)

      await expect(
        run({ moves: [{ from, to }], roots: [root], otherRegisteredPaths: [] })
      ).resolves.toEqual([])

      expect(await tree(root)).toEqual(before)
    }
  )

  it('does not take an entry for a leftover when the destination reaches the same entry through a link', async () => {
    const source = folderOf(OLD)
    const destination = folderOf(NEW)
    await write(join(source, 'a.jsonl'), transcript(OLD))
    await write(join(source, 'memory', 'MEMORY.md'), 'the only copy')
    await write(join(source, 'memory', 'topics', 'build.md'), 'a topic')
    await mkdir(destination, { recursive: true })
    // The new folder's memory is the old folder's memory.
    await symlink(join(source, 'memory'), join(destination, 'memory'), 'dir')

    await expect(
      run({ moves: [{ from: OLD, to: NEW }], roots: [root], otherRegisteredPaths: [] })
    ).resolves.toEqual([])

    expect(await tree(source)).toEqual({
      'memory/MEMORY.md': 'the only copy',
      'memory/topics/build.md': 'a topic'
    })
    expect(await readFile(join(destination, 'a.jsonl'), 'utf-8')).toBe(transcript(OLD))
    expect(await readFile(join(destination, 'memory', 'MEMORY.md'), 'utf-8')).toBe('the only copy')
  })

  it('leaves everything alone when the destination is not a folder', async () => {
    const source = folderOf(OLD)
    await write(join(source, 'a.jsonl'), transcript(OLD))
    await write(folderOf(NEW), 'a file where the folder should be')
    const before = await tree(root)

    await expect(
      run({ moves: [{ from: OLD, to: NEW }], roots: [root], otherRegisteredPaths: [] })
    ).resolves.toEqual([
      `Claude's history for ${OLD} was left in ${source}: ${folderOf(NEW)} is in the way and is not a folder.`
    ])

    expect(await tree(root)).toEqual(before)
  })

  it('leaves a history folder that is not a plain folder alone', async () => {
    await write(folderOf(OLD), 'not a folder')
    const before = await tree(root)

    await expect(
      run({ moves: [{ from: OLD, to: NEW }], roots: [root], otherRegisteredPaths: [] })
    ).resolves.toEqual([
      `Claude's history folder ${folderOf(OLD)} is not a plain folder, so it was left where it is.`
    ])

    expect(await tree(root)).toEqual(before)
  })
})

describe('moveClaudeTranscripts: a folder shared with another project', () => {
  const MINE = '/dev-old/my-app'
  const THEIRS = '/dev-old/my_app'
  const MINE_NEW = '/dev-new/my-app'

  it('moves only the sessions started in the old path and copies the memory', async () => {
    expect(encodePath(MINE)).toBe(encodePath(THEIRS))
    const source = folderOf(MINE)
    const destination = folderOf(MINE_NEW)
    await write(join(source, 'mine.jsonl'), transcript(MINE))
    await write(join(source, 'mine', 'subagents', 'agent.jsonl'), 'my subagent')
    await write(join(source, 'inside.jsonl'), transcript(`${MINE}/packages/web`))
    await write(join(source, 'theirs.jsonl'), transcript(THEIRS))
    await write(join(source, 'theirs', 'subagents', 'agent.jsonl'), 'their subagent')
    await write(join(source, 'unknown.jsonl'), transcript(null))
    await write(join(source, 'orphan', 'tool-results', 'r.txt'), 'no transcript beside it')
    await write(join(source, 'memory', 'MEMORY.md'), 'memory of both')
    await write(join(source, 'memory', 'topics', 'build.md'), 'a topic')
    const input = {
      moves: [{ from: MINE, to: MINE_NEW }],
      roots: [root],
      otherRegisteredPaths: ['/dev-old/unrelated', THEIRS]
    }

    const warnings = await run(input)

    expect(await tree(destination)).toEqual({
      'mine.jsonl': transcript(MINE),
      'mine/subagents/agent.jsonl': 'my subagent',
      'inside.jsonl': transcript(`${MINE}/packages/web`),
      'memory/MEMORY.md': 'memory of both',
      'memory/topics/build.md': 'a topic'
    })
    expect(await tree(source)).toEqual({
      'theirs.jsonl': transcript(THEIRS),
      'theirs/subagents/agent.jsonl': 'their subagent',
      'unknown.jsonl': transcript(null),
      'orphan/tool-results/r.txt': 'no transcript beside it',
      'memory/MEMORY.md': 'memory of both',
      'memory/topics/build.md': 'a topic'
    })
    expect(warnings).toEqual([
      `2 Claude sessions in ${source} could not be matched to ${MINE} or to the other project that shares that folder, and stayed there.`
    ])

    // A second run changes nothing.
    const after = await tree(root)
    await expect(run(input)).resolves.toEqual(warnings)
    expect(await tree(root)).toEqual(after)
  })

  it('merges into an existing destination without overwriting, the memory by copy', async () => {
    const source = folderOf(MINE)
    const destination = folderOf(MINE_NEW)
    await write(join(source, 'mine.jsonl'), transcript(MINE, 'older'))
    await write(join(source, 'fresh.jsonl'), transcript(MINE))
    await write(join(source, 'memory', 'MEMORY.md'), 'older memory')
    await write(join(source, 'memory', 'notes.md'), 'notes')
    await write(join(destination, 'mine.jsonl'), transcript(MINE_NEW, 'newer'))
    await write(join(destination, 'memory', 'MEMORY.md'), 'newer memory')

    const warnings = await run({
      moves: [{ from: MINE, to: MINE_NEW }],
      roots: [root],
      otherRegisteredPaths: [THEIRS]
    })

    expect(await tree(destination)).toEqual({
      'mine.jsonl': transcript(MINE_NEW, 'newer'),
      'fresh.jsonl': transcript(MINE),
      'memory/MEMORY.md': 'newer memory',
      'memory/notes.md': 'notes'
    })
    expect(await tree(source)).toEqual({
      'mine.jsonl': transcript(MINE, 'older'),
      'memory/MEMORY.md': 'older memory',
      'memory/notes.md': 'notes'
    })
    expect(warnings).toEqual([
      `Claude already had memory/MEMORY.md, mine.jsonl in ${destination}, so the older copies are still in ${source}. Compare them before deleting the older ones.`
    ])
  })

  it('attributes a session directory left by an interrupted run through the transcript that already arrived', async () => {
    const source = folderOf(MINE)
    const destination = folderOf(MINE_NEW)
    await write(join(destination, 'mine.jsonl'), transcript(MINE))
    await write(join(source, 'mine', 'subagents', 'agent.jsonl'), 'my subagent')
    await write(join(source, 'theirs.jsonl'), transcript(THEIRS))

    await expect(
      run({ moves: [{ from: MINE, to: MINE_NEW }], roots: [root], otherRegisteredPaths: [THEIRS] })
    ).resolves.toEqual([])

    expect(await tree(destination)).toEqual({
      'mine.jsonl': transcript(MINE),
      'mine/subagents/agent.jsonl': 'my subagent'
    })
    expect(await tree(source)).toEqual({ 'theirs.jsonl': transcript(THEIRS) })
  })

  it('reads the working directory of a transcript whose first line is longer than what is read', async () => {
    const source = folderOf(MINE)
    const longLine = (cwd: string): string =>
      `${JSON.stringify({ type: 'user', cwd, message: { content: 'x'.repeat(80_000) } })}\n`
    await write(join(source, 'mine.jsonl'), longLine(MINE))
    await write(join(source, 'theirs.jsonl'), longLine(THEIRS))
    // The first 64 KB hold no `cwd` at all: the session cannot be told apart and stays.
    await write(
      join(source, 'late.jsonl'),
      `${JSON.stringify({ type: 'user', message: { content: 'x'.repeat(80_000) }, cwd: MINE })}\n`
    )

    const warnings = await run({
      moves: [{ from: MINE, to: MINE_NEW }],
      roots: [root],
      otherRegisteredPaths: [THEIRS]
    })

    expect(Object.keys(await tree(folderOf(MINE_NEW)))).toEqual(['mine.jsonl'])
    expect(Object.keys(await tree(source)).sort()).toEqual(['late.jsonl', 'theirs.jsonl'])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('1 Claude session in')
  })

  it('is not fooled by a nested "cwd" that precedes the session\'s own', async () => {
    const source = folderOf(MINE)
    await write(
      join(source, 'theirs.jsonl'),
      `${JSON.stringify({ type: 'attachment', attachment: { cwd: MINE } })}\n${transcript(THEIRS)}`
    )

    await expect(
      run({ moves: [{ from: MINE, to: MINE_NEW }], roots: [root], otherRegisteredPaths: [THEIRS] })
    ).resolves.toEqual([])

    expect(existsSync(folderOf(MINE_NEW))).toBe(false)
    expect(Object.keys(await tree(source))).toEqual(['theirs.jsonl'])
  })

  it('recognises a sharing project that is registered through a link', async () => {
    // The moved project was at <real>/my-app; its neighbour is registered as <link>/my_app,
    // and Claude names folders after the real path.
    const real = join(tmp, 'real')
    const link = join(tmp, 'link')
    await mkdir(join(real, 'my_app'), { recursive: true })
    await symlink(real, link, 'dir')
    const mine = join(real, 'my-app')
    const theirs = join(real, 'my_app')
    const source = folderOf(mine)
    await write(join(source, 'mine.jsonl'), transcript(mine))
    await write(join(source, 'theirs.jsonl'), transcript(theirs))

    await expect(
      run({
        moves: [{ from: mine, to: MINE_NEW }],
        roots: [root],
        otherRegisteredPaths: [join(link, 'my_app')]
      })
    ).resolves.toEqual([])

    expect(await tree(folderOf(MINE_NEW))).toEqual({ 'mine.jsonl': transcript(mine) })
    expect(await tree(source)).toEqual({ 'theirs.jsonl': transcript(theirs) })
  })

  it('takes a neighbour whose folder name differs in letter case only for one that shares it', async () => {
    // On a volume that ignores letter case the two names are one folder.
    const mine = '/dev-old/My-App'
    const theirs = '/dev-old/my_app'
    const source = folderOf(mine)
    await write(join(source, 'mine.jsonl'), transcript(mine))
    await write(join(source, 'theirs.jsonl'), transcript(theirs))

    await expect(
      run({ moves: [{ from: mine, to: MINE_NEW }], roots: [root], otherRegisteredPaths: [theirs] })
    ).resolves.toEqual([])

    expect(await tree(folderOf(MINE_NEW))).toEqual({ 'mine.jsonl': transcript(mine) })
    expect(await tree(source)).toEqual({ 'theirs.jsonl': transcript(theirs) })
  })

  it('does not count the moved path itself as a project that shares the folder', async () => {
    const source = folderOf(MINE)
    await write(join(source, 'mine.jsonl'), transcript(MINE))
    await write(join(source, 'unknown.jsonl'), transcript(null))

    await expect(
      run({ moves: [{ from: MINE, to: MINE_NEW }], roots: [root], otherRegisteredPaths: [MINE] })
    ).resolves.toEqual([])

    expect(existsSync(source)).toBe(false)
    expect(Object.keys(await tree(folderOf(MINE_NEW))).sort()).toEqual([
      'mine.jsonl',
      'unknown.jsonl'
    ])
  })

  it('takes the neighbour along once it moves too, and then removes the old folder', async () => {
    const theirsNew = '/dev-new/my_app'
    const source = folderOf(MINE)
    await write(join(source, 'mine.jsonl'), transcript(MINE))
    await write(join(source, 'theirs.jsonl'), transcript(THEIRS))
    await write(join(source, 'memory', 'MEMORY.md'), 'memory of both')

    // First the one project: its neighbour is still registered at the old place.
    await expect(
      run({ moves: [{ from: MINE, to: MINE_NEW }], roots: [root], otherRegisteredPaths: [THEIRS] })
    ).resolves.toEqual([])
    // Then the neighbour: nothing shares the old folder any more.
    await expect(
      run({
        moves: [{ from: THEIRS, to: theirsNew }],
        roots: [root],
        otherRegisteredPaths: [MINE_NEW]
      })
    ).resolves.toEqual([])

    expect(await tree(root)).toEqual({
      [`${encodePath(MINE_NEW)}/mine.jsonl`]: transcript(MINE),
      [`${encodePath(MINE_NEW)}/theirs.jsonl`]: transcript(THEIRS),
      [`${encodePath(MINE_NEW)}/memory/MEMORY.md`]: 'memory of both'
    })
  })

  it('splits a folder between two moved directories that went to different names', async () => {
    const source = folderOf('/dev-old/a-b')
    await write(join(source, 'first.jsonl'), transcript('/dev-old/a-b'))
    await write(join(source, 'second.jsonl'), transcript('/dev-old/a_b'))
    await write(join(source, 'memory', 'MEMORY.md'), 'memory of both')

    await expect(
      run({
        moves: [
          { from: '/dev-old/a-b', to: '/dev-new/first' },
          { from: '/dev-old/a_b', to: '/dev-new/second' }
        ],
        roots: [root],
        otherRegisteredPaths: []
      })
    ).resolves.toEqual([])

    expect(await tree(folderOf('/dev-new/first'))).toEqual({
      'first.jsonl': transcript('/dev-old/a-b'),
      'memory/MEMORY.md': 'memory of both'
    })
    expect(await tree(folderOf('/dev-new/second'))).toEqual({
      'second.jsonl': transcript('/dev-old/a_b'),
      'memory/MEMORY.md': 'memory of both'
    })
  })
})

describe('moveClaudeTranscripts: roots', () => {
  it('moves the folder in every root, skips a root that is missing, and takes a root once', async () => {
    const second = join(tmp, 'custom-config', 'projects')
    const missing = join(tmp, 'nowhere', 'projects')
    await write(join(folderOf(OLD, root), 'a.jsonl'), transcript(OLD, 'first root'))
    await write(join(folderOf(OLD, second), 'b.jsonl'), transcript(OLD, 'second root'))

    await expect(
      run({
        moves: [{ from: OLD, to: NEW }],
        roots: [root, missing, second, `${root}${sep}`],
        otherRegisteredPaths: []
      })
    ).resolves.toEqual([])

    expect(await tree(root)).toEqual({
      [`${encodePath(NEW)}/a.jsonl`]: transcript(OLD, 'first root')
    })
    expect(await tree(second)).toEqual({
      [`${encodePath(NEW)}/b.jsonl`]: transcript(OLD, 'second root')
    })
    expect(existsSync(missing)).toBe(false)
  })

  it('has no default root: with none given, nothing is moved anywhere', async () => {
    // Even the folder a default would resolve to is a temp one here.
    const home = join(tmp, 'home')
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    vi.stubEnv('CLAUDE_CONFIG_DIR', '')
    const fallback = join(home, '.claude', 'projects')
    expect(claudeProjectRoots({}, home)).toEqual([fallback])
    await write(join(folderOf(OLD, fallback), 'a.jsonl'), transcript(OLD))
    const before = await tree(fallback)

    await expect(
      moveClaudeTranscripts({
        moves: [{ from: OLD, to: NEW }],
        roots: [],
        otherRegisteredPaths: []
      })
    ).resolves.toEqual([])

    expect(await tree(fallback)).toEqual(before)
  })
})

describe('moveClaudeTranscripts: a path too long for its folder name to be known', () => {
  const longOld = `/dev-old/${'a'.repeat(210)}`
  const longNew = `/dev-new/${'b'.repeat(210)}`

  it('warns instead of guessing when the old path is too long', async () => {
    expect(encodePath(longOld).length).toBeGreaterThan(200)
    // Claude's own name: the first 200 characters and a hash the app cannot reproduce.
    const claudeFolder = join(root, `${encodePath(longOld).slice(0, 200)}-x7k2p`)
    await write(join(claudeFolder, 'a.jsonl'), transcript(longOld))
    // The name the app would guess is not trusted either.
    await write(join(folderOf(longOld), 'b.jsonl'), transcript(longOld))
    const before = await tree(root)

    await expect(
      run({ moves: [{ from: longOld, to: NEW }], roots: [root], otherRegisteredPaths: [] })
    ).resolves.toEqual([
      `Claude's history for ${longOld} was left where it is: the path is too long for the app to tell which folder under ${root} holds it. Sessions started there before the move will not resume in the new place.`
    ])

    expect(await tree(root)).toEqual(before)
  })

  it('says nothing when no folder could be the one of a too long old path', async () => {
    await write(join(folderOf('/dev-old/other'), 'a.jsonl'), transcript('/dev-old/other'))

    await expect(
      run({ moves: [{ from: longOld, to: NEW }], roots: [root], otherRegisteredPaths: [] })
    ).resolves.toEqual([])
  })

  it('warns instead of guessing when the new path is too long', async () => {
    const source = folderOf(OLD)
    await write(join(source, 'a.jsonl'), transcript(OLD))
    const before = await tree(root)

    await expect(
      run({ moves: [{ from: OLD, to: longNew }], roots: [root], otherRegisteredPaths: [] })
    ).resolves.toEqual([
      `Claude's history for ${OLD} was left in ${source}: ${longNew} is too long a path for the app to work out the folder name Claude will use for it. Sessions started before the move will not resume in the new place.`
    ])

    expect(await tree(root)).toEqual(before)
  })
})

describe('moveClaudeTranscripts: another volume and failures', () => {
  const otherVolume: ClaudeStateFileOps = {
    rename: async () => {
      throw errorWithCode('EXDEV')
    }
  }

  it('copies and removes entry by entry when a rename crosses volumes', async () => {
    const source = folderOf(OLD)
    await write(join(source, 'a.jsonl'), transcript(OLD))
    await write(join(source, 'a', 'subagents', 'agent.jsonl'), 'subagent')
    await write(join(source, 'memory', 'MEMORY.md'), 'memory')
    const before = await tree(source)
    const input = { moves: [{ from: OLD, to: NEW }], roots: [root], otherRegisteredPaths: [] }

    await expect(run(input, otherVolume)).resolves.toEqual([])

    expect(existsSync(source)).toBe(false)
    expect(await tree(folderOf(NEW))).toEqual(before)
    // Nothing is left under the hidden name a copy is made under.
    expect((await readdir(folderOf(NEW))).sort()).toEqual(['a', 'a.jsonl', 'memory'])

    await expect(run(input, otherVolume)).resolves.toEqual([])
    expect(await tree(folderOf(NEW))).toEqual(before)
  })

  it('does not overwrite across volumes either', async () => {
    const source = folderOf(OLD)
    const destination = folderOf(NEW)
    await write(join(source, 'a.jsonl'), transcript(OLD, 'older'))
    await write(join(source, 'b.jsonl'), transcript(OLD))
    await write(join(destination, 'a.jsonl'), transcript(NEW, 'newer'))

    const warnings = await run(
      { moves: [{ from: OLD, to: NEW }], roots: [root], otherRegisteredPaths: [] },
      otherVolume
    )

    expect(await tree(destination)).toEqual({
      'a.jsonl': transcript(NEW, 'newer'),
      'b.jsonl': transcript(OLD)
    })
    expect(await tree(source)).toEqual({ 'a.jsonl': transcript(OLD, 'older') })
    expect(warnings).toEqual([
      `Claude already had a.jsonl in ${destination}, so the older copy is still in ${source}. Compare them before deleting the older ones.`
    ])
  })

  it('replaces what an interrupted copy left under its hidden name', async () => {
    const source = folderOf(OLD)
    const destination = folderOf(NEW)
    await write(join(source, 'a.jsonl'), transcript(OLD, 'whole'))
    await write(join(destination, '.a.jsonl.hive-moving'), 'half a copy')

    await expect(
      run({ moves: [{ from: OLD, to: NEW }], roots: [root], otherRegisteredPaths: [] }, otherVolume)
    ).resolves.toEqual([])

    expect(await tree(root)).toEqual({
      [`${encodePath(NEW)}/a.jsonl`]: transcript(OLD, 'whole')
    })
  })

  it('merges entry by entry when the destination appears during the rename', async () => {
    const source = folderOf(OLD)
    const destination = folderOf(NEW)
    await write(join(source, 'a.jsonl'), transcript(OLD))
    let calls = 0
    const ops: ClaudeStateFileOps = {
      rename: async (from, to) => {
        calls += 1
        if (calls === 1) {
          // Claude starts a session in the new place at this very moment.
          await write(join(destination, 'live.jsonl'), transcript(NEW))
          throw errorWithCode('ENOTEMPTY')
        }
        await renameOnDisk(from, to)
      }
    }

    await expect(
      run({ moves: [{ from: OLD, to: NEW }], roots: [root], otherRegisteredPaths: [] }, ops)
    ).resolves.toEqual([])

    expect(await tree(root)).toEqual({
      [`${encodePath(NEW)}/a.jsonl`]: transcript(OLD),
      [`${encodePath(NEW)}/live.jsonl`]: transcript(NEW)
    })
  })

  it('resolves with a sentence when the folder cannot be renamed', async () => {
    const source = folderOf(OLD)
    await write(join(source, 'a.jsonl'), transcript(OLD))
    const before = await tree(root)

    const warnings = await run(
      { moves: [{ from: OLD, to: NEW }], roots: [root], otherRegisteredPaths: [] },
      {
        rename: async () => {
          throw errorWithCode('EACCES')
        }
      }
    )

    expect(warnings).toEqual([
      `Claude's history for ${OLD} could not be moved under ${root}: EACCES: simulated`
    ])
    expect(await tree(root)).toEqual(before)
  })

  it('names the entries that could not be moved and moves the rest', async () => {
    const source = folderOf(OLD)
    const destination = folderOf(NEW)
    await write(join(source, 'a.jsonl'), transcript(OLD, 'a'))
    await write(join(source, 'b.jsonl'), transcript(OLD, 'b'))
    await mkdir(destination, { recursive: true })
    const ops: ClaudeStateFileOps = {
      rename: async (from, to) => {
        if (from.endsWith('a.jsonl')) throw errorWithCode('EPERM')
        await renameOnDisk(from, to)
      }
    }

    const warnings = await run(
      { moves: [{ from: OLD, to: NEW }], roots: [root], otherRegisteredPaths: [] },
      ops
    )

    expect(await tree(destination)).toEqual({ 'b.jsonl': transcript(OLD, 'b') })
    expect(await tree(source)).toEqual({ 'a.jsonl': transcript(OLD, 'a') })
    expect(warnings).toEqual([
      `Some of Claude's history for ${OLD} could not be moved to ${destination} and is still in ${source}: a.jsonl (EPERM: simulated).`
    ])
  })

  it('never rejects, whatever it is given', async () => {
    await expect(
      moveClaudeTranscripts({
        moves: null as unknown as MoveClaudeTranscriptsInput['moves'],
        roots: [root],
        otherRegisteredPaths: []
      })
    ).resolves.toEqual([expect.stringContaining("Claude's session history could not be moved")])
  })
})

describe('claudeProjectRoots', () => {
  let home: string

  beforeEach(() => {
    // `resolveProjectsDir` reads this process's environment and home directory: both are
    // pointed into the temp directory, so no root can name the developer's own folders.
    home = join(tmp, 'home')
    expect(home).not.toBe(userInfo().homedir)
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    vi.stubEnv('CLAUDE_CONFIG_DIR', '')
  })

  it('starts with the folder the app reads transcripts from', () => {
    // Kept in step with `resolveProjectsDir`, which takes no home directory of its own.
    expect(homedir()).toBe(home)
    expect(claudeProjectRoots({}, homedir())[0]).toBe(resolve(resolveProjectsDir()))

    vi.stubEnv('CLAUDE_CONFIG_DIR', join(tmp, 'caf\u0065\u0301-config'))
    expect(claudeProjectRoots({}, homedir())[0]).toBe(resolve(resolveProjectsDir()))
    expect(claudeProjectRoots({}, homedir())[0]).toBe(join(tmp, 'caf\u00e9-config', 'projects'))
  })

  it('takes the home directory it is given, not the real one', () => {
    const other = join(tmp, 'another-home')

    expect(claudeProjectRoots({}, other)).toEqual([join(other, '.claude', 'projects')])
  })

  it('is the default folder once when nothing is configured', () => {
    expect(claudeProjectRoots({}, home)).toEqual([join(home, '.claude', 'projects')])
    expect(claudeProjectRoots({ CLAUDE_CONFIG_DIR: '  ' }, home)).toEqual([
      join(home, '.claude', 'projects')
    ])
  })

  it('adds the folder of a CLAUDE_CONFIG_DIR set in Settings to the one this process reads', () => {
    const custom = join(tmp, 'custom-config')

    expect(claudeProjectRoots({ CLAUDE_CONFIG_DIR: custom }, home)).toEqual([
      join(home, '.claude', 'projects'),
      join(custom, 'projects')
    ])
  })

  it('is one folder when the process and the spawned CLI use the same CLAUDE_CONFIG_DIR', () => {
    const custom = join(tmp, 'custom-config')
    vi.stubEnv('CLAUDE_CONFIG_DIR', custom)

    expect(claudeProjectRoots({ ...process.env }, home)).toEqual([join(custom, 'projects')])
    expect(claudeProjectRoots({ CLAUDE_CONFIG_DIR: `${custom}${sep}` }, home)).toEqual([
      join(custom, 'projects')
    ])
  })

  it('lists the process folder first, then the one the Settings variable overrides it with', () => {
    const processDir = join(tmp, 'process-config')
    const settingsDir = join(tmp, 'settings-config')
    vi.stubEnv('CLAUDE_CONFIG_DIR', processDir)

    const roots = claudeProjectRoots({ ...process.env, CLAUDE_CONFIG_DIR: settingsDir }, home)

    expect(roots).toEqual([join(processDir, 'projects'), join(settingsDir, 'projects')])
    for (const entry of roots) expect(entry.startsWith(tmp + sep)).toBe(true)
  })
})
