import { memo } from 'react'
import { type Command as CommandType } from '@/stores/useCommandPaletteStore'
import { Command } from 'cmdk'
import {
  Plus,
  Minus,
  X,
  Folder,
  FolderPlus,
  FolderOpen,
  GitBranch,
  MessageSquare,
  History,
  Settings,
  Moon,
  Sun,
  Monitor,
  Code,
  Terminal,
  Check,
  Upload,
  Download,
  RefreshCw,
  ChevronRight,
  type LucideIcon
} from 'lucide-react'
import { cn } from '@/lib/utils'

// Icon mapping
const iconMap: Record<string, LucideIcon> = {
  Plus,
  Minus,
  X,
  Folder,
  FolderPlus,
  FolderOpen,
  GitBranch,
  MessageSquare,
  History,
  Settings,
  Moon,
  Sun,
  Monitor,
  Code,
  Terminal,
  Check,
  Upload,
  Download,
  RefreshCw
}

interface CommandItemProps {
  command: CommandType
  isSelected: boolean
  onSelect: () => void
  onMouseEnter: () => void
}

export const CommandItem = memo(function CommandItem({
  command,
  isSelected,
  onSelect,
  onMouseEnter
}: CommandItemProps) {
  const Icon = command.icon ? iconMap[command.icon] : null
  const isEnabled = !command.isEnabled || command.isEnabled()

  return (
    <Command.Item
      value={command.id}
      onSelect={onSelect}
      onMouseEnter={onMouseEnter}
      disabled={!isEnabled}
      className={cn(
        'flex items-center gap-3 px-3 py-2 rounded-md cursor-pointer text-sm',
        'transition-colors duration-100',
        isSelected && 'bg-accent',
        !isEnabled && 'opacity-50 cursor-not-allowed'
      )}
      data-testid={`command-item-${command.id}`}
    >
      {/* Icon */}
      {Icon && (
        <Icon
          className={cn(
            'w-4 h-4 shrink-0',
            isSelected ? 'text-accent-foreground' : 'text-muted-foreground'
          )}
        />
      )}

      {/* Label and description */}
      <div className="flex-1 min-w-0">
        <div
          className={cn(
            'truncate font-medium',
            isSelected ? 'text-accent-foreground' : 'text-foreground'
          )}
        >
          {command.label}
        </div>
        {command.description && (
          <div
            className={cn(
              'text-xs truncate',
              isSelected ? 'text-accent-foreground/70' : 'text-muted-foreground'
            )}
          >
            {command.description}
          </div>
        )}
      </div>

      {/* Keyboard shortcut or nested indicator */}
      <div className="shrink-0 flex items-center gap-2">
        {command.shortcut && (
          <span
            className={cn(
              'text-xs font-mono px-1.5 py-0.5 rounded',
              isSelected
                ? 'bg-accent-foreground/20 text-accent-foreground'
                : 'bg-muted text-muted-foreground'
            )}
            data-testid={`command-shortcut-${command.id}`}
          >
            {command.shortcut}
          </span>
        )}
        {command.hasChildren && (
          <ChevronRight
            className={cn(
              'w-4 h-4',
              isSelected ? 'text-accent-foreground' : 'text-muted-foreground'
            )}
          />
        )}
      </div>
    </Command.Item>
  )
})
