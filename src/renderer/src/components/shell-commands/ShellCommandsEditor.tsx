import { ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Textarea } from '@/components/ui/textarea'
import {
  SHELL_COMMAND_MAX_PER_PROJECT,
  SHELL_COMMAND_NAME_MAX,
  validateShellCommand,
  type ProjectShellCommand
} from '@shared/lib/shell-commands'

interface ShellCommandsEditorProps {
  value: ProjectShellCommand[]
  onChange: (next: ProjectShellCommand[]) => void
}

function newCommand(): ProjectShellCommand {
  return {
    // The fallback stays inside the id alphabet validateShellCommand accepts (no '.')
    id:
      globalThis.crypto?.randomUUID?.() ??
      `command-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name: '',
    commands: ''
  }
}

/** First validation error of a row that is filled in; half-typed rows show nothing. */
function validationHint(command: ProjectShellCommand): string | null {
  if (command.name.trim() === '' || command.commands.trim() === '') return null
  const result = validateShellCommand(command)
  return result.valid ? null : (result.errors[0] ?? null)
}

export function ShellCommandsEditor({
  value,
  onChange
}: ShellCommandsEditorProps): React.JSX.Element {
  const updateCommand = (
    id: string,
    patch: Partial<Pick<ProjectShellCommand, 'name' | 'commands' | 'keepRunningOnQuit'>>
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

  return (
    <div className="space-y-3" data-testid="shell-commands-editor">
      <p className="text-xs text-muted-foreground">
        Each line is one step and runs in your login shell, in order; a failing line stops the run.
        Join long commands with ;, && or a trailing backslash. Lines starting with # are ignored.
        Steps use POSIX shell syntax.
      </p>

      <div className="space-y-3">
        {value.map((command, index) => {
          const hint = validationHint(command)
          const keepRunningId = `shell-command-keep-running-${command.id}`
          return (
            <div key={command.id} className="rounded-md border border-border bg-background p-3">
              <div className="mb-2 flex items-center gap-2">
                <input
                  value={command.name}
                  onChange={(event) => updateCommand(command.id, { name: event.target.value })}
                  placeholder="Command name"
                  maxLength={SHELL_COMMAND_NAME_MAX}
                  data-testid={`shell-command-name-${command.id}`}
                  className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:border-ring"
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
              <Textarea
                value={command.commands}
                onChange={(event) => updateCommand(command.id, { commands: event.target.value })}
                placeholder={'pnpm install:mac'}
                rows={3}
                aria-label="Command steps"
                data-testid={`shell-command-script-${command.id}`}
                className="font-mono text-sm resize-y"
              />
              <div className="mt-2 space-y-1">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id={keepRunningId}
                    data-testid={keepRunningId}
                    checked={command.keepRunningOnQuit === true}
                    onCheckedChange={(checked) =>
                      updateCommand(command.id, { keepRunningOnQuit: checked })
                    }
                  />
                  <label htmlFor={keepRunningId} className="text-sm">
                    Keep running if the app quits
                  </label>
                </div>
                <p className="text-xs text-muted-foreground">
                  Runs outside the app, so it survives quitting or reinstalling Hive. Use it
                  for commands that restart or replace the app. Output is still saved to the ticket.
                </p>
              </div>
              {hint && <p className="mt-2 text-xs text-destructive">{hint}</p>}
            </div>
          )
        })}
      </div>

      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-8"
        data-testid="shell-command-add"
        disabled={value.length >= SHELL_COMMAND_MAX_PER_PROJECT}
        onClick={() => onChange([...value, newCommand()])}
      >
        <Plus className="h-4 w-4" />
        Add command
      </Button>
    </div>
  )
}
