// The port registry is one file in the home directory, and the module fixes its path when it
// is imported. Every test therefore points HOME at a temp directory first and imports the
// module afresh; the file calls the module makes are recorded, and a test fails when one of
// them names anything but the registry in that temp directory.
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { homedir, tmpdir, userInfo } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fileCalls = vi.hoisted(() => ({ paths: [] as string[] }))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: (path: string) => {
      fileCalls.paths.push(path)
      return actual.existsSync(path)
    },
    readFileSync: (path: string, encoding: BufferEncoding) => {
      fileCalls.paths.push(path)
      return actual.readFileSync(path, encoding)
    },
    writeFileSync: (path: string, data: string, encoding: BufferEncoding) => {
      fileCalls.paths.push(path)
      actual.writeFileSync(path, data, encoding)
    }
  }
})

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

type PortRegistry = typeof import('../port-registry')

let home: string
let registryPath: string
let registry: PortRegistry

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'port-registry-test-'))
  registryPath = join(home, '.playwright-mcp-ports.json')
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
  expect(homedir()).toBe(home)
  expect(home).not.toBe(userInfo().homedir)
  fileCalls.paths.length = 0
  vi.resetModules()
  registry = await import('../port-registry')
})

afterEach(async () => {
  // Whatever the module read or wrote was the registry of this test's home directory.
  for (const path of fileCalls.paths) expect(path).toBe(registryPath)
  vi.unstubAllEnvs()
  await rm(home, { recursive: true, force: true })
})

const writeRegistry = (content: Record<string, number>): Promise<void> =>
  writeFile(registryPath, JSON.stringify(content, null, 2) + '\n')

const readRegistry = async (): Promise<unknown> => JSON.parse(await readFile(registryPath, 'utf-8'))

describe('movePort', () => {
  it('gives the port to the new path and drops the old key', async () => {
    await writeRegistry({ '/dev-old/app': 3011, '/dev-old/other': 3012 })

    expect(registry.movePort('/dev-old/app', '/dev-new/app')).toBe(true)

    expect(await readRegistry()).toEqual({ '/dev-old/other': 3012, '/dev-new/app': 3011 })
    expect(registry.getAssignedPort('/dev-new/app')).toBe(3011)
    expect(registry.getAssignedPort('/dev-old/app')).toBeNull()
    expect(fileCalls.paths.length).toBeGreaterThan(0)
  })

  it('keeps the port through the cleanup of the next assignment', async () => {
    // The old folder is gone and the new one is on disk: without the move, the next
    // assignment would drop the old key and hand the new path another port.
    const moved = join(home, 'dev-new', 'app')
    const neighbour = join(home, 'dev-old', 'other')
    await mkdir(moved, { recursive: true })
    await mkdir(neighbour, { recursive: true })
    await writeRegistry({ [join(home, 'dev-old', 'app')]: 3011, [neighbour]: 3012 })

    expect(registry.movePort(join(home, 'dev-old', 'app'), moved)).toBe(true)

    expect(registry.assignPort(moved)).toBe(3011)
    expect(await readRegistry()).toEqual({ [neighbour]: 3012, [moved]: 3011 })
  })

  it('does nothing when the old path has no port', async () => {
    const original = JSON.stringify({ '/dev-old/other': 3012 })
    await writeFile(registryPath, original)

    expect(registry.movePort('/dev-old/app', '/dev-new/app')).toBe(false)

    // Byte equality: the registry was not rewritten.
    expect(await readFile(registryPath, 'utf-8')).toBe(original)
  })

  it('does not create a registry that is missing', async () => {
    expect(registry.movePort('/dev-old/app', '/dev-new/app')).toBe(false)

    await expect(readFile(registryPath, 'utf-8')).rejects.toThrow()
  })

  it('is a no-op for the second spelling of the old path, and the second time', async () => {
    await writeRegistry({ '/link/dev/app': 3011 })

    expect(registry.movePort('/link/dev/app', '/dev-new/app')).toBe(true)
    const afterFirst = await readFile(registryPath, 'utf-8')

    expect(registry.movePort('/real/dev/app', '/dev-new/app')).toBe(false)
    expect(registry.movePort('/link/dev/app', '/dev-new/app')).toBe(false)
    expect(await readFile(registryPath, 'utf-8')).toBe(afterFirst)
  })

  it('leaves the port the new path already has and still drops the old key', async () => {
    await writeRegistry({ '/dev-old/app': 3011, '/dev-new/app': 3020 })

    expect(registry.movePort('/dev-old/app', '/dev-new/app')).toBe(false)

    expect(await readRegistry()).toEqual({ '/dev-new/app': 3020 })
  })

  it('does not hand out a port that another directory holds', async () => {
    await writeRegistry({ '/dev-old/app': 3011, '/elsewhere/twin': 3011 })

    expect(registry.movePort('/dev-old/app', '/dev-new/app')).toBe(false)

    expect(await readRegistry()).toEqual({ '/elsewhere/twin': 3011 })
  })

  it('does nothing when both paths are the same', async () => {
    const original = JSON.stringify({ '/dev-old/app': 3011 })
    await writeFile(registryPath, original)

    expect(registry.movePort('/dev-old/app', '/dev-old/app')).toBe(false)

    expect(await readFile(registryPath, 'utf-8')).toBe(original)
  })

  it('returns false instead of throwing for a registry that is not a map of ports', async () => {
    for (const content of ['null', '{ not json', '[3011]']) {
      await writeFile(registryPath, content)

      expect(registry.movePort('/dev-old/app', '/dev-new/app')).toBe(false)

      expect(await readFile(registryPath, 'utf-8')).toBe(content)
    }
  })

  // The superuser writes a read-only file all the same.
  it.skipIf(process.getuid?.() === 0)(
    'returns false instead of throwing when the registry cannot be written',
    async () => {
      await writeRegistry({ '/dev-old/app': 3011 })
      const original = await readFile(registryPath, 'utf-8')
      await chmod(registryPath, 0o400)

      expect(registry.movePort('/dev-old/app', '/dev-new/app')).toBe(false)

      expect(await readFile(registryPath, 'utf-8')).toBe(original)
    }
  )
})

describe('the port registry around a move', () => {
  it('still assigns, reads and releases ports as before', async () => {
    const first = join(home, 'first')
    const second = join(home, 'second')
    await mkdir(first)
    await mkdir(second)

    expect(registry.assignPort(first)).toBe(3011)
    expect(registry.assignPort(second)).toBe(3012)
    expect(registry.assignPort(first)).toBe(3011)
    expect(registry.getAssignedPort(second)).toBe(3012)

    registry.releasePort(first)

    expect(registry.getAssignedPort(first)).toBeNull()
    expect(await readRegistry()).toEqual({ [second]: 3012 })
  })
})
