// The assistant's composer: Enter sends, Shift+Enter breaks the line, IME composition never
// sends; Escape is left to the panel (it stops a running request). While a request runs the
// Send button becomes Stop. The footer names the database the question is asked in and offers
// the model picker (the user's default model unless overridden for this panel).
import { useLayoutEffect, useMemo, useRef, type RefObject } from 'react'
import { Database, Loader2, Send, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { ModelSelector } from '@/components/sessions/ModelSelector'
import { defaultAssistantModel } from '@/lib/data-projects/assistant-generation'
import { isComposingKeyboardEvent } from '@/lib/message-composer-shortcuts'
import { selectAssistantConversation, useDataAssistantStore } from '@/stores/useDataAssistantStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { dataEngineFamily, type DataProject } from '@shared/data-projects/types'
import { useAssistantActiveDatabase } from './assistant-context'

const MAX_TEXTAREA_HEIGHT_PX = 160

interface AssistantComposerProps {
  project: DataProject
  textareaRef: RefObject<HTMLTextAreaElement | null>
}

export function AssistantComposer({
  project,
  textareaRef
}: AssistantComposerProps): React.JSX.Element {
  const conversation = useDataAssistantStore(selectAssistantConversation(project.id))
  const setComposer = useDataAssistantStore((s) => s.setComposer)
  const ask = useDataAssistantStore((s) => s.ask)
  const cancel = useDataAssistantStore((s) => s.cancel)
  const modelOverride = useDataAssistantStore((s) => s.modelOverride)
  const setModelOverride = useDataAssistantStore((s) => s.setModelOverride)
  const database = useAssistantActiveDatabase(project.id, dataEngineFamily(project.engine))
  // The default model follows the settings it is resolved from.
  const defaultAgentSdk = useSettingsStore((s) => s.defaultAgentSdk)
  const selectedModel = useSettingsStore((s) => s.selectedModel)
  const selectedModelByProvider = useSettingsStore((s) => s.selectedModelByProvider)
  const defaultModels = useSettingsStore((s) => s.defaultModels)
  const defaultModel = useMemo(
    () => defaultAssistantModel(),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read through getState() inside
    [defaultAgentSdk, selectedModel, selectedModelByProvider, defaultModels]
  )
  const isImeComposingRef = useRef(false)

  const value = conversation.composer
  const busy = conversation.status !== 'idle'
  const canSend = !busy && value.trim().length > 0

  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(textarea.scrollHeight, MAX_TEXTAREA_HEIGHT_PX)}px`
  }, [value, textareaRef])

  const send = (): void => {
    if (!canSend) return
    void ask(project, value)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key !== 'Enter') return
    if (isComposingKeyboardEvent(e.nativeEvent, isImeComposingRef.current)) return
    if (e.shiftKey) return
    e.preventDefault()
    send()
  }

  return (
    <div className="border-t border-border px-3 py-2">
      <div className="rounded-lg border border-border bg-secondary/30 p-2">
        <Textarea
          ref={textareaRef}
          value={value}
          placeholder={
            dataEngineFamily(project.engine) === 'document'
              ? 'Ask for a MongoDB query…'
              : 'Ask for a SQL query…'
          }
          rows={2}
          aria-label="Ask the database assistant"
          className="min-h-[60px] max-h-[160px] resize-none border-0 bg-transparent p-2 shadow-none focus-visible:ring-0 focus-visible:border-transparent dark:bg-transparent"
          onChange={(e) => setComposer(project.id, e.target.value)}
          onKeyDown={handleKeyDown}
          onCompositionStart={() => {
            isImeComposingRef.current = true
          }}
          onCompositionEnd={() => {
            isImeComposingRef.current = false
          }}
          data-testid="data-assistant-composer"
        />
        <div className="flex items-center justify-between gap-2 px-1 pb-0.5">
          <div className="flex min-w-0 flex-1 items-center gap-1">
            <div className="min-w-0 overflow-hidden" data-testid="data-assistant-model">
              <ModelSelector
                value={modelOverride ?? defaultModel}
                onChange={(model) => setModelOverride(model)}
                allowAgentSdkSelection
              />
            </div>
            {modelOverride && (
              <button
                type="button"
                className="shrink-0 text-[11px] text-muted-foreground hover:text-foreground"
                title="Use your default model again"
                onClick={() => setModelOverride(null)}
                data-testid="data-assistant-model-default"
              >
                Default
              </button>
            )}
            {database && (
              <span
                className="flex max-w-[40%] shrink-0 items-center gap-1 text-[11px] text-muted-foreground"
                title={`Questions are asked in database ${database}`}
                data-testid="data-assistant-database"
              >
                <Database className="h-3 w-3 shrink-0" />
                <span className="truncate">{database}</span>
              </span>
            )}
          </div>
          {busy ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={conversation.status === 'cancelling'}
              onClick={() => void cancel(project.id)}
              title="Stop (Esc)"
              data-testid="data-assistant-stop"
            >
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <Square className="h-3 w-3" />
              Stop
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              disabled={!canSend}
              onClick={send}
              title="Send (Enter)"
              data-testid="data-assistant-send"
            >
              <Send className="h-3.5 w-3.5" />
              Send
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
