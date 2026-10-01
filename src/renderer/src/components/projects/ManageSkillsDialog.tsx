import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { Loader2, Sparkles } from 'lucide-react'
import type { ProjectSkillsListing, SkillInfo } from '@shared/types/skills'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { projectApi } from '@/api/project-api'

interface ManageSkillsDialogProps {
  project: { id: string; name: string; path: string }
  open: boolean
  onOpenChange: (open: boolean) => void
}

// Claude Code keys a skill by its directory name (the id); the frontmatter name is only an
// alias, so the id leads and the alias follows when the two differ.
function SkillLabel({ skill }: { skill: SkillInfo }): React.JSX.Element {
  return (
    <span className="block flex-1 min-w-0">
      <span className="flex items-baseline gap-1.5 min-w-0">
        <span className="truncate">{skill.id}</span>
        {skill.name !== skill.id && (
          <span className="truncate text-xs text-muted-foreground">{skill.name}</span>
        )}
      </span>
      {skill.description && (
        <span className="block truncate text-xs text-muted-foreground" title={skill.description}>
          {skill.description}
        </span>
      )}
    </span>
  )
}

export function ManageSkillsDialog({
  project,
  open,
  onOpenChange
}: ManageSkillsDialogProps): React.JSX.Element {
  const [listing, setListing] = useState<ProjectSkillsListing | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [enabledIds, setEnabledIds] = useState<Set<string>>(new Set())
  const [isSubmitting, setIsSubmitting] = useState(false)
  // Bumped whenever the dialog closes or moves to another project, so a save that is still in
  // flight cannot close or un-spin the dialog that replaced it.
  const generationRef = useRef(0)

  const isLoading = listing === null && loadError === null

  // Load the skills each time the dialog opens (or the project changes), dropping stale responses.
  useEffect(() => {
    if (!open) return undefined

    let cancelled = false
    setListing(null)
    setLoadError(null)
    setEnabledIds(new Set())
    setIsSubmitting(false)

    projectApi
      .listSkills(project.path)
      .then((result) => {
        if (cancelled) return
        setEnabledIds(new Set(result.projectSkills.filter((s) => s.enabled).map((s) => s.id)))
        setListing(result)
      })
      .catch((error) => {
        if (cancelled) return
        setLoadError(error instanceof Error && error.message ? error.message : 'Unknown error')
      })

    return () => {
      cancelled = true
      generationRef.current += 1
    }
  }, [open, project.path])

  const projectSkills = useMemo(() => listing?.projectSkills ?? [], [listing])
  const globalSkills = listing?.globalSkills ?? []

  // The enabled set as it was loaded
  const loadedEnabledIds = useMemo(
    () => new Set(projectSkills.filter((s) => s.enabled).map((s) => s.id)),
    [projectSkills]
  )

  // Check if there are any changes from the loaded state
  const hasChanges = useMemo(() => {
    if (enabledIds.size !== loadedEnabledIds.size) return true
    for (const id of enabledIds) {
      if (!loadedEnabledIds.has(id)) return true
    }
    return false
  }, [enabledIds, loadedEnabledIds])

  const toggleSkill = useCallback((id: string) => {
    setEnabledIds((prev) => {
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
    if (!listing || !hasChanges) return
    const generation = generationRef.current
    const disabledSkills = listing.projectSkills
      .filter((s) => !enabledIds.has(s.id))
      .map((s) => s.id)
    setIsSubmitting(true)

    let succeeded = false
    let errorMessage: string | undefined
    try {
      const result = await projectApi.setDisabledSkills(project.path, disabledSkills)
      succeeded = result.success
      errorMessage = result.error
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : undefined
    }

    const isCurrent = generationRef.current === generation
    if (succeeded) {
      toast.success('Skills updated')
      if (isCurrent) onOpenChange(false)
    } else {
      toast.error(errorMessage || 'Failed to update skills')
    }
    if (isCurrent) setIsSubmitting(false)
  }, [listing, hasChanges, enabledIds, project.path, onOpenChange])

  const countText =
    listing === null
      ? ''
      : projectSkills.length === 0
        ? 'No project skills'
        : `${enabledIds.size} of ${projectSkills.length} project skill${projectSkills.length !== 1 ? 's' : ''} enabled`

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Header and footer stay pinned; only the lists scroll, so Save is reachable in short windows */}
      <DialogContent className="flex max-h-[85vh] flex-col" data-testid="manage-skills-dialog">
        <DialogHeader className="min-w-0">
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4" />
            Manage Skills
          </DialogTitle>
          <DialogDescription className="text-xs truncate" title={project.path}>
            {project.name} — {project.path}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto">
          {isLoading ? (
            <div
              className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground"
              data-testid="manage-skills-loading"
            >
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading skills...
            </div>
          ) : loadError !== null ? (
            <div
              className="min-w-0 rounded border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
              data-testid="manage-skills-load-error"
            >
              <p className="font-medium">Failed to load skills</p>
              <p className="break-words">{loadError}</p>
            </div>
          ) : (
            <>
              {/* Global skills — read-only */}
              <div className="space-y-1.5 min-w-0">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-medium">Global skills</span>
                  {globalSkills.length > 0 && (
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {globalSkills.length}
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  Installed for all projects. They can't be changed here.
                </p>
                <div
                  className="max-h-40 overflow-y-auto border rounded-md bg-muted/20"
                  data-testid="manage-skills-global-list"
                >
                  {globalSkills.length === 0 ? (
                    <div className="px-4 py-4 text-center text-sm text-muted-foreground">
                      No global skills installed.
                    </div>
                  ) : (
                    <div className="py-1">
                      {globalSkills.map((skill) => (
                        <div
                          key={skill.id}
                          className="flex items-center w-full px-3 py-1.5 text-sm text-muted-foreground"
                          data-testid={`manage-skills-global-${skill.id}`}
                        >
                          <SkillLabel skill={skill} />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Project skills — checked means enabled */}
              <div className="space-y-1.5 min-w-0">
                <span className="block text-sm font-medium">Project skills</span>
                <div
                  className="max-h-60 overflow-y-auto border rounded-md"
                  data-testid="manage-skills-project-list"
                >
                  {projectSkills.length === 0 ? (
                    <div className="px-4 py-4 text-center text-sm text-muted-foreground">
                      This project has no skills in .claude/skills.
                    </div>
                  ) : (
                    <div className="py-1">
                      {projectSkills.map((skill) => (
                        <label
                          key={skill.id}
                          className={cn(
                            'flex items-center gap-2.5 w-full px-3 py-2 text-sm cursor-pointer',
                            'hover:bg-accent/50 transition-colors',
                            !enabledIds.has(skill.id) && 'text-muted-foreground'
                          )}
                          data-testid={`manage-skills-project-${skill.id}`}
                        >
                          <Checkbox
                            checked={enabledIds.has(skill.id)}
                            onCheckedChange={() => toggleSkill(skill.id)}
                            disabled={isSubmitting}
                            data-testid={`manage-skills-checkbox-${skill.id}`}
                          />
                          <SkillLabel skill={skill} />
                        </label>
                      ))}
                    </div>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  Disabled skills are hidden from Claude Code sessions in this project.
                </p>
              </div>
            </>
          )}
        </div>

        {/* Footer with count and actions */}
        <DialogFooter className="flex items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">{countText}</p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              data-testid="manage-skills-cancel"
            >
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              disabled={listing === null || !hasChanges || isSubmitting}
              data-testid="manage-skills-save"
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
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
