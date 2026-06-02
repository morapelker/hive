import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

describe('scriptOps.killPid IPC cleanup', () => {
  it('keeps PID termination on the scriptOps RPC route instead of legacy IPC', () => {
    const root = process.cwd()
    const preloadSource = fs.readFileSync(path.join(root, 'src/preload/index.ts'), 'utf-8')
    const rpcSource = fs.readFileSync(
      path.join(root, 'src/server/rpc/domains/script-ops.ts'),
      'utf-8'
    )

    expect(fs.existsSync(path.join(root, 'src/main/ipc/script-handlers.ts'))).toBe(false)
    expect(
      fs.existsSync(path.join(root, 'src/main/ipc/__tests__/script-handlers.killPid.test.ts'))
    ).toBe(false)
    expect(preloadSource).not.toContain("'script:killPid'")
    expect(rpcSource).toContain("'scriptOps.killPid'")
    expect(rpcSource).toContain('killPidParamsSchema.parse(params)')
  })
})
