import { useEffect, useMemo, useRef, useState } from 'react'
import { Braces, Search, Target, X } from 'lucide-react'
import type { Project } from '@shared/types/project'
import type { FavoriteTicket } from '../../../../main/db/types'
import { extractPlaceholderNames, substitutePlaceholders } from '@shared/lib/ticket-placeholders'
import { useProjectStore } from '@/stores'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { subsequenceMatch } from '@/lib/subsequence-match'
import { LanguageIcon } from '@/components/projects/LanguageIcon'
import { HighlightedText } from '@/components/projects/HighlightedText'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'

interface FavoriteTicketCreateModalProps {
  favorite: FavoriteTicket | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * Instantiates a favorite ticket template into a project: pick a project (and
 * fill any {{placeholder.x}} values first) to create the ticket there.
 */
export function FavoriteTicketCreateModal({
  favorite,
  open,
  onOpenChange
}: FavoriteTicketCreateModalProps): React.JSX.Element {
  const projects = useProjectStore((s) => s.projects)
  const loadProjects = useProjectStore((s) => s.loadProjects)
  const [query, setQuery] = useState('')
  const [placeholderValues, setPlaceholderValues] = useState<Record<string, string>>({})
  const [isCreating, setIsCreating] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const firstPlaceholderRef = useRef<HTMLInputElement>(null)
  // Bumped on every open so a create that outlives a dismiss-and-reopen can
  // tell it is stale and must not close the newly opened dialog
  const openSessionRef = useRef(0)

  const placeholderNames = useMemo(
    () =>
      favorite
        ? extractPlaceholderNames(
            favorite.title,
            favorite.description,
            favorite.goal_mode ? favorite.goal_success_criteria : null
          )
        : [],
    [favorite]
  )
  const hasPlaceholderInputs = placeholderNames.length > 0
  // Own-property access: placeholder names like "constructor" must not fall
  // through to Object.prototype members
  const valueFor = (name: string): string =>
    Object.prototype.hasOwnProperty.call(placeholderValues, name) ? placeholderValues[name] : ''
  const allPlaceholdersFilled = placeholderNames.every((name) => valueFor(name).trim().length > 0)

  // Reset state each time the modal opens (keyed on open only — a projects
  // reload while typing must not wipe entered placeholder values)
  useEffect(() => {
    if (!open) return
    openSessionRef.current++
    setQuery('')
    setPlaceholderValues({})
    setIsCreating(false)
    requestAnimationFrame(() => {
      if (firstPlaceholderRef.current) firstPlaceholderRef.current.focus()
      else inputRef.current?.focus()
    })
  }, [open])

  // Ensure projects are loaded while the modal is open
  useEffect(() => {
    if (!open) return
    if (projects.length === 0) loadProjects()
  }, [open, projects.length, loadProjects])

  const filtered = useMemo(() => {
    if (!query.trim()) {
      return projects.map((project) => ({ project, nameMatch: null, pathMatch: null }))
    }
    return projects
      .map((project) => ({
        project,
        nameMatch: subsequenceMatch(query, project.name),
        pathMatch: subsequenceMatch(query, project.path)
      }))
      .filter(({ nameMatch, pathMatch }) => nameMatch.matched || pathMatch.matched)
      .sort((a, b) => {
        const aScore = a.nameMatch.matched ? a.nameMatch.score : a.pathMatch.score + 1000
        const bScore = b.nameMatch.matched ? b.nameMatch.score : b.pathMatch.score + 1000
        return aScore - bScore
      })
  }, [projects, query])

  const handleSelectProject = async (project: Project): Promise<void> => {
    if (!favorite || isCreating || !allPlaceholdersFilled) return
    setIsCreating(true)
    const session = openSessionRef.current
    // Only close if the dialog wasn't dismissed and reopened meanwhile
    const closeIfCurrent = (): void => {
      if (openSessionRef.current === session) {
        onOpenChange(false)
      }
    }
    try {
      const store = useKanbanStore.getState()
      const title = substitutePlaceholders(favorite.title, placeholderValues).trim()
      const description = favorite.description
        ? substitutePlaceholders(favorite.description, placeholderValues)
        : null
      const created = await store.createTicket(project.id, {
        project_id: project.id,
        title,
        description: description?.trim() || null,
        column: 'todo'
      })
      // Goal fields aren't part of the create payload — mirror them after
      // creation. The ticket already exists past this point, so a failed
      // mirror must not read as a failed create (or invite a duplicate retry).
      if (favorite.goal_mode || favorite.goal_success_criteria) {
        try {
          await store.updateTicket(created.id, project.id, {
            goal_mode: favorite.goal_mode,
            goal_success_criteria: favorite.goal_success_criteria
              ? substitutePlaceholders(favorite.goal_success_criteria, placeholderValues)
              : null
          })
        } catch {
          toast.error(
            `Ticket created in ${project.name}, but its goal settings could not be applied`
          )
          closeIfCurrent()
          return
        }
      }
      toast.success(`Ticket created in ${project.name}`)
      closeIfCurrent()
    } catch {
      toast.error('Failed to create ticket')
    } finally {
      // A stale completion must not clear the busy flag of a newer session —
      // that would drop the double-submit guard while its request is in flight
      if (openSessionRef.current === session) {
        setIsCreating(false)
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(hasPlaceholderInputs ? 'sm:max-w-2xl' : 'sm:max-w-md')}
        data-testid="favorite-ticket-create-modal"
      >
        {/* min-w-0: grid items default to min-width:auto, so an unbreakable
            project name/title would widen the track past the overflow-hidden
            dialog and clip the whole body */}
        <DialogHeader className="min-w-0">
          <DialogTitle className="truncate">{favorite?.title ?? 'Create ticket'}</DialogTitle>
          <DialogDescription>
            {hasPlaceholderInputs
              ? 'Fill in the placeholders, then pick a project to create this ticket in.'
              : 'Pick a project to create this ticket in.'}
          </DialogDescription>
        </DialogHeader>

        <div
          className={cn(
            'flex gap-4 min-h-0 min-w-0',
            hasPlaceholderInputs && 'sm:flex-row flex-col'
          )}
        >
          {/* Project picker */}
          <div className="flex-1 min-w-0 space-y-3">
            <div className="relative flex items-center">
              <Search className="absolute left-3.5 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search projects..."
                className="h-8 w-full text-sm px-2 pl-8 pr-8 rounded-md border border-input bg-transparent placeholder:text-muted-foreground focus-visible:outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                data-testid="favorite-project-search"
              />
              {query && (
                <button
                  onClick={() => {
                    setQuery('')
                    inputRef.current?.focus()
                  }}
                  className="absolute right-3 h-3.5 w-3.5 flex items-center justify-center text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>

            <div className="max-h-72 overflow-y-auto overflow-x-hidden -mx-1 px-1">
              {filtered.length === 0 ? (
                <div className="text-xs text-muted-foreground text-center py-6">
                  {projects.length === 0 ? 'No projects' : 'No matching projects'}
                </div>
              ) : (
                <div className="space-y-0.5">
                  {filtered.map(({ project, nameMatch, pathMatch }) => (
                    <button
                      key={project.id}
                      onClick={() => void handleSelectProject(project)}
                      disabled={isCreating || !allPlaceholdersFilled}
                      className="group flex w-full items-center gap-2 px-2 py-1.5 rounded-md text-left cursor-pointer transition-colors hover:bg-accent/50 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                      data-testid={`favorite-project-option-${project.id}`}
                    >
                      <LanguageIcon
                        language={project.language}
                        customIcon={project.custom_icon}
                        detectedIcon={project.detected_icon}
                      />
                      <div className="flex-1 min-w-0">
                        {nameMatch?.matched ? (
                          <HighlightedText
                            text={project.name}
                            indices={nameMatch.indices}
                            className="text-sm truncate block"
                          />
                        ) : (
                          <span className="text-sm truncate block" title={project.path}>
                            {project.name}
                          </span>
                        )}
                        {pathMatch?.matched && !nameMatch?.matched && (
                          <HighlightedText
                            text={project.path}
                            indices={pathMatch.indices}
                            className="text-[10px] text-muted-foreground truncate block"
                          />
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Placeholder inputs */}
          {hasPlaceholderInputs && (
            <div className="sm:w-64 min-w-0 shrink-0 space-y-3 sm:border-l sm:border-border sm:pl-4">
              <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                <Braces className="h-3.5 w-3.5" />
                Placeholders
              </div>
              <div className="space-y-2.5 max-h-72 overflow-y-auto -mx-1 px-1">
                {placeholderNames.map((name, index) => (
                  <div key={name} className="space-y-1">
                    <label
                      htmlFor={`favorite-placeholder-${name}`}
                      className="text-xs font-medium text-foreground break-all"
                    >
                      {name} <span className="text-destructive">*</span>
                    </label>
                    <Input
                      id={`favorite-placeholder-${name}`}
                      ref={index === 0 ? firstPlaceholderRef : undefined}
                      data-testid={`favorite-placeholder-input-${name}`}
                      value={valueFor(name)}
                      onChange={(e) =>
                        setPlaceholderValues((prev) => ({ ...prev, [name]: e.target.value }))
                      }
                      placeholder={`Value for {{placeholder.${name}}}`}
                      className="h-8 text-sm"
                    />
                  </div>
                ))}
              </div>
              {!allPlaceholdersFilled && (
                <p className="text-xs text-muted-foreground">
                  Fill in every placeholder to enable project selection.
                </p>
              )}
              {favorite?.goal_mode && favorite.goal_success_criteria && (
                <div className="flex items-start gap-1.5 rounded-md border border-border/50 bg-muted/20 px-2 py-1.5 text-xs text-muted-foreground">
                  <Target className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                  <span className="min-w-0 line-clamp-3 break-words [overflow-wrap:anywhere]">
                    Goal: {favorite.goal_success_criteria}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
