import { mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The module is loaded here with the real database module behind it (nothing is replaced), in
// a home directory of its own: main-process code and the server child both import it, and
// neither may get a database opened, or a folder created, just for having done so.
describe('loading dev-folder-settings', () => {
  let home: string | null = null

  afterEach(() => {
    vi.unstubAllEnvs()
    if (home) rmSync(home, { recursive: true, force: true })
    home = null
  })

  it('opens no database and creates nothing', async () => {
    home = realpathSync.native(mkdtempSync(join(tmpdir(), 'dev-folder-import-')))
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    // Without these the database would be looked for in `<home>/.hive`, which is what a
    // lookup while loading would have created.
    vi.stubEnv('HIVE_SERVER_DB_PATH', '')
    vi.stubEnv('HIVE_SERVER_BASE_DIR', '')
    vi.stubEnv('HIVE_DESKTOP_BASE_DIR', '')

    const settings = await import('../dev-folder-settings')

    expect(readdirSync(home)).toEqual([])
    expect(settings.defaultDevFolder()).toBe(join(home, 'hive-projects'))
    expect(settings.expandHomeDir('~/Dev')).toBe(join(home, 'Dev'))
    expect(readdirSync(home)).toEqual([])
  })
})
