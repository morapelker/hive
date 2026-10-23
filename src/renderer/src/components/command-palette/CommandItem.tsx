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
  FileText,
  ChevronRight,
  Database
} from 'lucide-react'
import { KanbanIcon } from '@/components/kanban/KanbanIcon'
import { cn } from '@/lib/utils'

// Icon mapping
const iconMap: Record<string, React.ComponentType<{ className?: string }>> = {
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
  FileText,
  KanbanIcon,
  Database
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
        'flex items-center gap-3 px-3 py-2 rounded-md cursor-pointer text-[13px] tracking-[0.01em]',
        'transition-colors duration-100',
        isSelected && 'bg-accent',
        !isEnabled && 'opacity-50 cursor-not-allowed'
      )}
      data-testid={`command-item-${command.id}`}
    >
      {/* Icon */}
      {Icon && <Icon className="w-4 h-4 shrink-0 text-muted-foreground" />}

      {/* Label and description */}
      <div className="flex-1 min-w-0">
        <div className="truncate font-medium text-foreground">{command.label}</div>
        {command.description && (
          <div className="text-[11px] truncate text-muted-foreground">{command.description}</div>
        )}
      </div>

      {/* Keyboard shortcut or nested indicator */}
      <div className="shrink-0 flex items-center gap-2">
        {command.shortcut && (
          <span
            className={cn(
              'text-[11px] font-mono px-1.5 py-0.5 rounded-md',
              isSelected ? 'bg-background/40 text-foreground' : 'bg-muted text-muted-foreground'
            )}
            data-testid={`command-shortcut-${command.id}`}
          >
            {command.shortcut}
          </span>
        )}
        {command.hasChildren && <ChevronRight className="w-4 h-4 text-muted-foreground" />}
      </div>
    </Command.Item>
  )
})
