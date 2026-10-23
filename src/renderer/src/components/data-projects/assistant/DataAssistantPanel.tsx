// The data project's AI assistant: a resizable side panel next to the workspace (a flex sibling,
// so results are never covered). Header (h-8): sparkles, title, a one-line status with elapsed
// seconds, the model in use, New conversation and Close. Then the conversation and the composer.
// Keyboard: Escape anywhere inside stops a running request (else blurs the composer); Enter
// sends from the composer. Proposed queries land in the editor automatically and are never run.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RotateCcw, Sparkles, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ResizeHandle } from '@/components/layout/ResizeHandle'
import {
  assistantProviderLabel,
  describeAssistantGeneration,
  resolveDataAssistantGeneration
} from '@/lib/data-projects/assistant-generation'
import { selectAssistantConversation, useDataAssistantStore } from '@/stores/useDataAssistantStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import type { DataProject } from '@shared/data-projects/types'
import { AssistantComposer } from './AssistantComposer'
import { AssistantMessageList } from './AssistantMessageList'
import { assistantStatusLine } from './assistant-ui'

export interface DataAssistantPanelProps {
  project: DataProject
  onClose: () => void
}

function useElapsedSeconds(startedAt: number | null): number {
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    if (startedAt === null) {
      setElapsed(0)
      return
    }
    setElapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)))
    const timer = setInterval(() => {
      setElapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)))
    }, 1000)
    return () => clearInterval(timer)
  }, [startedAt])
  return elapsed
}

export function DataAssistantPanel({
  project,
  onClose
}: DataAssistantPanelProps): React.JSX.Element {
  const conversation = useDataAssistantStore(selectAssistantConversation(project.id))
  const width = useDataAssistantStore((s) => s.width)
  const modelOverride = useDataAssistantStore((s) => s.modelOverride)
  const newConversation = useDataAssistantStore((s) => s.newConversation)
  // Re-resolve the model label when the settings it depends on change.
  const defaultAgentSdk = useSettingsStore((s) => s.defaultAgentSdk)
  const availableAgentSdks = useSettingsStore((s) => s.availableAgentSdks)
  const selectedModelByProvider = useSettingsStore((s) => s.selectedModelByProvider)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const elapsedSeconds = useElapsedSeconds(conversation.startedAt)

  const generation = useMemo(
    () => resolveDataAssistantGeneration(modelOverride),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- settings are read through getState()
    [modelOverride, defaultAgentSdk, availableAgentSdks, selectedModelByProvider]
  )
  const answeredBy = conversation.answeredBy
  // After a provider fallback the last answer came from someone else: say so.
  const modelLabel =
    describeAssistantGeneration(generation) +
    (answeredBy && generation && answeredBy.provider !== generation.provider
      ? ` (last answer: ${assistantProviderLabel(answeredBy.provider)})`
      : '')

  const statusLine = assistantStatusLine(conversation, elapsedSeconds)

  const handleResize = useCallback((delta: number) => {
    const store = useDataAssistantStore.getState()
    store.setWidth(store.width + delta)
  }, [])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLElement>): void => {
    if (e.key !== 'Escape') return
    const current = useDataAssistantStore.getState().conversations[project.id]
    if (current?.status === 'running') {
      e.preventDefault()
      e.stopPropagation()
      void useDataAssistantStore.getState().cancel(project.id)
      return
    }
    if (document.activeElement === textareaRef.current) textareaRef.current?.blur()
  }

  const askExample = (prompt: string): void => {
    void useDataAssistantStore.getState().ask(project, prompt)
  }

  return (
    <aside
      className="relative flex h-full min-h-0 shrink-0 border-l border-border bg-sidebar"
      style={{ width }}
      onKeyDown={handleKeyDown}
      aria-label="Database assistant"
      data-testid="data-assistant-panel"
      data-assistant-status={conversation.status}
    >
      <ResizeHandle direction="right" onResize={handleResize} />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-8 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
          <div className="flex min-w-0 items-center gap-2">
            <Sparkles className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
              Assistant
            </span>
            <span
              className="truncate text-[11px] text-muted-foreground"
              title={`${statusLine} — ${modelLabel}`}
              data-testid="data-assistant-status-line"
            >
              {conversation.status === 'idle' && !conversation.error ? modelLabel : statusLine}
            </span>
          </div>
          <div className="flex shrink-0 items-center">
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 rounded-md"
              title="New conversation"
              aria-label="New conversation"
              disabled={
                conversation.messages.length === 0 &&
                conversation.status === 'idle' &&
                !conversation.error
              }
              onClick={() => newConversation(project.id)}
              data-testid="data-assistant-new-conversation"
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 rounded-md"
              title="Close the assistant"
              aria-label="Close the assistant"
              onClick={onClose}
              data-testid="data-assistant-close"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
        <AssistantMessageList
          project={project}
          elapsedSeconds={elapsedSeconds}
          onExample={askExample}
        />
        <AssistantComposer project={project} textareaRef={textareaRef} />
      </div>
    </aside>
  )
}

export default DataAssistantPanel
