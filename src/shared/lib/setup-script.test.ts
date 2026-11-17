import { describe, expect, it } from 'vitest'
import {
  inheritsDefaultSetupScript,
  readDefaultSetupScript,
  resolveSetupScript
} from './setup-script'

describe('resolveSetupScript', () => {
  it('uses the default when the project never had a setup script', () => {
    expect(resolveSetupScript(null, 'pnpm install')).toBe('pnpm install')
    expect(resolveSetupScript(undefined, 'pnpm install')).toBe('pnpm install')
  })

  it("uses the project's own script over the default", () => {
    expect(resolveSetupScript('bun install', 'pnpm install')).toBe('bun install')
  })

  it('runs nothing for a project whose script was cleared, default or not', () => {
    expect(resolveSetupScript('', 'pnpm install')).toBeNull()
    expect(resolveSetupScript('  \n', 'pnpm install')).toBeNull()
  })

  it('runs nothing when neither is set', () => {
    expect(resolveSetupScript(null, '')).toBeNull()
    expect(resolveSetupScript(null, '   ')).toBeNull()
    expect(resolveSetupScript(null, null)).toBeNull()
    expect(resolveSetupScript(undefined, undefined)).toBeNull()
  })
})

describe('inheritsDefaultSetupScript', () => {
  it('is true only for a script that was never set', () => {
    expect(inheritsDefaultSetupScript(null)).toBe(true)
    expect(inheritsDefaultSetupScript(undefined)).toBe(true)
    expect(inheritsDefaultSetupScript('')).toBe(false)
    expect(inheritsDefaultSetupScript('pnpm install')).toBe(false)
  })
})

describe('readDefaultSetupScript', () => {
  it('reads the default out of the app settings blob', () => {
    expect(readDefaultSetupScript(JSON.stringify({ defaultSetupScript: 'pnpm install' }))).toBe(
      'pnpm install'
    )
  })

  it('is null for a missing, blank, malformed or wrongly typed value', () => {
    expect(readDefaultSetupScript(null)).toBeNull()
    expect(readDefaultSetupScript('')).toBeNull()
    expect(readDefaultSetupScript('{not json')).toBeNull()
    expect(readDefaultSetupScript('null')).toBeNull()
    expect(readDefaultSetupScript(JSON.stringify({}))).toBeNull()
    expect(readDefaultSetupScript(JSON.stringify({ defaultSetupScript: '  ' }))).toBeNull()
    expect(readDefaultSetupScript(JSON.stringify({ defaultSetupScript: 42 }))).toBeNull()
  })
})
