import { useState, useEffect, useMemo, useCallback } from 'react'
import { Loader2, Search, Settings2, GitBranch } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { useProjectStore, useWorktreeStore, useConnectionStore } from '@/stores'

interface ManageConnectionWorktreesDialogProps {
  connectionId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

interface WorktreeOption {
  id: string
  name: string
  branchName: string
  projectId: string
  projectName: string
}

interface ProjectGroup {
  projectId: string
  projectName: string
  worktrees: WorktreeOption[]
}

export function ManageConnectionWorktreesDialog({
  connectionId,
  open,
  onOpenChange
}: ManageConnectionWorktreesDialogProps): React.JSX.Element {
  const projects = useProjectStore((s) => s.projects)
  const worktreesByProject = useWorktreeStore((s) => s.worktreesByProject)
  const connections = useConnectionStore((s) => s.connections)
  const updateConnectionMembers = useConnectionStore((s) => s.updateConnectionMembers)

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  // Find the current connection from the store
  const connection = useMemo(
    () => connections.find((c) => c.id === connectionId),
    [connections, connectionId]
  )

  // Get the current member worktree IDs
  const currentMemberIds = useMemo(
    () => new Set(connection?.members?.map((m) => m.worktree_id) ?? []),
    [connection]
  )

  // Build worktree options grouped by project — include ALL projects
  const projectGroups = useMemo(() => {
    const groups: ProjectGroup[] = []

    for (const project of projects) {
      const worktrees = worktreesByProject.get(project.id) || []
      const activeWorktrees = worktrees.filter((w) => w.status === 'active')

      if (activeWorktrees.length === 0) continue

      groups.push({
        projectId: project.id,
        projectName: project.name,
        worktrees: activeWorktrees.map((w) => ({
          id: w.id,
          name: w.name,
          branchName: w.branch_name,
          projectId: project.id,
          projectName: project.name
        }))
      })
    }

    return groups
  }, [projects, worktreesByProject])

  // Filter groups by search query
  const filteredGroups = useMemo(() => {
    if (!filter) return projectGroups
    const lowerFilter = filter.toLowerCase()

    return projectGroups
      .map((group) => ({
        ...group,
        worktrees: group.worktrees.filter(
          (w) =>
            w.name.toLowerCase().includes(lowerFilter) ||
            w.branchName.toLowerCase().includes(lowerFilter) ||
            w.projectName.toLowerCase().includes(lowerFilter)
        )
      }))
      .filter((group) => group.worktrees.length > 0)
  }, [projectGroups, filter])

  // Total available worktrees count
  const totalWorktrees = useMemo(
    () => projectGroups.reduce((sum, g) => sum + g.worktrees.length, 0),
    [projectGroups]
  )

  // Check if there are any changes from the current state
  const hasChanges = useMemo(() => {
    if (selectedIds.size !== currentMemberIds.size) return true
    for (const id of selectedIds) {
      if (!currentMemberIds.has(id)) return true
    }
    return false
  }, [selectedIds, currentMemberIds])

  // Initialize selected IDs from current members when dialog opens
  useEffect(() => {
    if (open) {
      setSelectedIds(new Set(currentMemberIds))
      setFilter('')
      setIsSubmitting(false)
    }
  }, [open, currentMemberIds])

  const toggleWorktree = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }, [])

  const handleSave = useCallback(async () => {
    if (selectedIds.size === 0 || !hasChanges) return
    setIsSubmitting(true)

    try {
      await updateConnectionMembers(connectionId, Array.from(selectedIds))
      onOpenChange(false)
    } finally {
      setIsSubmitting(false)
    }
  }, [selectedIds, hasChanges, connectionId, updateConnectionMembers, onOpenChange])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="manage-connection-worktrees-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings2 className="h-4 w-4" />
            Connection Worktrees
          </DialogTitle>
          <DialogDescription>
            Manage which worktrees are part of this connection.
          </DialogDescription>
        </DialogHeader>

        {/* Search/Filter */}
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Filter worktrees..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="pl-9"
            data-testid="manage-worktrees-filter"
          />
        </div>

        {/* Worktree List grouped by project */}
        <div
          className="max-h-[300px] overflow-y-auto border rounded-md"
          data-testid="manage-worktrees-list"
        >
          {totalWorktrees === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              No active worktrees found.
            </div>
          ) : filteredGroups.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              No worktrees match your filter
            </div>
          ) : (
            <div className="py-1">
              {filteredGroups.map((group) => (
                <div key={group.projectId}>
                  {/* Project group header */}
                  <div className="px-3 py-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wider bg-muted/30 sticky top-0">
                    {group.projectName}
                  </div>
                  {/* Worktrees in this project */}
                  {group.worktrees.map((wt) => (
                    <label
                      key={wt.id}
                      className={cn(
                        'flex items-center gap-2.5 w-full px-3 py-2 text-sm cursor-pointer',
                        'hover:bg-accent/50 transition-colors',
                        selectedIds.has(wt.id) && 'bg-accent/30'
                      )}
                      data-testid={`manage-worktree-option-${wt.id}`}
                    >
                      <Checkbox
                        checked={selectedIds.has(wt.id)}
                        onCheckedChange={() => toggleWorktree(wt.id)}
                        data-testid={`manage-worktree-checkbox-${wt.id}`}
                      />
                      <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <div className="flex-1 min-w-0">
                        <span className="truncate block">{wt.name}</span>
                        <span className="text-xs text-muted-foreground truncate block">
                          {wt.branchName}
                        </span>
                      </div>
                    </label>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer with count and action */}
        <DialogFooter className="flex items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">
            {selectedIds.size === 0
              ? 'Select at least 1 worktree'
              : `${selectedIds.size} worktree${selectedIds.size !== 1 ? 's' : ''} selected`}
          </p>
          <Button
            onClick={handleSave}
            disabled={selectedIds.size === 0 || !hasChanges || isSubmitting}
            data-testid="manage-worktrees-save-button"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Saving...
              </>
            ) : (
              'Save'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
