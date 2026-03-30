import { useState, useEffect, useRef } from 'react'
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

interface JiraImportModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
}

const PER_PAGE = 30

export function JiraImportModal({ open, onOpenChange, projectId }: JiraImportModalProps) {
  const loadTickets = useKanbanStore((s) => s.loadTickets)

  const [domain, setDomain] = useState<string | null>(null)
  const [jqlInput, setJqlInput] = useState('')
  const [committedJql, setCommittedJql] = useState<string | null>(null)

  const [issues, setIssues] = useState<RemoteIssue[]>([])
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [hasNextPage, setHasNextPage] = useState(false)
  const [jqlError, setJqlError] = useState<string | null>(null)

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [importing, setImporting] = useState(false)
  const [importProgress, setImportProgress] = useState<{ current: number; total: number } | null>(null)

  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Read domain from settings on open
  useEffect(() => {
    if (!open) return
    const settings = getProviderSettings()
    setDomain(settings.jira_domain ?? null)
    setJqlInput('')
    setCommittedJql(null)
    setIssues([])
    setSelected(new Set())
    setPage(1)
    setJqlError(null)
    setImportProgress(null)
    setTimeout(() => textareaRef.current?.focus(), 0)
  }, [open])

  // Fetch issues when committed JQL / page changes
  useEffect(() => {
    if (!open || !domain || committedJql === null) return
    setLoading(true)
    setJqlError(null)

    window.ticketImport
      .listIssues(
        'jira',
        domain,
        { page, perPage: PER_PAGE, state: 'all', search: committedJql },
        getProviderSettings()
      )
      .then((result) => {
        setIssues(result.issues)
        setHasNextPage(result.hasNextPage)
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        setJqlError(message)
        setIssues([])
        setHasNextPage(false)
      })
      .finally(() => setLoading(false))
  }, [open, domain, committedJql, page])

  const handleSearch = () => {
    const trimmed = jqlInput.trim()
    if (!trimmed) return
    setPage(1)
    setCommittedJql(trimmed)
  }

  const handleTextareaKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleSearch()
    }
  }

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
    if (!domain || selected.size === 0) return
    setImporting(true)

    const toImport = issues.filter((i) => selected.has(i.externalId))
    setImportProgress({ current: 0, total: toImport.length })

    try {
      const result = await window.ticketImport.importIssues(
        'jira',
        projectId,
        domain,
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
      if (result.imported.length > 0)
        msgs.push(`Imported ${result.imported.length} issue${result.imported.length > 1 ? 's' : ''}`)
      if (result.skipped.length > 0)
        msgs.push(`Skipped ${result.skipped.length} duplicate${result.skipped.length > 1 ? 's' : ''}`)
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

  const stateBadgeClass = (state: RemoteIssue['state']) => {
    if (state === 'open') return 'bg-green-500/10 text-green-500'
    if (state === 'in_progress') return 'bg-amber-500/10 text-amber-500'
    return 'bg-purple-500/10 text-purple-500'
  }

  const stateLabel = (state: RemoteIssue['state']) => {
    if (state === 'in_progress') return 'in progress'
    return state
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl h-[70vh] flex flex-col p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-4 pt-4 pb-3 border-b shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <ProviderIcon provider="jira" />
            Import from Jira
            {domain && (
              <span className="text-xs font-normal text-muted-foreground ml-1">
                {domain}
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 min-h-0 flex flex-col">
          {/* Not configured */}
          {!domain && (
            <div className="flex flex-col items-center justify-center gap-3 p-8 text-sm text-center text-muted-foreground">
              <AlertCircle className="h-6 w-6 text-amber-500 shrink-0" />
              <p>
                Jira is not configured.{' '}
                <span className="text-foreground">
                  Go to <strong>Settings &gt; Integrations</strong> to add your Jira domain, email,
                  and API token.
                </span>
              </p>
            </div>
          )}

          {/* JQL search area */}
          {domain && (
            <>
              <div className="px-4 pt-3 pb-2 border-b shrink-0 flex flex-col gap-2">
                <textarea
                  ref={textareaRef}
                  value={jqlInput}
                  onChange={(e) => setJqlInput(e.target.value)}
                  onKeyDown={handleTextareaKeyDown}
                  placeholder={`e.g., project = PROJ AND sprint in openSprints()`}
                  rows={2}
                  className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                />
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-muted-foreground">
                    Press{' '}
                    <kbd className="px-1 py-0.5 rounded border border-border text-[10px] font-mono">
                      ⌘↵
                    </kbd>{' '}
                    or{' '}
                    <kbd className="px-1 py-0.5 rounded border border-border text-[10px] font-mono">
                      Ctrl↵
                    </kbd>{' '}
                    to search
                  </span>
                  <Button
                    size="sm"
                    variant="default"
                    onClick={handleSearch}
                    disabled={loading || !jqlInput.trim()}
                    className="h-7 text-xs"
                  >
                    <Search className="h-3 w-3 mr-1.5" />
                    Search
                  </Button>
                </div>

                {/* JQL error */}
                {jqlError && (
                  <div className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                    <span>{jqlError}</span>
                  </div>
                )}
              </div>

              {/* Issues list */}
              <div className="flex-1 overflow-y-auto">
                {loading ? (
                  <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading issues...
                  </div>
                ) : committedJql === null ? (
                  <div className="flex items-center justify-center p-8 text-sm text-muted-foreground">
                    Enter a JQL query above and click Search.
                  </div>
                ) : issues.length === 0 && !jqlError ? (
                  <div className="flex items-center justify-center p-8 text-sm text-muted-foreground">
                    No issues found.
                  </div>
                ) : issues.length > 0 ? (
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
                              {issue.externalId}
                            </span>
                            <span
                              className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${stateBadgeClass(issue.state)}`}
                            >
                              {stateLabel(issue.state)}
                            </span>
                          </div>
                          <p className="text-sm font-medium truncate mt-0.5">{issue.title}</p>
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
                ) : null}
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
            disabled={selected.size === 0 || importing || !domain}
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
