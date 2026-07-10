import { describe, expect, it } from 'vitest'

import { parseSetupScriptPlan, type SetupPlanEntry } from '../setup-script-transfers'

describe('parseSetupScriptPlan', () => {
  it('returns no entries for null/undefined/empty scripts', () => {
    expect(parseSetupScriptPlan(null)).toEqual({ entries: [] })
    expect(parseSetupScriptPlan(undefined)).toEqual({ entries: [] })
    expect(parseSetupScriptPlan('')).toEqual({ entries: [] })
    expect(parseSetupScriptPlan('   \n  \n')).toEqual({ entries: [] })
  })

  it('drops comments and blank lines', () => {
    const script = ['# a comment', '', 'pnpm install', '   ', '# another comment'].join('\n')

    expect(parseSetupScriptPlan(script).entries).toEqual([
      { kind: 'command', line: 'pnpm install' }
    ])
  })

  it('passes plain commands through verbatim', () => {
    expect(parseSetupScriptPlan('pnpm install').entries).toEqual([
      { kind: 'command', line: 'pnpm install' }
    ])
  })

  it('trims surrounding whitespace on each line', () => {
    expect(parseSetupScriptPlan('   pnpm install   ').entries).toEqual([
      { kind: 'command', line: 'pnpm install' }
    ])
  })

  it('classifies "cp /abs/file ." as a transfer-candidate, normalizing dest to the source basename', () => {
    const line = 'cp /abs/file .'
    expect(parseSetupScriptPlan(line).entries).toEqual([
      { kind: 'transfer-candidate', sourcePath: '/abs/file', dest: 'file', line }
    ])
  })

  it('normalizes a trailing-slash dest to include the source basename', () => {
    const line = 'cp /abs/.env config/'
    expect(parseSetupScriptPlan(line).entries).toEqual([
      { kind: 'transfer-candidate', sourcePath: '/abs/.env', dest: 'config/.env', line }
    ])
  })

  it('normalizes a "./" dest to the source basename', () => {
    const line = 'cp /abs/.env ./'
    expect(parseSetupScriptPlan(line).entries).toEqual([
      { kind: 'transfer-candidate', sourcePath: '/abs/.env', dest: '.env', line }
    ])
  })

  it('classifies "cp /abs/file sub/dir/file.txt" as a transfer-candidate', () => {
    const line = 'cp /abs/file sub/dir/file.txt'
    expect(parseSetupScriptPlan(line).entries).toEqual([
      { kind: 'transfer-candidate', sourcePath: '/abs/file', dest: 'sub/dir/file.txt', line }
    ])
  })

  it('handles quoted paths with spaces', () => {
    const line = 'cp "/a b/c.env" .'
    expect(parseSetupScriptPlan(line).entries).toEqual([
      { kind: 'transfer-candidate', sourcePath: '/a b/c.env', dest: 'c.env', line }
    ])
  })

  it('handles single-quoted paths with spaces', () => {
    const line = "cp '/a b/c.env' sub"
    expect(parseSetupScriptPlan(line).entries).toEqual([
      { kind: 'transfer-candidate', sourcePath: '/a b/c.env', dest: 'sub', line }
    ])
  })

  it('errors on cp with a flag like -r (directories not supported)', () => {
    const line = 'cp -r /abs/dir .'
    const [entry] = parseSetupScriptPlan(line).entries
    expect(entry.kind).toBe('error')
    expect((entry as Extract<SetupPlanEntry, { kind: 'error' }>).line).toBe(line)
  })

  it('errors on cp with other flags like -R and -a', () => {
    for (const line of ['cp -R /abs/dir .', 'cp -a /abs/dir .']) {
      const [entry] = parseSetupScriptPlan(line).entries
      expect(entry.kind).toBe('error')
    }
  })

  it('errors on cp with too many operands', () => {
    const line = 'cp /a /b /c'
    const [entry] = parseSetupScriptPlan(line).entries
    expect(entry.kind).toBe('error')
    expect((entry as Extract<SetupPlanEntry, { kind: 'error' }>).reason).toMatch(/operand/i)
  })

  it('errors on cp with too few operands', () => {
    const line = 'cp /a'
    const [entry] = parseSetupScriptPlan(line).entries
    expect(entry.kind).toBe('error')
    expect((entry as Extract<SetupPlanEntry, { kind: 'error' }>).reason).toMatch(/operand/i)
  })

  it('errors on cp with an absolute destination', () => {
    const line = 'cp /abs/file /abs/dest'
    const [entry] = parseSetupScriptPlan(line).entries
    expect(entry.kind).toBe('error')
    expect((entry as Extract<SetupPlanEntry, { kind: 'error' }>).reason).toMatch(/relative/i)
  })

  it('errors on cp with a tilde destination', () => {
    const line = 'cp /abs/file ~/dest'
    const [entry] = parseSetupScriptPlan(line).entries
    expect(entry.kind).toBe('error')
    expect((entry as Extract<SetupPlanEntry, { kind: 'error' }>).reason).toMatch(/relative/i)
  })

  it('errors on cp with a tilde source', () => {
    const line = 'cp ~/src .'
    const [entry] = parseSetupScriptPlan(line).entries
    expect(entry.kind).toBe('error')
    expect((entry as Extract<SetupPlanEntry, { kind: 'error' }>).reason).toMatch(/tilde|absolute/i)
  })

  it('treats cp with two relative operands as a plain command', () => {
    const line = 'cp rel/file other/'
    expect(parseSetupScriptPlan(line).entries).toEqual([{ kind: 'command', line }])
  })

  it('errors on an unterminated quote', () => {
    const line = 'cp "/abs/file .'
    const [entry] = parseSetupScriptPlan(line).entries
    expect(entry.kind).toBe('error')
    expect((entry as Extract<SetupPlanEntry, { kind: 'error' }>).reason).toMatch(/quote/i)
  })

  it('preserves ordering across a mix of entry kinds', () => {
    const script = [
      '# setup',
      'pnpm install',
      'cp /abs/file .',
      'cp -r /abs/dir .',
      'cp rel/file other/',
      'cp "/a b/c.env" sub'
    ].join('\n')

    const kinds = parseSetupScriptPlan(script).entries.map((entry) => entry.kind)
    expect(kinds).toEqual([
      'command',
      'transfer-candidate',
      'error',
      'command',
      'transfer-candidate'
    ])
  })
})
