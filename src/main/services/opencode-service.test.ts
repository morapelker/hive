import { describe, expect, it, vi } from 'vitest'
import { resolveOpenCodeLaunchSpecIfNeeded } from './opencode-service'
import type { OpenCodeLaunchSpec } from './opencode-binary-resolver'

describe('resolveOpenCodeLaunchSpecIfNeeded', () => {
  it('keeps an injected launch spec without resolving again', () => {
    const existing: OpenCodeLaunchSpec = { command: '/bin/opencode', shell: false }
    const resolver = vi.fn<[], OpenCodeLaunchSpec | null>(() => ({
      command: '/other/opencode',
      shell: false
    }))

    expect(resolveOpenCodeLaunchSpecIfNeeded(existing, resolver)).toBe(existing)
    expect(resolver).not.toHaveBeenCalled()
  })

  it('resolves lazily when no launch spec has been injected', () => {
    const resolved: OpenCodeLaunchSpec = { command: '/opt/homebrew/bin/opencode', shell: false }
    const resolver = vi.fn<[], OpenCodeLaunchSpec | null>(() => resolved)

    expect(resolveOpenCodeLaunchSpecIfNeeded(null, resolver)).toBe(resolved)
    expect(resolver).toHaveBeenCalledOnce()
  })
})
