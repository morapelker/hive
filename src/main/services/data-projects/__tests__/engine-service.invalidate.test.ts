// A data project whose stored config was changed from outside the `dataProjects.*` domain: a
// project folder moved, and the SQLite file in it has a new path. An open connection keeps the
// file it was opened with, so it has to be closed before the next use reads the config again.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const doubles = vi.hoisted(() => ({
  repository: null as unknown,
  secrets: null as unknown,
  getDatabase: vi.fn(),
  drivers: [] as unknown[]
}))

// What the process-wide engine loads on first use: the app database, the secrets vault and
// the real drivers. Each is replaced by the in-memory fixtures of the engine tests.
vi.mock('../../../db/database', () => ({ getDatabase: doubles.getDatabase }))
vi.mock('../secrets', () => ({ getDataSecretsStore: () => doubles.secrets }))
vi.mock('../drivers', async () => {
  const { FakeDriver } = await import('./engine-fixtures')
  return {
    createDriver: (input: ConstructorParameters<typeof FakeDriver>[0]) => {
      const driver = new FakeDriver(input)
      doubles.drivers.push(driver)
      return driver
    }
  }
})
// The engine's log goes to the app's log directory.
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

import {
  DATA_STATUS_CHANNEL,
  type DataConnectionStatus
} from '../../../../shared/data-projects/types'
import { ConnectionManager, noopLogger } from '../connection-manager'
import {
  getDataEngineService,
  invalidateDataEngineIfLoaded,
  resetDataEngineServiceForTests,
  setDataEnginePublisher
} from '../engine-service'
import { FakeDriver, MemoryRepository, MemorySecrets, makeRecord } from './engine-fixtures'

const OLD_FILE = '/old/app/data/shop.sqlite'
const NEW_FILE = '/dev/app/data/shop.sqlite'

const sqliteRecord = (filePath: string): ReturnType<typeof makeRecord> =>
  makeRecord({ id: 'dp-1', engine: 'sqlite', config: { filePath } })

const fileOf = (driver: FakeDriver): string | undefined => driver.input.project.config.filePath

describe('ConnectionManager, when the stored config changes under an open connection', () => {
  it('goes on with the connection it has, and opens the new file once it is invalidated', async () => {
    const repository = new MemoryRepository([sqliteRecord(OLD_FILE)])
    const drivers: FakeDriver[] = []
    const manager = new ConnectionManager({
      getRecord: (id) => repository.getDataProject(id)!,
      secrets: new MemorySecrets(),
      createDriver: (input) => {
        const driver = new FakeDriver(input)
        drivers.push(driver)
        return driver
      },
      publish: () => undefined,
      logger: noopLogger
    })
    try {
      const first = await manager.getDriver('dp-1')
      expect(fileOf(drivers[0])).toBe(OLD_FILE)

      repository.updateDataProject('dp-1', { config: { filePath: NEW_FILE } })
      // The config is not looked at again while a connection is open.
      expect(await manager.getDriver('dp-1')).toBe(first)
      expect(drivers).toHaveLength(1)

      await manager.invalidate('dp-1')
      expect(drivers[0].closes).toBe(1)

      const second = await manager.getDriver('dp-1')
      expect(second).not.toBe(first)
      expect(drivers).toHaveLength(2)
      expect(fileOf(drivers[1])).toBe(NEW_FILE)
    } finally {
      await manager.closeAll()
    }
  })
})

describe('invalidateDataEngineIfLoaded', () => {
  let repository: MemoryRepository
  const events: { channel: string; payload: unknown }[] = []
  const drivers = (): FakeDriver[] => doubles.drivers as FakeDriver[]

  beforeEach(() => {
    repository = new MemoryRepository([sqliteRecord(OLD_FILE)])
    doubles.repository = repository
    doubles.secrets = new MemorySecrets()
    doubles.getDatabase.mockReset()
    doubles.getDatabase.mockImplementation(() => doubles.repository)
    doubles.drivers.length = 0
    events.length = 0
  })

  afterEach(async () => {
    await resetDataEngineServiceForTests()
  })

  it('does nothing, and makes no engine, in a process that has not used one', async () => {
    await expect(invalidateDataEngineIfLoaded('dp-1')).resolves.toBeUndefined()

    expect(doubles.getDatabase).not.toHaveBeenCalled()
    expect(drivers()).toEqual([])
  })

  it('closes the open connection, so the next use opens the file the config names now', async () => {
    const engine = getDataEngineService()
    setDataEnginePublisher((channel, payload) => events.push({ channel, payload }))
    await engine.connect('dp-1')
    expect(drivers().map(fileOf)).toEqual([OLD_FILE])

    repository.updateDataProject('dp-1', { config: { filePath: NEW_FILE } })
    // Until it is closed, the engine goes on with the connection to the old file.
    await engine.databases('dp-1')
    expect(drivers()).toHaveLength(1)
    expect(drivers()[0].closes).toBe(0)
    events.length = 0

    await invalidateDataEngineIfLoaded('dp-1')

    expect(drivers()[0].closes).toBe(1)
    expect(engine.status('dp-1').state).toBe('disconnected')
    // Every window learns that the connection is closed.
    expect(events).toContainEqual({
      channel: DATA_STATUS_CHANNEL,
      payload: { dataProjectId: 'dp-1', state: 'disconnected' } satisfies DataConnectionStatus
    })

    await engine.databases('dp-1')
    expect(drivers().map(fileOf)).toEqual([OLD_FILE, NEW_FILE])
    expect(drivers()[1].isConnected()).toBe(true)
  })

  it('leaves the connections of other data projects open', async () => {
    repository.records.set(
      'dp-2',
      makeRecord({ id: 'dp-2', engine: 'sqlite', config: { filePath: '/elsewhere/b.sqlite' } })
    )
    const engine = getDataEngineService()
    await engine.connect('dp-1')
    await engine.connect('dp-2')

    await invalidateDataEngineIfLoaded('dp-1')

    const [first, second] = drivers()
    expect(first.closes).toBe(1)
    expect(second.closes).toBe(0)
    expect(second.isConnected()).toBe(true)
  })

  it('is harmless for a data project that has no connection', async () => {
    getDataEngineService()

    await expect(invalidateDataEngineIfLoaded('dp-1')).resolves.toBeUndefined()
    await expect(invalidateDataEngineIfLoaded('no-such-project')).resolves.toBeUndefined()

    expect(drivers()).toEqual([])
  })
})
