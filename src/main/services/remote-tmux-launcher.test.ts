import { describe, expect, it, vi } from 'vitest'

// The "missing session" test below is the only case that touches the DB, and
// it returns before any other module (hook server, binary resolver, tmux) is
// exercised, so a minimal `getSession` stub is enough — no other mocking
// needed (see terminal-pty-bridge.claude-cli.test.ts for the heavier
// alternative this deliberately avoids).
vi.mock('../db', () => ({
  getDatabase: () => ({ getSession: vi.fn(() => null) })
}))

import { buildTmuxLaunchScript, launchClaudeCliInTmux, shq } from './remote-tmux-launcher'

describe('shq', () => {
  it('wraps a plain string in single quotes', () => {
    expect(shq('hello')).toBe("'hello'")
  })

  it('escapes an embedded single quote', () => {
    expect(shq("it's")).toBe(`'it'\\''s'`)
  })

  it('leaves $, ", ` and newlines untouched — the outer single quotes neutralize them', () => {
    const hostile = '$HOME "quoted" `cmd` \nline2'
    expect(shq(hostile)).toBe(`'${hostile}'`)
  })

  it('quotes an empty string', () => {
    expect(shq('')).toBe("''")
  })
})

describe('buildTmuxLaunchScript', () => {
  const baseOpts = {
    cwd: '/Users/mor/work/repo',
    command: '/usr/local/bin/claude',
    args: ['--dangerously-skip-permissions'],
    env: {} as Record<string, string>,
    promptFilePath: '/Users/mor/.hive/remote-launch/session-1.prompt.txt'
  }

  it('starts with a shebang then cd <cwd> || exit 1', () => {
    const script = buildTmuxLaunchScript(baseOpts)
    const lines = script.split('\n')
    expect(lines[0]).toBe('#!/bin/sh')
    expect(lines[1]).toBe(`cd ${shq(baseOpts.cwd)} || exit 1`)
  })

  it('quotes a hostile cwd', () => {
    const hostileCwd = '/tmp/it\'s a $(dir) "repo"'
    const script = buildTmuxLaunchScript({ ...baseOpts, cwd: hostileCwd })
    expect(script).toContain(`cd ${shq(hostileCwd)} || exit 1`)
  })

  it('quotes a hostile arg and never emits it unquoted', () => {
    const hostileArg = `--foo=$(rm -rf /) with spaces and 'quotes'`
    const script = buildTmuxLaunchScript({ ...baseOpts, args: [hostileArg] })
    expect(script).toContain(shq(hostileArg))
    // Strip every properly-quoted occurrence; nothing of the raw hostile
    // string should remain anywhere else in the script.
    const withoutQuotedForm = script.split(shq(hostileArg)).join('')
    expect(withoutQuotedForm).not.toContain(hostileArg)
  })

  it('quotes a hostile prompt file path', () => {
    const hostilePath = "/tmp/session's $(x) dir/prompt.txt"
    const script = buildTmuxLaunchScript({ ...baseOpts, promptFilePath: hostilePath })
    expect(script).toContain(`"$(cat ${shq(hostilePath)})"`)
    expect(script).not.toContain(`cat ${hostilePath})`)
  })

  it('quotes env exports', () => {
    const hostileValue = `bar's "value" \`cmd\``
    const script = buildTmuxLaunchScript({ ...baseOpts, env: { FOO: hostileValue } })
    expect(script).toContain(`export FOO=${shq(hostileValue)}`)
  })

  it('contains "$(cat <promptfile>)" exactly once, as the final token', () => {
    const script = buildTmuxLaunchScript(baseOpts)
    const expected = `"$(cat ${shq(baseOpts.promptFilePath)})"`
    const occurrences = script.split(expected).length - 1
    expect(occurrences).toBe(1)
    expect(script.trimEnd().endsWith(expected)).toBe(true)
  })

  it('has no parameter for raw prompt content — an extra `prompt` field is ignored even if passed', () => {
    const script = buildTmuxLaunchScript({
      ...baseOpts,
      // @ts-expect-error — `prompt` is not part of buildTmuxLaunchScript's opts type.
      prompt: 'THE-SECRET-PROMPT-CONTENT'
    })
    expect(script).not.toContain('THE-SECRET-PROMPT-CONTENT')
  })
})

describe('launchClaudeCliInTmux', () => {
  it('returns an error result when the session does not exist', async () => {
    const result = await launchClaudeCliInTmux({
      sessionId: 'missing-session',
      worktreePath: '/tmp/repo',
      prompt: 'do the thing',
      tmuxSessionName: 'hive-missing-session'
    })
    expect(result).toEqual({ success: false, error: 'Session not found' })
  })
})
