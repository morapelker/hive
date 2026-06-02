import { beforeEach, describe, expect, it, vi } from 'vitest'

import { deleteBuffer } from '@/lib/output-ring-buffer'
import type { ScriptOutputEvent } from '@shared/types/script'
import { resetRendererRpcClientForTests, setRendererRpcClient } from '@/api/rpc-client'
import { fireRunScript, useScriptStore } from '../useScriptStore'

describe('useScriptStore run suggestions', () => {
  const worktreeId = 'wt-suggestions'
  let emitOutput: (event: ScriptOutputEvent) => void
  let request: ReturnType<typeof vi.fn>

  beforeEach(() => {
    resetRendererRpcClientForTests()
    useScriptStore.setState({ scriptStates: {} })
    deleteBuffer(worktreeId)
    vi.clearAllMocks()
    request = vi.fn(async (method: string) => {
      if (method === 'scriptOps.runProject') return { success: true, pid: 123 }
      return null
    })
    setRendererRpcClient({
      request,
      subscribe: vi.fn(
        (_channel: string, callback: (event: { channel: string; payload: unknown }) => void) => {
          emitOutput = (event) => callback({ channel: `script:run:${worktreeId}`, payload: event })
          return vi.fn()
        }
      )
    })
  })

  function startRun(): void {
    fireRunScript(worktreeId, ['pnpm dev'], '/tmp/project')
  }

  it('sets the first detected kill suggestion', () => {
    startRun()

    emitOutput({ type: 'output', data: 'Run kill 1 to stop it.\n' })

    expect(request).toHaveBeenCalledWith('scriptOps.runProject', {
      commands: ['pnpm dev'],
      cwd: '/tmp/project',
      worktreeId
    })
    expect(useScriptStore.getState().getScriptState(worktreeId).activeSuggestion).toMatchObject({
      signature: 'killPid:1',
      label: 'kill 1',
      action: { kind: 'killPid', pid: 1 }
    })
  })

  it('does not resurface an identical suggestion after dismissing it in the same run', () => {
    startRun()
    emitOutput({ type: 'output', data: 'Run kill 1 to stop it.\n' })

    useScriptStore.getState().dismissSuggestion(worktreeId)
    emitOutput({ type: 'output', data: 'Run kill 1 to stop it.\n' })

    const state = useScriptStore.getState().getScriptState(worktreeId)
    expect(state.activeSuggestion).toBeNull()
    expect(state.seenSignatures.has('killPid:1')).toBe(true)
  })

  it('replaces the active suggestion with a different PID', () => {
    startRun()

    emitOutput({ type: 'output', data: 'Run kill 1 to stop it.\n' })
    emitOutput({ type: 'output', data: 'Run kill 2 to stop it.\n' })

    expect(useScriptStore.getState().getScriptState(worktreeId).activeSuggestion).toMatchObject({
      signature: 'killPid:2',
      label: 'kill 2',
      action: { kind: 'killPid', pid: 2 }
    })
  })

  it('clearRunOutput clears active and seen suggestions so the same PID can reappear', () => {
    startRun()
    emitOutput({ type: 'output', data: 'Run kill 1 to stop it.\n' })

    useScriptStore.getState().clearRunOutput(worktreeId)
    emitOutput({ type: 'output', data: 'Run kill 1 to stop it.\n' })

    const state = useScriptStore.getState().getScriptState(worktreeId)
    expect(state.activeSuggestion).toMatchObject({ signature: 'killPid:1' })
    expect(state.seenSignatures.has('killPid:1')).toBe(true)
  })

  it('dismissSuggestion keeps the seen signature for the current run', () => {
    startRun()
    emitOutput({ type: 'output', data: 'Run kill 1 to stop it.\n' })

    useScriptStore.getState().dismissSuggestion(worktreeId)

    const state = useScriptStore.getState().getScriptState(worktreeId)
    expect(state.activeSuggestion).toBeNull()
    expect(state.seenSignatures.has('killPid:1')).toBe(true)
  })
})
