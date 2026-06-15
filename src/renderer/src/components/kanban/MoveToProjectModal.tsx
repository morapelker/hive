import { useEffect, useMemo, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import type { Project } from '@shared/types/project'
import { useProjectStore } from '@/stores'
import { subsequenceMatch } from '@/lib/subsequence-match'
import { LanguageIcon } from '@/components/projects/LanguageIcon'
import { HighlightedText } from '@/components/projects/HighlightedText'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'

interface MoveToProjectModalProps {
  /** Project the ticket currently belongs to (excluded from the list). */
  currentProjectId: string
  ticketTitle: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (project: Project) => void
}

export function MoveToProjectModal({
  currentProjectId,
  ticketTitle,
  open,
  onOpenChange,
  onSelect
}: MoveToProjectModalProps): React.JSX.Element {
  const projects = useProjectStore((s) => s.projects)
  const loadProjects = useProjectStore((s) => s.loadProjects)
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  // Reset query and ensure projects are loaded each time the modal opens
  useEffect(() => {
    if (!open) return
    setQuery('')
    if (projects.length === 0) loadProjects()
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [open, projects.length, loadProjects])

  const filtered = useMemo(() => {
    const others = projects.filter((p) => p.id !== currentProjectId)
    if (!query.trim()) {
      return others.map((project) => ({ project, nameMatch: null, pathMatch: null }))
    }
    return others
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
  }, [projects, currentProjectId, query])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" data-testid="move-to-project-dialog">
        <DialogHeader>
          <DialogTitle>Move to project</DialogTitle>
          <DialogDescription className="truncate">
            Move &ldquo;{ticketTitle}&rdquo; to another project.
          </DialogDescription>
        </DialogHeader>

        <div className="relative flex items-center">
          <Search className="absolute left-3.5 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search projects..."
            className="h-8 w-full text-sm px-2 pl-8 pr-8 rounded-md border border-input bg-transparent placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            data-testid="move-to-project-search"
          />
          {query && (
            <button
              onClick={() => {
                setQuery('')
                inputRef.current?.focus()
              }}
              className="absolute right-3 h-3.5 w-3.5 flex items-center justify-center text-muted-foreground hover:text-foreground"
              data-testid="move-to-project-clear"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>

        <div className="max-h-72 overflow-y-auto -mx-1 px-1">
          {filtered.length === 0 ? (
            <div className="text-xs text-muted-foreground text-center py-6">
              {projects.length <= 1 ? 'No other projects' : 'No matching projects'}
            </div>
          ) : (
            <div className="space-y-0.5">
              {filtered.map(({ project, nameMatch, pathMatch }) => (
                <button
                  key={project.id}
                  onClick={() => onSelect(project)}
                  className="group flex w-full items-center gap-2 px-2 py-1.5 rounded-md text-left cursor-pointer transition-colors hover:bg-accent/50"
                  data-testid={`move-to-project-option-${project.id}`}
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
      </DialogContent>
    </Dialog>
  )
}
