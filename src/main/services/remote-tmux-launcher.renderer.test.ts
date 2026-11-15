import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The Teleport remote launch starts Claude Code inside tmux on a remote server. That pane is
// not the app's own terminal, so the launch keeps the renderer Claude Code and that machine's
// settings choose: the fullscreen configuration of the app's local sessions must not reach it.

const mocks = vi.hoisted(() => ({
  written: new Map<string, string>(),
  execFile: vi.fn(
    (
      _command: string,
      _args: string[],
      callback: (error: Error | null, stdout: string, stderr: string) => void
    ) => callback(null, '', '')
  ),
  session: null as Record<string, unknown> | null
}))

vi.mock('../db', () => ({
  getDatabase: () => ({
    getSession: () => mocks.session,
    getSetting: () => null,
    updateSession: vi.fn()
  })
}))

vi.mock('./logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

vi.mock('./claude-binary-resolver', () => ({
  resolveClaudeBinaryPath: () => '/usr/local/bin/claude',
  logClaudeBinaryVersion: vi.fn()
}))

vi.mock('./claude-hook-server', () => ({
  getClaudeHookServer: async () => ({ port: 45678 }),
  buildClaudeCliHookSettings: () => HOOK_SETTINGS
}))

vi.mock('./claude-session-watcher', () => ({
  watchForClaudeSessionId: () => ({ close: vi.fn() })
}))

vi.mock('node:child_process', () => ({ execFile: mocks.execFile }))

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(async () => undefined),
  chmod: vi.fn(async () => undefined),
  writeFile: vi.fn(async (path: string, content: string) => {
    mocks.written.set(path, content)
  })
}))

import { launchClaudeCliInTmux, shq } from './remote-tmux-launcher'

const HOOK_SETTINGS = '{"hooks":{"mock":true}}'
const RENDERER_ENV_KEYS = [
  'CLAUDE_CODE_NO_FLICKER',
  'CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN',
  'CLAUDE_CODE_SCROLL_SPEED'
]

describe('launchClaudeCliInTmux renderer', () => {
  const saved = new Map<string, string | undefined>()

  beforeEach(() => {
    mocks.written.clear()
    mocks.execFile.mockClear()
    mocks.session = {
      id: 'session-1',
      mode: 'build',
      model_provider_id: 'anthropic',
      model_id: 'sonnet',
      model_variant: 'high',
      claude_session_id: null
    }
    // The script exports the app's whole environment: a renderer variable the developer's own
    // shell exports would be passed along, as it always was, and is not what is under test.
    for (const key of RENDERER_ENV_KEYS) {
      saved.set(key, process.env[key])
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    saved.clear()
  })

  it('keeps the renderer the remote machine chooses: no fullscreen variables, settings untouched', async () => {
    const result = await launchClaudeCliInTmux({
      sessionId: 'session-1',
      worktreePath: '/srv/repo',
      prompt: 'do the thing',
      tmuxSessionName: 'hive-session-1'
    })

    expect(result).toEqual({ success: true, tmuxSession: 'hive-session-1' })
    const script = [...mocks.written].find(([path]) => path.endsWith('session-1.sh'))?.[1]
    expect(script).toBeDefined()

    for (const key of RENDERER_ENV_KEYS) {
      expect(script).not.toContain(key)
    }
    // The hook settings reach claude exactly as the hook server built them.
    expect(script).toContain(`'--settings' ${shq(HOOK_SETTINGS)} `)
    expect(mocks.execFile).toHaveBeenCalledTimes(1)
  })
})
