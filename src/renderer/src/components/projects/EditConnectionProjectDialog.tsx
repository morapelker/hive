/**
 * "Edit Connection" for a connection project (projects.kind === 'connection'): pick which
 * git projects make up the connection. Saving rewrites projects.member_project_ids, so every
 * FUTURE instance (ticket launches, "+", document runs, the base instance) is built from the
 * new set; instances that already exist — running or not — keep the members they were
 * created with.
 */
import { useState, useEffect, useMemo, useCallback } from 'react'
import { Loader2, Search, Settings2, FolderGit2 } from 'lucide-react'
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
import { useProjectStore, useConnectionStore } from '@/stores'
import { parseMemberProjectIds } from '@/lib/connection-project'

interface EditConnectionProjectDialogProps {
  project: { id: string; name: string; member_project_ids?: string | null }
  open: boolean
  onOpenChange: (open: boolean) => void
}

const MIN_MEMBERS = 2

export function EditConnectionProjectDialog({
  project,
  open,
  onOpenChange
}: EditConnectionProjectDialogProps): React.JSX.Element {
  const projects = useProjectStore((s) => s.projects)
  const updateConnectionProjectMembers = useConnectionStore((s) => s.updateConnectionProjectMembers)

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  // Current members in stored order; ids whose project is gone are dropped silently
  // (the backend does the same when it resolves members).
  const candidates = useMemo(() => projects.filter((p) => p.kind !== 'connection'), [projects])
  const currentMemberIds = useMemo(() => {
    const known = new Set(candidates.map((p) => p.id))
    return parseMemberProjectIds(project.member_project_ids).filter((id) => known.has(id))
  }, [project.member_project_ids, candidates])

  const filteredCandidates = useMemo(() => {
    const lower = filter.trim().toLowerCase()
    if (!lower) return candidates
    return candidates.filter(
      (p) => p.name.toLowerCase().includes(lower) || p.path.toLowerCase().includes(lower)
    )
  }, [candidates, filter])

  const hasChanges = useMemo(() => {
    if (selectedIds.size !== currentMemberIds.length) return true
    return currentMemberIds.some((id) => !selectedIds.has(id))
  }, [selectedIds, currentMemberIds])

  useEffect(() => {
    if (open) {
      setSelectedIds(new Set(currentMemberIds))
      setFilter('')
      setIsSubmitting(false)
    }
  }, [open, currentMemberIds])

  const toggleProject = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const handleSave = useCallback(async () => {
    if (selectedIds.size < MIN_MEMBERS || !hasChanges) return
    setIsSubmitting(true)
    try {
      // Keep the existing order for retained members, append new ones in sidebar order —
      // the order is what the launch pipeline and the project dir's symlinks follow.
      const retained = currentMemberIds.filter((id) => selectedIds.has(id))
      const added = candidates
        .map((p) => p.id)
        .filter((id) => selectedIds.has(id) && !retained.includes(id))
      const succeeded = await updateConnectionProjectMembers(project.id, [...retained, ...added])
      if (succeeded) onOpenChange(false)
    } finally {
      setIsSubmitting(false)
    }
  }, [
    selectedIds,
    hasChanges,
    currentMemberIds,
    candidates,
    updateConnectionProjectMembers,
    project.id,
    onOpenChange
  ])

  const tooFew = selectedIds.size < MIN_MEMBERS

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="edit-connection-project-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings2 className="h-4 w-4" />
            Edit Connection
          </DialogTitle>
          <DialogDescription>
            Choose the projects that make up &ldquo;{project.name}&rdquo;. New runs use the updated
            set; instances already created keep their current worktrees.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Filter projects..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="pl-9"
            data-testid="edit-connection-project-filter"
          />
        </div>

        <div
          className="max-h-[300px] overflow-y-auto border rounded-md"
          data-testid="edit-connection-project-list"
        >
          {candidates.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              No git projects in the workspace.
            </div>
          ) : filteredCandidates.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              No projects match your filter
            </div>
          ) : (
            <div className="py-1">
              {filteredCandidates.map((p) => (
                <label
                  key={p.id}
                  className={cn(
                    'flex items-center gap-2.5 w-full px-3 py-2 text-sm cursor-pointer',
                    'hover:bg-accent/50 transition-colors',
                    selectedIds.has(p.id) && 'bg-accent/30'
                  )}
                  data-testid={`edit-connection-project-option-${p.id}`}
                >
                  <Checkbox
                    checked={selectedIds.has(p.id)}
                    onCheckedChange={() => toggleProject(p.id)}
                    data-testid={`edit-connection-project-checkbox-${p.id}`}
                  />
                  <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <div className="flex-1 min-w-0">
                    <span className="truncate block">{p.name}</span>
                    <span className="text-xs text-muted-foreground truncate block">{p.path}</span>
                  </div>
                </label>
              ))}
            </div>
          )}
        </div>

        <DialogFooter className="flex items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">
            {tooFew
              ? `Select at least ${MIN_MEMBERS} projects`
              : `${selectedIds.size} projects selected`}
          </p>
          <Button
            onClick={handleSave}
            disabled={tooFew || !hasChanges || isSubmitting}
            data-testid="edit-connection-project-save-button"
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
