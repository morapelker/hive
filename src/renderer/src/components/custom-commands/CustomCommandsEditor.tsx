import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import type { CustomProjectCommand } from '@/lib/custom-commands'
import { CUSTOM_COMMAND_EXAMPLES, PROJECT_PLACEHOLDERS } from '@/lib/custom-commands'
import {
  PromptCodeEditor,
  type PromptCodeEditorHandle
} from '@/components/custom-commands/PromptCodeEditor'

interface CustomCommandsEditorProps {
  value: CustomProjectCommand[]
  onChange: (next: CustomProjectCommand[]) => void
}

function newCommand(): CustomProjectCommand {
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `command-${Date.now()}-${Math.random()}`,
    name: '',
    prompt: ''
  }
}

export function CustomCommandsEditor({
  value,
  onChange
}: CustomCommandsEditorProps): React.JSX.Element {
  const editorRefs = useRef(new Map<string, PromptCodeEditorHandle>())
  const [activeCommandId, setActiveCommandId] = useState<string | null>(null)

  useEffect(() => {
    if (value.length === 0) {
      const command = newCommand()
      onChange([command])
      setActiveCommandId(command.id)
    }
  }, [onChange, value.length])

  const commandIds = useMemo(() => new Set(value.map((command) => command.id)), [value])

  useEffect(() => {
    for (const commandId of Array.from(editorRefs.current.keys())) {
      if (!commandIds.has(commandId)) {
        editorRefs.current.delete(commandId)
      }
    }
  }, [commandIds])

  const updateCommand = (
    id: string,
    patch: Partial<Pick<CustomProjectCommand, 'name' | 'prompt'>>
  ): void => {
    onChange(value.map((command) => (command.id === id ? { ...command, ...patch } : command)))
  }

  const moveCommand = (index: number, direction: -1 | 1): void => {
    const nextIndex = index + direction
    if (nextIndex < 0 || nextIndex >= value.length) return
    const next = [...value]
    const [command] = next.splice(index, 1)
    next.splice(nextIndex, 0, command)
    onChange(next)
  }

  const deleteCommand = (id: string): void => {
    onChange(value.filter((command) => command.id !== id))
  }

  const insertPlaceholder = (token: string): void => {
    const targetId = activeCommandId ?? value[0]?.id ?? null
    if (!targetId) return
    editorRefs.current.get(targetId)?.insertToken(token)
  }

  const fillExample = (example: Pick<CustomProjectCommand, 'name' | 'prompt'>): void => {
    const targetId = activeCommandId ?? value[0]?.id ?? null

    if (!targetId) {
      const command = {
        ...newCommand(),
        name: example.name,
        prompt: example.prompt
      }
      onChange([command])
      setActiveCommandId(command.id)
      return
    }

    onChange(
      value.map((command) =>
        command.id === targetId
          ? { ...command, name: example.name, prompt: example.prompt }
          : command
      )
    )
    editorRefs.current.get(targetId)?.focus()
  }

  return (
    <div className="space-y-3">
      <div className="space-y-3">
        {value.map((command, index) => (
          <div key={command.id} className="rounded-md border border-border bg-background p-3">
            <div className="mb-2 flex items-center gap-2">
              <input
                value={command.name}
                onChange={(event) => updateCommand(command.id, { name: event.target.value })}
                onFocus={() => setActiveCommandId(command.id)}
                placeholder="Command name"
                className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/20"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => moveCommand(index, -1)}
                disabled={index === 0}
                title="Move up"
                aria-label="Move command up"
              >
                <ChevronUp className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => moveCommand(index, 1)}
                disabled={index === value.length - 1}
                title="Move down"
                aria-label="Move command down"
              >
                <ChevronDown className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground hover:text-destructive"
                onClick={() => deleteCommand(command.id)}
                title="Delete"
                aria-label="Delete command"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
            <PromptCodeEditor
              ref={(editor) => {
                if (editor) {
                  editorRefs.current.set(command.id, editor)
                } else {
                  editorRefs.current.delete(command.id)
                }
              }}
              value={command.prompt}
              onChange={(prompt) => updateCommand(command.id, { prompt })}
              onFocus={() => setActiveCommandId(command.id)}
            />
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {PROJECT_PLACEHOLDERS.map((placeholder) => (
          <button
            key={placeholder.token}
            type="button"
            className="rounded-md border border-border bg-muted/40 px-2 py-1 font-mono text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
            title={placeholder.description}
            onClick={() => insertPlaceholder(placeholder.token)}
          >
            {placeholder.token}
          </button>
        ))}
      </div>

      <div className="grid gap-2 sm:grid-cols-3">
        {CUSTOM_COMMAND_EXAMPLES.map((example) => (
          <button
            key={example.name}
            type="button"
            className="min-h-20 rounded-md border border-border bg-muted/20 p-2 text-left transition-colors hover:bg-muted/50"
            title={example.prompt}
            aria-label={`Use ${example.name} example`}
            onClick={() => fillExample(example)}
          >
            <div className="text-xs font-medium text-foreground">{example.name}</div>
            <div className="mt-1 line-clamp-3 text-[11px] leading-4 text-muted-foreground">
              {example.prompt}
            </div>
          </button>
        ))}
      </div>

      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-8"
        onClick={() => onChange([...value, newCommand()])}
      >
        <Plus className="h-4 w-4" />
        Add command
      </Button>
    </div>
  )
}
