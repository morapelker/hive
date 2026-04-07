import { useEffect, useRef, useState } from 'react'
import { X, GitPullRequest } from 'lucide-react'
import { PopoverContent } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useGitStore } from '@/stores/useGitStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import type { KanbanTicket } from '../../../../main/db/types'

interface PRItem {
  number: number
  title: string
  author: string
  headRefName: string
}

interface AttachPRPopoverProps {
  ticket: KanbanTicket
  open: boolean
  onOpenChange: (open: boolean) => void
}

function getStateBadgeClass(state: string): string {
  switch (state.toUpperCase()) {
    case 'OPEN':
      return 'bg-green-500/20 text-green-400 border border-green-500/30'
    case 'MERGED':
      return 'bg-violet-500/20 text-violet-400 border border-violet-500/30'
    case 'CLOSED':
      return 'bg-red-500/20 text-red-400 border border-red-500/30'
    default:
      return 'bg-muted/40 text-muted-foreground'
  }
}

export function AttachPRPopover({ ticket, open, onOpenChange }: AttachPRPopoverProps) {
  const [prs, setPRs] = useState<PRItem[]>([])
  const [filter, setFilter] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)

  // Looked-up PR state (for numeric input that doesn't match open PRs)
  const [lookedUpPR, setLookedUpPR] = useState<{
    number: number
    title: string
    state: string
  } | null>(null)
  const [isLookingUp, setIsLookingUp] = useState(false)

  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isAttachingRef = useRef(false)

  // ── Helpers ────────────────────────────────────────────────────────

  function buildPRUrl(prNumber: number): string {
    const worktrees =
      useWorktreeStore.getState().worktreesByProject.get(ticket.project_id) ?? []
    for (const wt of worktrees) {
      const info = useGitStore.getState().remoteInfo.get(wt.id)
      if (info?.url) {
        const match = info.url.match(/github\.com[/:]([^/]+)\/([^/.]+)/)
        if (match) return `https://github.com/${match[1]}/${match[2]}/pull/${prNumber}`
      }
    }
    return ''
  }

  function getTicketBranchName(): string {
    if (!ticket.worktree_id) return ''
    const worktrees =
      useWorktreeStore.getState().worktreesByProject.get(ticket.project_id) ?? []
    const wt = worktrees.find((w) => w.id === ticket.worktree_id)
    return wt?.branch_name ?? ''
  }

  // ── Load PR list on open ───────────────────────────────────────────
  useEffect(() => {
    if (!open) return

    let stale = false

    // Reset state each time the popover opens
    setFilter('')
    setLookedUpPR(null)
    setIsLookingUp(false)
    setSelectedIndex(0)
    setError(null)

    const project = useProjectStore.getState().projects.find((p) => p.id === ticket.project_id)
    const projectPath = project?.path
    if (!projectPath) {
      setError('Project path not found')
      return
    }

    setIsLoading(true)
    window.gitOps
      .listPRs(projectPath)
      .then((result) => {
        if (stale) return
        if (result.success) {
          const ticketBranch = getTicketBranchName()
          const sorted = [...result.prs].sort((a, b) => {
            const aMatch = ticketBranch && a.headRefName === ticketBranch ? 1 : 0
            const bMatch = ticketBranch && b.headRefName === ticketBranch ? 1 : 0
            if (aMatch !== bMatch) return bMatch - aMatch
            return b.number - a.number
          })
          setPRs(sorted)
        } else {
          setError(result.error ?? 'Failed to load PRs')
        }
      })
      .catch(() => {
        if (stale) return
        setError('Failed to load PRs')
      })
      .finally(() => {
        if (stale) return
        setIsLoading(false)
      })

    return () => {
      stale = true
    }
  }, [open, ticket.project_id, ticket.worktree_id])

  // ── Auto-focus input when open ─────────────────────────────────────
  useEffect(() => {
    if (!open) return
    // Small timeout to let the popover animate in
    const t = setTimeout(() => inputRef.current?.focus(), 50)
    return () => clearTimeout(t)
  }, [open])

  // Derived once, reused in the debounce effect below and in the render body further down
  const isNumericFilter = /^\d+$/.test(filter)

  // ── Debounced getPRState for numeric input ─────────────────────────
  useEffect(() => {
    if (!isNumericFilter || !filter) {
      setLookedUpPR(null)
      setIsLookingUp(false)
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
        debounceRef.current = null
      }
      return
    }

    const prNumber = parseInt(filter, 10)

    // If this PR is already in the open list, no need to look it up
    const alreadyInList = prs.some((p) => p.number === prNumber)
    if (alreadyInList) {
      setLookedUpPR(null)
      setIsLookingUp(false)
      return
    }

    // Debounce the lookup
    if (debounceRef.current) clearTimeout(debounceRef.current)
    setIsLookingUp(true)
    setLookedUpPR(null)

    debounceRef.current = setTimeout(async () => {
      const project = useProjectStore.getState().projects.find((p) => p.id === ticket.project_id)
      const projectPath = project?.path
      if (!projectPath) {
        setIsLookingUp(false)
        return
      }
      try {
        const result = await window.gitOps.getPRState(projectPath, prNumber)
        if (result.success && result.state && result.title) {
          setLookedUpPR({ number: prNumber, title: result.title, state: result.state })
        } else {
          setLookedUpPR(null)
        }
      } catch {
        setLookedUpPR(null)
      } finally {
        setIsLookingUp(false)
      }
    }, 400)

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [filter, isNumericFilter, prs, ticket.project_id])

  // ── Filtered PR list ───────────────────────────────────────────────
  const filteredPRs: PRItem[] = (() => {
    if (!filter) return prs
    if (isNumericFilter) {
      return prs.filter((p) => String(p.number).startsWith(filter))
    }
    const lower = filter.toLowerCase()
    return prs.filter(
      (p) =>
        p.title.toLowerCase().includes(lower) ||
        p.author.toLowerCase().includes(lower) ||
        p.headRefName.toLowerCase().includes(lower)
    )
  })()

  // Combined items: looked-up PR (if not in open list) first, then filtered open PRs
  const showLookedUp =
    lookedUpPR !== null &&
    isNumericFilter &&
    !filteredPRs.some((p) => p.number === lookedUpPR.number)

  // All selectable items for keyboard nav
  const allItems: Array<PRItem | { number: number; title: string; state: string; isLookedUp: true }> =
    [
      ...(showLookedUp ? [{ ...lookedUpPR!, isLookedUp: true as const }] : []),
      ...filteredPRs
    ]

  // ── Reset selectedIndex on filter change ──────────────────────────
  useEffect(() => {
    setSelectedIndex(0)
  }, [filter])

  // ── Scroll selected item into view ────────────────────────────────
  useEffect(() => {
    if (!listRef.current) return
    const items = listRef.current.querySelectorAll('[data-pr-item]')
    const item = items[selectedIndex]
    if (item && typeof item.scrollIntoView === 'function') {
      item.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedIndex])

  // ── Keyboard navigation ────────────────────────────────────────────
  useEffect(() => {
    if (!open) return

    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        e.stopPropagation()
        setSelectedIndex((prev) => Math.min(prev + 1, allItems.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        e.stopPropagation()
        setSelectedIndex((prev) => Math.max(prev - 1, 0))
      } else if (e.key === 'Enter' && allItems.length > 0) {
        e.preventDefault()
        e.stopPropagation()
        const item = allItems[selectedIndex]
        if (item) handleAttach({ number: item.number, title: item.title })
      } else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onOpenChange(false)
      }
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [open, allItems, selectedIndex, onOpenChange])

  // ── Handlers ──────────────────────────────────────────────────────

  const handleAttach = async (pr: { number: number; title: string }) => {
    if (isAttachingRef.current) return
    isAttachingRef.current = true
    const prUrl = buildPRUrl(pr.number)
    // Optimistic update
    useKanbanStore.getState().attachPRToTicket(ticket.id, ticket.project_id, pr.number, prUrl)
    try {
      await window.kanban.ticket.attachPR(ticket.id, ticket.project_id, pr.number, prUrl)
      toast.success(`PR #${pr.number} attached`)
    } catch {
      // Rollback
      useKanbanStore.getState().detachPRFromTicket(ticket.id, ticket.project_id)
      toast.error('Failed to attach PR')
    } finally {
      isAttachingRef.current = false
    }
    onOpenChange(false)
  }

  const handleDetach = async () => {
    if (isAttachingRef.current) return
    isAttachingRef.current = true
    const prev = { number: ticket.github_pr_number!, url: ticket.github_pr_url! }
    // Optimistic
    useKanbanStore.getState().detachPRFromTicket(ticket.id, ticket.project_id)
    try {
      await window.kanban.ticket.detachPR(ticket.id, ticket.project_id)
      toast.success('PR detached')
    } catch {
      // Rollback
      useKanbanStore
        .getState()
        .attachPRToTicket(ticket.id, ticket.project_id, prev.number, prev.url)
      toast.error('Failed to detach PR')
    } finally {
      isAttachingRef.current = false
    }
    onOpenChange(false)
  }

  // ── Render ─────────────────────────────────────────────────────────

  return (
    <PopoverContent className="w-80 p-0" side="right" align="start">
      {/* Current PR section */}
      {ticket.github_pr_number && (
        <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
          <div className="flex items-center gap-1.5 min-w-0">
            <GitPullRequest className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="text-xs text-muted-foreground truncate">
              Current PR:{' '}
              <span className="font-medium text-foreground">#{ticket.github_pr_number}</span>
            </span>
          </div>
          <button
            onClick={handleDetach}
            title="Detach PR"
            className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Search input */}
      <div className="px-3 py-2 border-b">
        <input
          ref={inputRef}
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search PRs or enter a number..."
          className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
      </div>

      {/* PR list */}
      <div ref={listRef} className="max-h-64 overflow-y-auto">
        {isLoading ? (
          <div className="px-3 py-4 text-xs text-muted-foreground text-center">Loading PRs…</div>
        ) : error ? (
          <div className="px-3 py-4 text-xs text-red-500 text-center">{error}</div>
        ) : (
          <>
            {/* Looked-up PR (numeric search, not in open list) */}
            {isNumericFilter && isLookingUp && !lookedUpPR && (
              <div className="px-3 py-2 text-xs text-muted-foreground">Looking up PR…</div>
            )}

            {showLookedUp && lookedUpPR && (
              <div
                key={`looked-up-${lookedUpPR.number}`}
                data-pr-item
                className={cn(
                  'flex flex-col gap-0.5 px-3 py-2 cursor-pointer text-sm transition-colors',
                  0 === selectedIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-muted/40'
                )}
                onMouseEnter={() => setSelectedIndex(0)}
                onClick={() => handleAttach({ number: lookedUpPR.number, title: lookedUpPR.title })}
              >
                <div className="flex items-center gap-2">
                  <span className="font-medium truncate">
                    #{lookedUpPR.number} — {lookedUpPR.title}
                  </span>
                  <span
                    className={cn(
                      'ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium',
                      getStateBadgeClass(lookedUpPR.state)
                    )}
                  >
                    {lookedUpPR.state.toUpperCase()}
                  </span>
                </div>
              </div>
            )}

            {/* Open PR list */}
            {filteredPRs.length === 0 && !showLookedUp && !isLookingUp ? (
              <div className="px-3 py-4 text-xs text-muted-foreground text-center">
                {prs.length === 0 ? 'No open PRs found' : 'No matching PRs'}
              </div>
            ) : (
              filteredPRs.map((pr, idx) => {
                const itemIndex = showLookedUp ? idx + 1 : idx
                return (
                  <div
                    key={pr.number}
                    data-pr-item
                    className={cn(
                      'flex flex-col gap-0.5 px-3 py-2 cursor-pointer text-sm transition-colors',
                      itemIndex === selectedIndex
                        ? 'bg-accent text-accent-foreground'
                        : 'hover:bg-muted/40'
                    )}
                    onMouseEnter={() => setSelectedIndex(itemIndex)}
                    onClick={() => handleAttach(pr)}
                  >
                    <span className="font-medium truncate">
                      #{pr.number} — {pr.title}
                    </span>
                    <span
                      className={cn(
                        'text-xs truncate',
                        itemIndex === selectedIndex
                          ? 'text-accent-foreground/70'
                          : 'text-muted-foreground'
                      )}
                    >
                      {pr.headRefName} @{pr.author}
                    </span>
                  </div>
                )
              })
            )}
          </>
        )}
      </div>
    </PopoverContent>
  )
}
