import { useState, useEffect } from 'react'
import { Download, Search, ExternalLink, Loader2, AlertCircle, ChevronLeft, ChevronRight } from 'lucide-react'
import { ProviderIcon } from '@/components/ui/provider-icon'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { useKanbanStore } from '@/stores/useKanbanStore'
import { getProviderSettings } from '@/lib/provider-settings'
import { toast } from 'sonner'

interface RemoteIssue {
  externalId: string
  title: string
  body: string | null
  state: 'open' | 'closed' | 'in_progress'
  url: string
  createdAt: string
  updatedAt: string
}

interface ImportTicketsModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  projectPath: string
}

const PER_PAGE = 30

export function ImportTicketsModal({
  open,
  onOpenChange,
  projectId,
  projectPath
}: ImportTicketsModalProps) {
  const loadTickets = useKanbanStore((s) => s.loadTickets)

  const [repo, setRepo] = useState<string | null>(null)
  const [manualRepo, setManualRepo] = useState('')
  const [detectingRepo, setDetectingRepo] = useState(false)
  const [detectionFailed, setDetectionFailed] = useState(false)

  const [issues, setIssues] = useState<RemoteIssue[]>([])
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [hasNextPage, setHasNextPage] = useState(false)
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [showClosed, setShowClosed] = useState(false)

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [importing, setImporting] = useState(false)
  const [importProgress, setImportProgress] = useState<{ current: number; total: number } | null>(null)

  const effectiveRepo = repo ?? (manualRepo.includes('/') ? manualRepo.trim() : null)

  // Auto-detect repo on open
  useEffect(() => {
    if (!open) return
    setDetectingRepo(true)
    setDetectionFailed(false)
    setRepo(null)
    setManualRepo('')
    setIssues([])
    setSelected(new Set())
    setPage(1)
    setSearch('')
    setSearchInput('')
    setShowClosed(false)
    setImportProgress(null)

    window.ticketImport
      .detectRepo('github', projectPath)
      .then(({ repo: detected }) => {
        if (detected) {
          setRepo(detected)
        } else {
          setDetectionFailed(true)
        }
      })
      .catch(() => setDetectionFailed(true))
      .finally(() => setDetectingRepo(false))
  }, [open, projectPath])

  // Fetch issues when repo/page/search/showClosed changes
  useEffect(() => {
    if (!open || !effectiveRepo) return
    setLoading(true)
    const state = showClosed ? 'all' : 'open'

    window.ticketImport
      .listIssues('github', effectiveRepo, { page, perPage: PER_PAGE, state, search: search || undefined }, getProviderSettings())
      .then((result) => {
        setIssues(result.issues)
        setHasNextPage(result.hasNextPage)
      })
      .catch((err) => {
        console.error('Failed to fetch issues:', err)
        toast.error('Failed to fetch issues. Check your GitHub authentication.')
        setIssues([])
      })
      .finally(() => setLoading(false))
  }, [open, effectiveRepo, page, search, showClosed])

  // Search debounce
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput)
      setPage(1)
    }, 300)
    return () => clearTimeout(timer)
  }, [searchInput])

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleSelectAll = () => {
    if (selected.size === issues.length) {
      setSelected(new Set())
    } else {
      setSelected(new Set(issues.map((i) => i.externalId)))
    }
  }

  const handleImport = async () => {
    if (!effectiveRepo || selected.size === 0) return
    setImporting(true)

    const toImport = issues.filter((i) => selected.has(i.externalId))
    setImportProgress({ current: 0, total: toImport.length })

    try {
      const result = await window.ticketImport.importIssues(
        'github',
        projectId,
        effectiveRepo,
        toImport.map((i) => ({
          externalId: i.externalId,
          title: i.title,
          body: i.body,
          state: i.state,
          url: i.url
        }))
      )

      setImportProgress({ current: toImport.length, total: toImport.length })

      const msgs: string[] = []
      if (result.imported.length > 0) msgs.push(`Imported ${result.imported.length} issue${result.imported.length > 1 ? 's' : ''}`)
      if (result.skipped.length > 0) msgs.push(`Skipped ${result.skipped.length} duplicate${result.skipped.length > 1 ? 's' : ''}`)
      toast.success(msgs.join('. '))

      await loadTickets(projectId)
      onOpenChange(false)
    } catch (err) {
      toast.error(`Import failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setImporting(false)
      setImportProgress(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl h-[70vh] flex flex-col p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-4 pt-4 pb-3 border-b shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <ProviderIcon provider="github" />
            Import from GitHub
            {effectiveRepo && (
              <span className="text-xs font-normal text-muted-foreground ml-1">
                {effectiveRepo}
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 min-h-0 flex flex-col">
          {/* Repo detection / manual entry */}
          {detectingRepo && (
            <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Detecting GitHub repository...
            </div>
          )}

          {detectionFailed && !repo && (
            <div className="px-4 pt-3">
              <div className="flex items-center gap-2 text-sm text-amber-500 mb-2">
                <AlertCircle className="h-4 w-4 shrink-0" />
                No GitHub remote detected.
              </div>
              <Input
                placeholder="Enter repository (owner/repo)"
                value={manualRepo}
                onChange={(e) => setManualRepo(e.target.value)}
                className="text-sm"
              />
            </div>
          )}

          {/* Search + filters */}
          {effectiveRepo && !detectingRepo && (
            <>
              <div className="flex items-center gap-2 px-4 py-2 border-b shrink-0">
                <div className="relative flex-1">
                  <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                  <Input
                    placeholder="Search issues..."
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                    className="pl-8 h-8 text-sm"
                  />
                </div>
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
                  <Checkbox
                    checked={showClosed}
                    onCheckedChange={(checked) => {
                      setShowClosed(checked === true)
                      setPage(1)
                    }}
                  />
                  Show closed
                </label>
              </div>

              {/* Issues list */}
              <div className="flex-1 overflow-y-auto">
                {loading ? (
                  <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading issues...
                  </div>
                ) : issues.length === 0 ? (
                  <div className="flex items-center justify-center p-8 text-sm text-muted-foreground">
                    No issues found.
                  </div>
                ) : (
                  <div className="divide-y">
                    {/* Select all header */}
                    <div className="flex items-center gap-3 px-4 py-2 bg-muted/30 sticky top-0 z-10">
                      <Checkbox
                        checked={selected.size === issues.length && issues.length > 0}
                        onCheckedChange={toggleSelectAll}
                      />
                      <span className="text-xs text-muted-foreground">
                        {selected.size > 0 ? `${selected.size} selected` : 'Select all'}
                      </span>
                    </div>

                    {issues.map((issue) => (
                      <div
                        key={issue.externalId}
                        className="flex items-start gap-3 px-4 py-2.5 hover:bg-muted/20 cursor-pointer transition-colors"
                        onClick={() => toggleSelect(issue.externalId)}
                      >
                        <Checkbox
                          checked={selected.has(issue.externalId)}
                          onCheckedChange={() => toggleSelect(issue.externalId)}
                          className="mt-0.5"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-muted-foreground font-mono">
                              #{issue.externalId}
                            </span>
                            <span
                              className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                                issue.state === 'open'
                                  ? 'bg-green-500/10 text-green-500'
                                  : 'bg-purple-500/10 text-purple-500'
                              }`}
                            >
                              {issue.state}
                            </span>
                          </div>
                          <p className="text-sm font-medium truncate mt-0.5">
                            {issue.title}
                          </p>
                        </div>
                        <a
                          href={issue.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="text-muted-foreground hover:text-foreground shrink-0 mt-0.5"
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Pagination */}
              {(page > 1 || hasNextPage) && (
                <div className="flex items-center justify-between px-4 py-2 border-t shrink-0">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={page <= 1 || loading}
                    onClick={() => setPage((p) => p - 1)}
                  >
                    <ChevronLeft className="h-3.5 w-3.5 mr-1" />
                    Previous
                  </Button>
                  <span className="text-xs text-muted-foreground">Page {page}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!hasNextPage || loading}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    Next
                    <ChevronRight className="h-3.5 w-3.5 ml-1" />
                  </Button>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <DialogFooter className="px-4 py-3 border-t shrink-0">
          {importProgress && (
            <div className="flex-1 flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Importing {importProgress.current}/{importProgress.total}...
            </div>
          )}
          <Button
            onClick={handleImport}
            disabled={selected.size === 0 || importing || !effectiveRepo}
            size="sm"
          >
            <Download className="h-3.5 w-3.5 mr-1.5" />
            Import {selected.size > 0 ? `(${selected.size})` : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
