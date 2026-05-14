import { useCallback, useEffect, useMemo, useState } from 'react'
import { TerminalView } from '@/components/terminal/TerminalView'
import { unwrapEnvelope } from '@/lib/ipc-envelope'
import { useSessionStore } from '@/stores/useSessionStore'
import { ModeToggle } from './ModeToggle'
import { SuperToggle } from './SuperToggle'
import { ModelSelector } from './ModelSelector'
import { ClaudeCliEndedOverlay } from './ClaudeCliEndedOverlay'
import '@xterm/xterm/css/xterm.css'
import '@/styles/xterm.css'

interface ClaudeCliSessionViewProps {
  sessionId: string
  isVisible?: boolean
}

export function ClaudeCliSessionView({
  sessionId,
  isVisible = true
}: ClaudeCliSessionViewProps): React.JSX.Element {
  const [terminalKey, setTerminalKey] = useState(0)
  const [ended, setEnded] = useState(false)
  const pendingMessage = useSessionStore((state) => state.pendingMessages.get(sessionId) ?? null)

  const createClaudeTerminal = useCallback(async () => {
    const pendingPrompt = useSessionStore.getState().dequeuePendingMessage(sessionId)
    try {
      const envelope = await window.terminalOps.createClaudeCli(sessionId, {
        pendingPrompt
      })
      const result = unwrapEnvelope(envelope)
      if (!result.success && pendingPrompt) {
        useSessionStore.getState().requeuePendingMessage(sessionId, pendingPrompt)
      }
      return envelope
    } catch (error) {
      if (pendingPrompt) {
        useSessionStore.getState().requeuePendingMessage(sessionId, pendingPrompt)
      }
      throw error
    }
  }, [sessionId])

  useEffect(() => {
    return window.terminalOps.onClaudeSessionId(sessionId, (claudeSessionId) => {
      useSessionStore.getState().setClaudeSessionId(sessionId, claudeSessionId)
    })
  }, [sessionId])

  const handleStatusChange = useCallback(
    (status: 'creating' | 'running' | 'exited') => {
      if (status === 'running') {
        setEnded(false)
      } else if (status === 'exited') {
        setEnded(true)
      }
    },
    []
  )

  const handleRestart = useCallback(() => {
    setEnded(false)
    setTerminalKey((current) => current + 1)
  }, [])

  const terminalId = useMemo(() => `${sessionId}:${terminalKey}`, [sessionId, terminalKey])

  return (
    <div
      className="flex-1 flex flex-col min-h-0 bg-background"
      data-testid="claude-cli-session-view"
      data-session-id={sessionId}
    >
      <div className="flex items-center justify-between gap-3 border-b border-border bg-background px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <ModeToggle sessionId={sessionId} />
          <SuperToggle sessionId={sessionId} />
          {pendingMessage && (
            <span className="truncate text-xs text-muted-foreground">handoff prompt pending</span>
          )}
        </div>
        <ModelSelector sessionId={sessionId} />
      </div>

      <div className="relative min-h-0 flex-1">
        <TerminalView
          key={terminalId}
          terminalId={sessionId}
          cwd="/"
          isVisible={isVisible}
          showToolbar={false}
          backendTypeOverride="xterm"
          createTerminal={createClaudeTerminal}
          onStatusChange={handleStatusChange}
        />
        {ended && <ClaudeCliEndedOverlay onRestart={handleRestart} />}
      </div>
    </div>
  )
}
