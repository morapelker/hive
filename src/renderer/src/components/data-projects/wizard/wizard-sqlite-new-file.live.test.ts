// @vitest-environment node
// SQLite "New file…" end to end against the real engine and SQLite driver: the wizard's test
// config creates the empty database at a path where nothing exists, the saved config (no create
// switch) then connects to it, and a typed path that does not exist still fails clearly.
// Needs better-sqlite3 for this runtime: TEDOOO_DP_IT=1 and the Electron runner.

import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type {
  DataConnectionConfig,
  DataTestConnectionInput,
  DataTestConnectionResult
} from '@shared/data-projects/types'
import { BUILTIN_DATA_PROJECT_DEFAULTS } from '@/stores/useDataProjectStore'
import { emptyForm, formToConfig, testConfig, testSecrets, type WizardForm } from './wizard-model'

const sqliteAvailable = (() => {
  try {
    const Database = createRequire(import.meta.url)('better-sqlite3')
    new Database(':memory:').close()
    return true
  } catch {
    return false
  }
})()
const describeLive = process.env.TEDOOO_DP_IT && sqliteAvailable ? describe : describe.skip

/** Main-process modules, loaded at run time only: the renderer's tsconfig does not cover them. */
const MAIN = '../../../../../main/services/data-projects'
const loadMain = async <T>(path: string): Promise<T> =>
  (await import(/* @vite-ignore */ `${MAIN}/${path}`)) as T

interface LiveDriver {
  connect(): Promise<unknown>
  listObjects(): Promise<{ objects: unknown[] }>
  close(): Promise<void>
}
type CreateSqliteDriver = (input: object, options: { mode: 'in-process' }) => LiveDriver

const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), 'tmp_fix_e_wizard-')))
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }))

describeLive('SQLite "New file…" (live)', () => {
  let runTest: (form: WizardForm) => Promise<DataTestConnectionResult>
  let openSaved: (config: DataConnectionConfig) => LiveDriver

  beforeAll(async () => {
    const [engineModule, gateModule, managerModule, sqliteModule, fixtures] = await Promise.all([
      loadMain<{
        createDataEngineService: (deps: object) => {
          testConnection: (input: DataTestConnectionInput) => Promise<DataTestConnectionResult>
        }
      }>('engine-service'),
      loadMain<{ createSafetyGate: () => object }>('safety-gate'),
      loadMain<{ noopLogger: object }>('connection-manager'),
      loadMain<{ createSqliteDriver: CreateSqliteDriver }>('drivers/sqlite'),
      loadMain<{
        MemoryRepository: new (records: unknown[]) => object
        MemorySecrets: new () => object
        makeRecord: (overrides: object) => object
      }>('__tests__/engine-fixtures')
    ])
    const { createSqliteDriver } = sqliteModule
    const engine = engineModule.createDataEngineService({
      repository: new fixtures.MemoryRepository([]),
      secrets: new fixtures.MemorySecrets(),
      gate: gateModule.createSafetyGate(),
      logger: managerModule.noopLogger,
      createDriver: (input: object) => createSqliteDriver(input, { mode: 'in-process' })
    })
    runTest = (form) =>
      engine.testConnection({
        engine: 'sqlite',
        config: testConfig(form),
        secrets: testSecrets(form)
      })
    openSaved = (config) =>
      createSqliteDriver(
        {
          project: fixtures.makeRecord({ engine: 'sqlite', config }),
          secrets: {},
          redact: (text: string) => text
        },
        { mode: 'in-process' }
      )
  })

  it('the Test step creates the file and the saved connection opens it', async () => {
    const path = join(tmpRoot, 'tmp_fix_e_new.sqlite')
    const form: WizardForm = {
      ...emptyForm('sqlite', BUILTIN_DATA_PROJECT_DEFAULTS),
      filePath: path,
      createFile: true
    }
    expect(existsSync(path)).toBe(false)

    const result = await runTest(form)
    expect(result).toMatchObject({ ok: true })
    expect(result.serverVersion).toMatch(/\d+\.\d+/)
    expect(existsSync(path)).toBe(true)

    // What is saved has no create switch, and still connects (the file exists now).
    const saved = formToConfig(form)
    expect(saved.options).toBeUndefined()
    const driver = openSaved(saved)
    try {
      await driver.connect()
      expect((await driver.listObjects()).objects).toEqual([])
    } finally {
      await driver.close()
    }
  })

  it('a typed path that does not exist is reported, never created', async () => {
    const path = join(tmpRoot, 'tmp_fix_e_missing.sqlite')
    const result = await runTest({
      ...emptyForm('sqlite', BUILTIN_DATA_PROJECT_DEFAULTS),
      filePath: path
    })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/not found/i)
    expect(existsSync(path)).toBe(false)
  })
})
