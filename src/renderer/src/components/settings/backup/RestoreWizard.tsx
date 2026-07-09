import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, Circle, Loader2, XCircle } from 'lucide-react'
import type {
  BackupFile,
  BackupProject,
  ProjectClassification,
  ProjectClassificationKind,
  RestoreProjectResult,
  RestoreWorktreeResult
} from '@shared/types/backup'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { backupApi } from '@/api/backup-api'
import { projectApi } from '@/api/project-api'
import { useProjectStore, useWorktreeStore } from '@/stores'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'

export interface RestoreWizardProps {
  backup: BackupFile
  open: boolean
  onOpenChange: (open: boolean) => void
}

type Step = 'select' | 'folder' | 'run' | 'summary'

type RowRunStatus =
  | { kind: 'pending' }
  | { kind: 'running' }
  | { kind: 'not-run' }
  | { kind: 'result'; result: RestoreProjectResult }

interface ProjectRow {
  project: BackupProject
  classification: ProjectClassification | null
}

function isDisabledClassification(kind: ProjectClassificationKind): boolean {
  return kind === 'conflict' || kind === 'skipped-no-remote'
}

// POSIX basename via string split — backed-up paths always originate from the
// exporting machine's git working tree, never a Windows path.
function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  const parts = trimmed.split('/')
  return parts[parts.length - 1] || trimmed
}

const ACTION_LABELS: Record<RestoreProjectResult['action'], string> = {
  cloned: 'Cloned',
  pulled: 'Pulled',
  attached: 'Attached',
  'skipped-conflict': 'Skipped (conflict)',
  'skipped-no-remote': 'Skipped (no remote)',
  failed: 'Failed'
}

const WORKTREE_STATUS_LABELS: Record<RestoreWorktreeResult['status'], string> = {
  created: 'created',
  'skipped-existing': 'skipped (exists)',
  'created-fresh-branch': 'created fresh from default',
  failed: 'failed'
}

function ClassificationBadges({
  classification
}: {
  classification: ProjectClassification
}): React.JSX.Element {
  const warnClass = 'bg-amber-500/15 text-amber-500'
  switch (classification.classification) {
    case 'exists-match':
      return (
        <>
          <span className="shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-green-500/15 text-green-500">
            Exists — will pull
          </span>
          {classification.alreadyInHive && (
            <span className="shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-500">
              Already in Hive
            </span>
          )}
        </>
      )
    case 'missing-clone':
      return (
        <span className="shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-500">
          Will clone
        </span>
      )
    case 'conflict':
      return (
        <span className={cn('shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded', warnClass)}>
          Conflict — different repo here
        </span>
      )
    case 'skipped-no-remote':
      return (
        <span className={cn('shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded', warnClass)}>
          No remote — can&apos;t restore
        </span>
      )
    default:
      return <></>
  }
}

function ticketsSummary(tickets: RestoreProjectResult['tickets']): string | null {
  if (!tickets) return null
  if (tickets.skipped) return 'tickets skipped (already in Hive)'
  const parts = [`${tickets.restored} ticket${tickets.restored === 1 ? '' : 's'} restored`]
  if (tickets.dependencyErrors > 0) {
    parts.push(
      `${tickets.dependencyErrors} dependency error${tickets.dependencyErrors === 1 ? '' : 's'}`
    )
  }
  return parts.join(' — ')
}

export function RestoreWizard({ backup, open, onOpenChange }: RestoreWizardProps): React.JSX.Element {
  const [step, setStep] = useState<Step>('select')
  const [classifications, setClassifications] = useState<ProjectClassification[] | null>(null)
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set())
  const [cloneParentDir, setCloneParentDir] = useState<string | null>(null)
  const [rowStatuses, setRowStatuses] = useState<Map<string, RowRunStatus>>(new Map())
  const [cancelRequested, setCancelRequested] = useState(false)
  const [browsing, setBrowsing] = useState(false)

  const cancelledRef = useRef(false)
  const runStartedRef = useRef(false)

  // On mount, and whenever the backup changes, reset wizard state and classify.
  useEffect(() => {
    setStep('select')
    setClassifications(null)
    setSelectedPaths(new Set())
    setCloneParentDir(null)
    setRowStatuses(new Map())
    setCancelRequested(false)
    cancelledRef.current = false
    runStartedRef.current = false

    let cancelled = false
    const projects = backup.projects.map((p) => ({
      name: p.name,
      path: p.path,
      remoteUrl: p.remote_url
    }))

    backupApi
      .classifyProjects(projects)
      .then((result) => {
        if (cancelled) return
        setClassifications(result)
        const enabledPaths = result
          .filter((c) => !isDisabledClassification(c.classification))
          .map((c) => c.path)
        setSelectedPaths(new Set(enabledPaths))
      })
      .catch((err) => {
        if (cancelled) return
        toast.error('Failed to check project status', {
          description: err instanceof Error ? err.message : String(err)
        })
        setClassifications([])
      })

    return () => {
      cancelled = true
    }
  }, [backup])

  const rows: ProjectRow[] = useMemo(
    () =>
      backup.projects.map((project, i) => ({
        project,
        classification: classifications?.[i] ?? null
      })),
    [backup.projects, classifications]
  )

  const enabledPaths = useMemo(
    () =>
      rows
        .filter((r) => r.classification && !isDisabledClassification(r.classification.classification))
        .map((r) => r.project.path),
    [rows]
  )

  const allEnabledSelected =
    enabledPaths.length > 0 && enabledPaths.every((p) => selectedPaths.has(p))

  const toggleRow = (path: string): void => {
    setSelectedPaths((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const toggleAll = (): void => {
    setSelectedPaths(allEnabledSelected ? new Set() : new Set(enabledPaths))
  }

  const selectedRows = useMemo(
    () => rows.filter((r) => selectedPaths.has(r.project.path)),
    [rows, selectedPaths]
  )

  const toCloneRows = useMemo(
    () => selectedRows.filter((r) => r.classification?.classification === 'missing-clone'),
    [selectedRows]
  )

  const handleContinue = (): void => {
    setStep(toCloneRows.length > 0 ? 'folder' : 'run')
  }

  const handleBrowse = useCallback(async (): Promise<void> => {
    setBrowsing(true)
    try {
      const path = await projectApi.openDirectoryDialog()
      if (path) setCloneParentDir(path)
    } finally {
      setBrowsing(false)
    }
  }, [])

  const refreshStores = useCallback(async (results: RestoreProjectResult[]): Promise<void> => {
    await useProjectStore.getState().loadProjects()
    for (const result of results) {
      if (result.success && result.projectId) {
        await useWorktreeStore.getState().loadWorktrees(result.projectId, { force: true })
      }
    }
  }, [])

  const runRestore = useCallback(async (): Promise<void> => {
    const pending = new Map<string, RowRunStatus>()
    for (const r of selectedRows) pending.set(r.project.path, { kind: 'pending' })
    setRowStatuses(pending)

    const results: RestoreProjectResult[] = []

    for (let i = 0; i < selectedRows.length; i++) {
      if (cancelledRef.current) {
        setRowStatuses((prev) => {
          const next = new Map(prev)
          for (let j = i; j < selectedRows.length; j++) {
            next.set(selectedRows[j].project.path, { kind: 'not-run' })
          }
          return next
        })
        break
      }

      const { project } = selectedRows[i]
      setRowStatuses((prev) => new Map(prev).set(project.path, { kind: 'running' }))

      let result: RestoreProjectResult
      try {
        result = await backupApi.restoreProject(project, { cloneParentDir })
      } catch (err) {
        // Server contract says restoreProject never throws, but guard the RPC
        // boundary anyway (transport errors, etc.) and treat as a failed result.
        result = {
          success: false,
          projectName: project.name,
          action: 'failed',
          warnings: [],
          worktrees: [],
          tickets: null,
          error: err instanceof Error ? err.message : String(err)
        }
      }

      results.push(result)
      setRowStatuses((prev) => new Map(prev).set(project.path, { kind: 'result', result }))
    }

    await refreshStores(results)
    setStep('summary')
  }, [selectedRows, cloneParentDir, refreshStores])

  useEffect(() => {
    if (step !== 'run') return
    if (runStartedRef.current) return
    runStartedRef.current = true
    void runRestore()
  }, [step, runRestore])

  const handleCancelRemaining = (): void => {
    cancelledRef.current = true
    setCancelRequested(true)
  }

  const handleOpenChange = (next: boolean): void => {
    if (!next && step === 'run') return // not closable mid-run
    onOpenChange(next)
  }

  const handleClose = (): void => onOpenChange(false)

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        data-testid="restore-wizard"
        className="max-w-lg max-h-[85vh] flex flex-col overflow-hidden"
      >
        <DialogHeader>
          <DialogTitle>Restore from backup</DialogTitle>
          <DialogDescription>
            {step === 'select' && (
              <>
                {backup.projects.length} project{backup.projects.length === 1 ? '' : 's'} found in
                this backup.
              </>
            )}
            {step === 'folder' && (
              <>
                {toCloneRows.length} project{toCloneRows.length === 1 ? '' : 's'} will be cloned
                into the folder you choose.
              </>
            )}
            {step === 'run' && <>Restoring selected projects…</>}
            {step === 'summary' && <>Restore complete.</>}
          </DialogDescription>
        </DialogHeader>

        {step === 'select' && (
          <>
            {classifications === null ? (
              <div className="flex items-center justify-center py-10">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2 px-1 py-1 border-b">
                  <Checkbox checked={allEnabledSelected} onCheckedChange={toggleAll} />
                  <span className="text-xs text-muted-foreground font-medium">Select all</span>
                  <span className="text-xs text-muted-foreground ml-auto">
                    {selectedPaths.size} selected
                  </span>
                </div>
                <div className="flex-1 overflow-y-auto space-y-1 min-h-0">
                  {rows.map((row) => {
                    const classification = row.classification
                    if (!classification) return null
                    const disabled = isDisabledClassification(classification.classification)
                    const secondaryPath =
                      classification.effectivePath &&
                      classification.effectivePath !== row.project.path
                        ? classification.effectivePath
                        : row.project.path
                    return (
                      <label
                        key={row.project.path}
                        className={cn(
                          'flex items-start gap-2 p-2 rounded',
                          disabled ? 'opacity-60 cursor-not-allowed' : 'hover:bg-muted cursor-pointer'
                        )}
                      >
                        <Checkbox
                          checked={selectedPaths.has(row.project.path)}
                          onCheckedChange={() => toggleRow(row.project.path)}
                          disabled={disabled}
                          className="mt-0.5"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-medium truncate">{row.project.name}</span>
                            <ClassificationBadges classification={classification} />
                          </div>
                          <div className="text-xs text-muted-foreground truncate mt-0.5">
                            {secondaryPath}
                          </div>
                        </div>
                      </label>
                    )
                  })}
                </div>
              </>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={handleClose}>
                Cancel
              </Button>
              <Button onClick={handleContinue} disabled={selectedPaths.size === 0}>
                Continue
              </Button>
            </DialogFooter>
          </>
        )}

        {step === 'folder' && (
          <>
            <div className="space-y-2">
              <div className="flex gap-2">
                <Input
                  readOnly
                  value={cloneParentDir ?? ''}
                  placeholder="Select a folder…"
                  className="flex-1 cursor-pointer"
                  onClick={handleBrowse}
                  data-testid="restore-wizard-folder-input"
                />
                <Button variant="outline" onClick={handleBrowse} disabled={browsing}>
                  Browse…
                </Button>
              </div>
              {cloneParentDir && (
                <div className="text-xs text-muted-foreground space-y-0.5 max-h-40 overflow-y-auto">
                  {toCloneRows.map((row) => (
                    <div key={row.project.path} className="font-mono truncate">
                      {cloneParentDir}/{basename(row.project.path)}
                    </div>
                  ))}
                </div>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setStep('select')}>
                Back
              </Button>
              <Button onClick={() => setStep('run')} disabled={!cloneParentDir}>
                Start restore
              </Button>
            </DialogFooter>
          </>
        )}

        {step === 'run' && (
          <>
            <div className="flex-1 overflow-y-auto space-y-1 min-h-0">
              {selectedRows.map((row) => {
                const status = rowStatuses.get(row.project.path)
                return (
                  <div key={row.project.path} className="flex items-center gap-2 p-2 rounded">
                    <RunRowIcon status={status} />
                    <span
                      className={cn(
                        'text-sm truncate',
                        (!status || status.kind === 'pending') && 'text-muted-foreground'
                      )}
                    >
                      {row.project.name}
                    </span>
                    <span className="text-xs text-muted-foreground ml-auto truncate">
                      {runRowLabel(status)}
                    </span>
                  </div>
                )
              })}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={handleCancelRemaining} disabled={cancelRequested}>
                {cancelRequested ? 'Cancelling…' : 'Cancel remaining'}
              </Button>
            </DialogFooter>
          </>
        )}

        {step === 'summary' && (
          <>
            <div className="flex-1 overflow-y-auto space-y-3 min-h-0">
              {selectedRows.map((row) => {
                const status = rowStatuses.get(row.project.path)
                return (
                  <div key={row.project.path} className="border rounded p-2 space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium truncate">{row.project.name}</span>
                      {status?.kind === 'result' && (
                        <span className="text-xs text-muted-foreground">
                          {ACTION_LABELS[status.result.action]}
                        </span>
                      )}
                    </div>
                    {status?.kind === 'not-run' && (
                      <div className="text-xs text-amber-500">not restored (cancelled)</div>
                    )}
                    {status?.kind === 'result' && (
                      <>
                        {status.result.error && (
                          <div className="text-xs text-red-500">{status.result.error}</div>
                        )}
                        {status.result.worktrees.map((wt) => (
                          <div key={wt.branch} className="text-xs text-muted-foreground pl-2">
                            {wt.branch} — {WORKTREE_STATUS_LABELS[wt.status]}
                            {wt.status === 'failed' && wt.error ? `: ${wt.error}` : ''}
                          </div>
                        ))}
                        {ticketsSummary(status.result.tickets) && (
                          <div className="text-xs text-muted-foreground pl-2">
                            {ticketsSummary(status.result.tickets)}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )
              })}
              {(() => {
                const warnings = selectedRows.flatMap((row) => {
                  const status = rowStatuses.get(row.project.path)
                  if (status?.kind !== 'result') return []
                  return status.result.warnings.map((w) => ({ project: row.project.name, w }))
                })
                if (warnings.length === 0) return null
                return (
                  <div className="rounded bg-amber-500/10 border border-amber-500/30 p-2 space-y-1">
                    {warnings.map((entry, i) => (
                      <div key={i} className="text-xs text-amber-500 flex items-start gap-1">
                        <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
                        <span>
                          {entry.project}: {entry.w}
                        </span>
                      </div>
                    ))}
                  </div>
                )
              })()}
            </div>
            <DialogFooter>
              <Button onClick={handleClose}>Close</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function runRowLabel(status: RowRunStatus | undefined): string {
  if (!status) return ''
  switch (status.kind) {
    case 'pending':
      return ''
    case 'running':
      return ''
    case 'not-run':
      return 'cancelled'
    case 'result':
      if (status.result.success) {
        return ACTION_LABELS[status.result.action]
      }
      return status.result.error || ACTION_LABELS[status.result.action]
    default:
      return ''
  }
}

function RunRowIcon({ status }: { status: RowRunStatus | undefined }): React.JSX.Element {
  if (!status || status.kind === 'pending') {
    return <Circle className="h-4 w-4 shrink-0 text-muted-foreground/50" />
  }
  if (status.kind === 'running') {
    return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
  }
  if (status.kind === 'not-run') {
    return <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
  }
  if (status.result.success) {
    return <CheckCircle2 className="h-4 w-4 shrink-0 text-green-500" />
  }
  return <XCircle className="h-4 w-4 shrink-0 text-red-500" />
}
