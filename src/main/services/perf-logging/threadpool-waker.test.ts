// @vitest-environment node
import { existsSync } from 'fs'
import { stat } from 'fs/promises'
import { join, resolve } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  __resetThreadpoolWakerForTests,
  shouldWakeAtMiss,
  threadpoolWakerCandidatePaths,
  wakeThreadpoolWorkers
} from './threadpool-waker'

afterEach(() => __resetThreadpoolWakerForTests())

describe('threadpoolWakerCandidatePaths', () => {
  it('looks in the packaged resources first, then next to the source from either out/main', () => {
    const repo = resolve('/repo/apps')
    const paths = threadpoolWakerCandidatePaths('/App/Resources', join(repo, 'shell/out/main/chunks'))
    const devBuild = join('hive/src/native/uv-pool-waker/build/uv-pool-waker.node')
    expect(paths[0]).toBe(join('/App/Resources', 'native', 'uv-pool-waker.node'))
    expect(paths).toContain(join(repo, devBuild))
  })
})

describe('wakeThreadpoolWorkers without the addon', () => {
  it('reports why instead of throwing', () => {
    __resetThreadpoolWakerForTests(join(__dirname, 'missing.node'))
    expect(wakeThreadpoolWorkers()).toMatchObject({ found: 0, signalled: 0 })
    expect(wakeThreadpoolWorkers().error).toBeDefined()
  })
})

describe('shouldWakeAtMiss', () => {
  it('never wakes before the stall is declared', () => {
    expect(shouldWakeAtMiss(1, 2)).toBe(false)
    expect(shouldWakeAtMiss(2, 2)).toBe(true)
  })
})

const addonPath = resolve(__dirname, '../../../native/uv-pool-waker/build/uv-pool-waker.node')
const addonBuilt = existsSync(addonPath)

describe.skipIf(process.platform !== 'darwin' || !addonBuilt)('wakeThreadpoolWorkers (macOS)', () => {
  it('signals every pool worker of this process, and the pool keeps working', async () => {
    __resetThreadpoolWakerForTests(addonPath)
    await stat(__dirname) // make sure the pool's threads exist
    const result = wakeThreadpoolWorkers()
    expect(result.error).toBeUndefined()
    expect(result.found).toBeGreaterThan(0)
    expect(result.signalled).toBe(result.found)
    await Promise.all(Array.from({ length: 50 }, () => stat(__dirname)))
  })
})
