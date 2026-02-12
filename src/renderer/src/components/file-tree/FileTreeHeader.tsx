import { RefreshCw, ChevronsDownUp, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { FileTreeFilter } from './FileTreeFilter'
import { cn } from '@/lib/utils'

interface FileTreeHeaderProps {
  title?: string
  filter: string
  isLoading: boolean
  onFilterChange: (value: string) => void
  onRefresh: () => void
  onCollapseAll: () => void
  onClose?: () => void
  className?: string
}

export function FileTreeHeader({
  title = 'Files',
  filter,
  isLoading,
  onFilterChange,
  onRefresh,
  onCollapseAll,
  onClose,
  className
}: FileTreeHeaderProps): React.JSX.Element {
  return (
    <div className={cn('flex flex-col gap-2 p-2 border-b', className)}>
      {/* Title row with actions */}
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {title}
        </span>
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={onCollapseAll}
            title="Collapse all folders"
            data-testid="file-tree-collapse-all"
          >
            <ChevronsDownUp className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={cn('h-6 w-6', isLoading && 'animate-spin')}
            onClick={onRefresh}
            disabled={isLoading}
            title="Refresh file tree"
            data-testid="file-tree-refresh"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
          {onClose && (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={onClose}
              title="Close sidebar"
              data-testid="file-tree-close"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      {/* Filter input */}
      <FileTreeFilter value={filter} onChange={onFilterChange} />
    </div>
  )
}
