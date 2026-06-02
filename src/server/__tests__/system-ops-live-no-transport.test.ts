import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

describe('system ops live service without desktop transport', () => {
  it('no-ops setKeepAwake in the no-desktop-command fallback', () => {
    const source = readFileSync(resolve(__dirname, '../rpc/domains/system-ops.ts'), 'utf-8')
    const fallbackStart = source.indexOf("if (command === 'setKeepAwake')")
    const fallbackEnd = source.indexOf("if (command === 'setSessionQueuedState')", fallbackStart)
    const fallbackSource = source.slice(fallbackStart, fallbackEnd)

    expect(fallbackStart).toBeGreaterThan(-1)
    expect(fallbackEnd).toBeGreaterThan(fallbackStart)
    expect(fallbackSource).toContain("if (!payload) throw new Error('Missing setKeepAwake payload')")
    expect(fallbackSource).toContain('return Promise.resolve(undefined as A)')
    expect(fallbackSource).not.toContain('power-save-blocker')
  })

  it('no-ops setSessionQueuedState in the no-desktop-command fallback', () => {
    const source = readFileSync(resolve(__dirname, '../rpc/domains/system-ops.ts'), 'utf-8')
    const fallbackStart = source.indexOf("if (command === 'setSessionQueuedState')")
    const fallbackEnd = source.indexOf("if (!payload) throw new Error('Missing openInChrome payload')", fallbackStart)
    const fallbackSource = source.slice(fallbackStart, fallbackEnd)

    expect(fallbackStart).toBeGreaterThan(-1)
    expect(fallbackEnd).toBeGreaterThan(fallbackStart)
    expect(fallbackSource).toContain(
      "if (!payload) throw new Error('Missing setSessionQueuedState payload')"
    )
    expect(fallbackSource).toContain('return Promise.resolve(undefined as A)')
    expect(fallbackSource).not.toContain('notification-service')
  })
})
