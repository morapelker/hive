import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { makeLiveProjectOpsRpcService } from '../rpc/domains/project-ops'

// The live service is the one the app actually calls. It used to carry its own copy
// of this validation, which meant the canonicalization in main/services never ran.
describe('live projectOps.validateProject', () => {
  let base: string

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'hive-rpc-validate-')))
    mkdirSync(join(base, 'repo', '.git'), { recursive: true })
  })

  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  it('returns a canonical path', async () => {
    const service = makeLiveProjectOpsRpcService()

    const result = await Effect.runPromise(
      service.validateProject(join(base, 'repo', '..', 'repo') + '/')
    )

    expect(result).toEqual({ success: true, path: join(base, 'repo'), name: 'repo' })
  })

  it('still reports a folder that is not a git repository', async () => {
    mkdirSync(join(base, 'plain'))
    const service = makeLiveProjectOpsRpcService()

    const result = await Effect.runPromise(service.validateProject(join(base, 'plain')))

    expect(result).toMatchObject({ success: false })
  })
})
