import { describe, expect, it } from 'vitest'
import {
  CODEX_CLI_HOOK_EVENTS,
  buildCodexCliHookCommand,
  buildCodexCliHookOverrides,
  codexSessionFlagsHookKey,
  computeCodexHookTrustHash,
  tomlString
} from '../codex-cli-hooks'

describe('computeCodexHookTrustHash', () => {
  it('reproduces the hash codex 0.153.4 reports in hooks/list for a plain Stop command hook', () => {
    // Verified against the real binary: `-c hooks.Stop=[{hooks=[{type="command",command="/tmp/codex-hook-probe/hook.sh"}]}]`
    // → currentHash sha256:1f82e2f7…5844 (hashed bytes:
    // {"event_name":"stop","hooks":[{"async":false,"command":"/tmp/codex-hook-probe/hook.sh","timeout":600,"type":"command"}]}).
    expect(computeCodexHookTrustHash('Stop', { command: '/tmp/codex-hook-probe/hook.sh' })).toBe(
      'sha256:1f82e2f79ad43ede047010d5f31328ed0787935478340593c5589f7dfc8f5844'
    )
  })

  it('resolves the SessionEnd/Interrupt default timeout to 1s and caps explicit values at 3s', () => {
    const cmd = { command: 'x' }
    expect(computeCodexHookTrustHash('SessionEnd', cmd)).toBe(
      computeCodexHookTrustHash('SessionEnd', { command: 'x', timeoutSec: 1 })
    )
    expect(computeCodexHookTrustHash('Interrupt', { command: 'x', timeoutSec: 30 })).toBe(
      computeCodexHookTrustHash('Interrupt', { command: 'x', timeoutSec: 3 })
    )
    // Other events keep the 600s default, so an explicit 600 hashes identically.
    expect(computeCodexHookTrustHash('PreToolUse', cmd)).toBe(
      computeCodexHookTrustHash('PreToolUse', { command: 'x', timeoutSec: 600 })
    )
    expect(computeCodexHookTrustHash('PreToolUse', cmd)).not.toBe(
      computeCodexHookTrustHash('PreToolUse', { command: 'x', timeoutSec: 30 })
    )
  })

  it('changes with the event, the command, the matcher and statusMessage', () => {
    const base = computeCodexHookTrustHash('Stop', { command: 'a' })
    expect(computeCodexHookTrustHash('UserPromptSubmit', { command: 'a' })).not.toBe(base)
    expect(computeCodexHookTrustHash('Stop', { command: 'b' })).not.toBe(base)
    expect(computeCodexHookTrustHash('Stop', { command: 'a' }, 'Bash')).not.toBe(base)
    expect(computeCodexHookTrustHash('Stop', { command: 'a', statusMessage: 'hi' })).not.toBe(base)
  })
})

describe('codexSessionFlagsHookKey', () => {
  it('uses codex snake_case event labels under the synthetic session-flags path', () => {
    expect(codexSessionFlagsHookKey('Stop')).toBe('/<session-flags>/config.toml:stop:0:0')
    expect(codexSessionFlagsHookKey('UserPromptSubmit')).toBe(
      '/<session-flags>/config.toml:user_prompt_submit:0:0'
    )
    expect(codexSessionFlagsHookKey('PreToolUse', 1, 2)).toBe(
      '/<session-flags>/config.toml:pre_tool_use:1:2'
    )
  })
})

describe('tomlString', () => {
  it('quotes and escapes basic-string characters', () => {
    expect(tomlString('plain')).toBe('"plain"')
    expect(tomlString('a "q" \\ b')).toBe('"a \\"q\\" \\\\ b"')
    expect(tomlString('C:\\Users\\me')).toBe('"C:\\\\Users\\\\me"')
    expect(tomlString('line\nbreak\ttab')).toBe('"line\\nbreak\\ttab"')
  })
})

describe('buildCodexCliHookCommand', () => {
  it('posts stdin to the per-session codex hook route and never fails the hook', () => {
    const cmd = buildCodexCliHookCommand(41234, 'hive session/1', 'stop')
    expect(cmd).toContain('curl -sS -m 20 -X POST')
    expect(cmd).toContain('--data-binary @-')
    expect(cmd).toContain('http://127.0.0.1:41234/codex-hook/hive%20session%2F1/stop')
    expect(cmd.endsWith("|| echo '{}'")).toBe(true)
  })
})

describe('buildCodexCliHookOverrides', () => {
  it('emits one -c hooks.<Event> override per subscribed event plus a single pre-trusting state table', () => {
    const { args, trustedHashes } = buildCodexCliHookOverrides(5555, 'sess-1')
    const pairs: Array<[string, string]> = []
    for (let i = 0; i < args.length; i += 2) {
      expect(args[i]).toBe('-c')
      pairs.push([args[i], args[i + 1]])
    }
    const keys = pairs.map(([, kv]) => kv.split('=')[0])
    for (const { event } of CODEX_CLI_HOOK_EVENTS) {
      expect(keys).toContain(`hooks.${event}`)
    }
    expect(keys.filter((k) => k === 'hooks.state')).toHaveLength(1)
    expect(keys).toHaveLength(CODEX_CLI_HOOK_EVENTS.length + 1)

    // Every event's key is trusted with the hash of exactly the handler emitted for it.
    const stateValue = pairs.find(([, kv]) => kv.startsWith('hooks.state='))![1]
    for (const { event } of CODEX_CLI_HOOK_EVENTS) {
      const key = codexSessionFlagsHookKey(event)
      expect(trustedHashes[key]).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(stateValue).toContain(`${tomlString(key)}={trusted_hash=${tomlString(trustedHashes[key])}}`)
    }
  })

  it('hashes the handler exactly as emitted (command + resolved timeout) so codex accepts the state', () => {
    const { args, trustedHashes } = buildCodexCliHookOverrides(5555, 'sess-1')
    const stop = args.find((a) => a.startsWith('hooks.Stop='))!
    const stopCommand = buildCodexCliHookCommand(5555, 'sess-1', 'stop')
    expect(stop).toContain(`command=${tomlString(stopCommand)}`)
    expect(stop).not.toContain('timeout=')
    expect(trustedHashes[codexSessionFlagsHookKey('Stop')]).toBe(
      computeCodexHookTrustHash('Stop', { command: stopCommand })
    )

    // SessionEnd/Interrupt get an explicit 3s timeout (codex's cap), included in the hash.
    const sessionEnd = args.find((a) => a.startsWith('hooks.SessionEnd='))!
    expect(sessionEnd).toContain('timeout=3')
    expect(trustedHashes[codexSessionFlagsHookKey('SessionEnd')]).toBe(
      computeCodexHookTrustHash('SessionEnd', {
        command: buildCodexCliHookCommand(5555, 'sess-1', 'session'),
        timeoutSec: 3
      })
    )
  })

  it('routes events to the same server paths claude uses', () => {
    const { args } = buildCodexCliHookOverrides(7000, 's')
    const value = (event: string): string => args.find((a) => a.startsWith(`hooks.${event}=`))!
    expect(value('UserPromptSubmit')).toContain('/codex-hook/s/start')
    expect(value('Stop')).toContain('/codex-hook/s/stop')
    expect(value('Interrupt')).toContain('/codex-hook/s/stop')
    expect(value('PreToolUse')).toContain('/codex-hook/s/tool')
    expect(value('PermissionRequest')).toContain('/codex-hook/s/permission')
    expect(value('SubagentStart')).toContain('/codex-hook/s/subagent')
    expect(value('SessionStart')).toContain('/codex-hook/s/session')
  })
})
