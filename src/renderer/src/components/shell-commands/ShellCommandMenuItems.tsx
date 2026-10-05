import { SquareTerminal } from 'lucide-react'
import { parseProjectShellCommands, type ProjectShellCommand } from '@shared/lib/shell-commands'
import { runProjectShellCommand } from '@/lib/shell-command-launch'
import { isWindows } from '@/lib/platform'
import { toast } from '@/lib/toast'

/** Up to this many commands render flat in a menu; more collapse into a "Run Command" submenu. */
export const SHELL_COMMAND_FLAT_LIMIT = 5

/**
 * The commands a project's menus may offer: none for connection projects or on Windows,
 * otherwise the project's valid definitions (blank / invalid entries are dropped).
 */
export function getRunnableShellCommands(
  project: { kind?: string; shell_commands?: ProjectShellCommand[] | null } | null | undefined
): ProjectShellCommand[] {
  if (!project || project.kind === 'connection' || isWindows()) return []
  return parseProjectShellCommands(project.shell_commands)
}

/* eslint-disable @typescript-eslint/no-explicit-any */
interface ShellCommandMenuItemsOptions {
  commands: ProjectShellCommand[]
  onRun: (command: ProjectShellCommand) => void
  // Injected so one renderer serves both the ContextMenu and the DropdownMenu families
  MenuItem: React.ComponentType<any>
  MenuSeparator: React.ComponentType<any>
  MenuSub: React.ComponentType<any>
  MenuSubTrigger: React.ComponentType<any>
  MenuSubContent: React.ComponentType<any>
  /** For menus whose next group does not open with its own separator. */
  trailingSeparator?: boolean
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Menu entries for a project's shell commands, as a plain render function (not a
 * component) so callers can drop it into any Radix menu. Returns null when there is
 * nothing to show, so no stray separator is rendered.
 */
export function renderShellCommandMenuItems({
  commands,
  onRun,
  MenuItem,
  MenuSeparator,
  MenuSub,
  MenuSubTrigger,
  MenuSubContent,
  trailingSeparator
}: ShellCommandMenuItemsOptions): React.JSX.Element | null {
  if (commands.length === 0) return null

  const items = commands.map((command) => (
    <MenuItem key={command.id} onClick={() => onRun(command)}>
      <SquareTerminal className="h-4 w-4 mr-2" />
      <span className="truncate">{command.name}</span>
    </MenuItem>
  ))

  return (
    <>
      <MenuSeparator />
      {commands.length <= SHELL_COMMAND_FLAT_LIMIT ? (
        items
      ) : (
        <MenuSub>
          <MenuSubTrigger>
            <SquareTerminal className="h-4 w-4 mr-2" />
            Run Command
          </MenuSubTrigger>
          <MenuSubContent className="w-52">{items}</MenuSubContent>
        </MenuSub>
      )}
      {trailingSeparator && <MenuSeparator />}
    </>
  )
}

/**
 * Launch a command from a menu and own the failure toast. No success toast: the launch
 * jumps to the new terminal tab. Without a worktreeId the run uses the base worktree.
 */
export async function runShellCommandFromMenu(input: {
  projectId: string
  commandId: string
  commandName: string
  worktreeId?: string | null
}): Promise<void> {
  const result = await runProjectShellCommand({
    projectId: input.projectId,
    commandId: input.commandId,
    worktreeId: input.worktreeId
  })
  if (!result.success) {
    toast.error(result.error ?? 'Failed to run command')
  }
}
