import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Loader2, Lock, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { useProjectStore } from '@/stores'
import { projectToast } from '@/lib/toast'
import { projectApi } from '@/api/project-api'
import { githubApi, type GithubRepo } from '@/api/github-api'

interface AddRepositoryDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

interface CloneProgress {
  stage: string
  percent: number
}

const MAX_VISIBLE_REPOS = 100

export function AddRepositoryDialog({
  open,
  onOpenChange
}: AddRepositoryDialogProps): React.JSX.Element {
  const [repos, setRepos] = useState<GithubRepo[]>([])
  const [isLoadingRepos, setIsLoadingRepos] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [selectedRepo, setSelectedRepo] = useState<GithubRepo | null>(null)
  const [destination, setDestination] = useState<string | null>(null)
  const [isCloning, setIsCloning] = useState(false)
  const [progress, setProgress] = useState<CloneProgress>({ stage: '', percent: 0 })
  const [cloneError, setCloneError] = useState<string | null>(null)
  const { addProject } = useProjectStore()

  const operationIdRef = useRef<string | null>(null)
  const unsubscribeRef = useRef<(() => void) | null>(null)

  const stopListening = useCallback((): void => {
    unsubscribeRef.current?.()
    unsubscribeRef.current = null
    operationIdRef.current = null
  }, [])

  const loadRepositories = useCallback(async (): Promise<void> => {
    setIsLoadingRepos(true)
    setLoadError(null)
    try {
      const result = await githubApi.listRepositories()
      if (!result.success) {
        setLoadError(result.error || 'Failed to list repositories.')
        setRepos([])
        return
      }
      setRepos(result.repos)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to list repositories.')
      setRepos([])
    } finally {
      setIsLoadingRepos(false)
    }
  }, [])

  useEffect(() => {
    if (open) {
      setSearch('')
      setSelectedRepo(null)
      setCloneError(null)
      setIsCloning(false)
      setProgress({ stage: '', percent: 0 })
      void loadRepositories()
    }
    return () => {
      stopListening()
    }
  }, [open, loadRepositories, stopListening])

  const filteredRepos = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return repos
    return repos.filter(
      (repo) =>
        repo.nameWithOwner.toLowerCase().includes(query) ||
        (repo.description ?? '').toLowerCase().includes(query)
    )
  }, [repos, search])

  // Accounts with hundreds of repos would otherwise mount one node per repo.
  const visibleRepos = useMemo(() => filteredRepos.slice(0, MAX_VISIBLE_REPOS), [filteredRepos])

  const handleBrowse = useCallback(async (): Promise<void> => {
    const selectedPath = await projectApi.openDirectoryDialog()
    if (selectedPath) {
      setDestination(selectedPath)
      setCloneError(null)
    }
  }, [])

  const repoFolderName = selectedRepo?.nameWithOwner.split('/')[1] ?? null
  const clonePath = destination && repoFolderName ? `${destination}/${repoFolderName}` : null

  const finishAdd = useCallback(
    async (path: string): Promise<void> => {
      setProgress({ stage: 'Adding project…', percent: 100 })
      const addResult = await addProject(path)
      setIsCloning(false)
      if (!addResult.success) {
        setCloneError(
          `${addResult.error || 'Failed to add project.'} The repository was cloned to ${path} — you can add it with "Add existing project".`
        )
        return
      }
      projectToast.added(path.split('/').pop() || path)
      onOpenChange(false)
    },
    [addProject, onOpenChange]
  )

  const handleClone = useCallback(async (): Promise<void> => {
    if (!selectedRepo || !destination || isCloning) return

    const operationId = crypto.randomUUID()
    operationIdRef.current = operationId
    setIsCloning(true)
    setCloneError(null)
    setProgress({ stage: 'Starting clone…', percent: 0 })

    // Subscribe before starting so fast failures are not missed.
    unsubscribeRef.current = githubApi.onCloneProgress((event) => {
      if (event.operationId !== operationIdRef.current) return
      if (event.type === 'progress') {
        setProgress({ stage: event.stage ?? 'Cloning…', percent: event.percent ?? 0 })
      } else if (event.type === 'done' && event.path) {
        stopListening()
        void finishAdd(event.path)
      } else {
        stopListening()
        setIsCloning(false)
        setCloneError(event.error || 'Clone failed.')
      }
    })

    try {
      const result = await githubApi.cloneRepository({
        nameWithOwner: selectedRepo.nameWithOwner,
        parentPath: destination,
        operationId
      })
      if (!result.success) {
        stopListening()
        setIsCloning(false)
        setCloneError(result.error || 'Failed to start clone.')
      }
    } catch (err) {
      stopListening()
      setIsCloning(false)
      setCloneError(err instanceof Error ? err.message : 'Failed to start clone.')
    }
  }, [selectedRepo, destination, isCloning, stopListening, finishAdd])

  const handleCancelClone = useCallback((): void => {
    const operationId = operationIdRef.current
    stopListening()
    setIsCloning(false)
    setProgress({ stage: '', percent: 0 })
    if (operationId) {
      void githubApi.cancelClone(operationId)
    }
  }, [stopListening])

  const handleOpenChange = useCallback(
    (isOpen: boolean): void => {
      if (!isOpen && isCloning) {
        handleCancelClone()
      }
      onOpenChange(isOpen)
    },
    [isCloning, handleCancelClone, onOpenChange]
  )

  const canClone = !!selectedRepo && !!destination && !isCloning

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="add-repository-dialog">
        <DialogHeader>
          <DialogTitle>Add Repository</DialogTitle>
          <DialogDescription>
            Clone a GitHub repository and add it to your projects.
          </DialogDescription>
        </DialogHeader>

        {isCloning ? (
          // min-w-0 keeps long repo names from widening the dialog's grid track.
          <div className="min-w-0 space-y-3 py-2" data-testid="clone-progress">
            <p className="text-sm font-medium truncate">Cloning {selectedRepo?.nameWithOwner}…</p>
            {clonePath && (
              <p className="font-mono text-xs text-muted-foreground break-all">{clonePath}</p>
            )}
            <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
              <div
                className="h-full bg-primary transition-all duration-300"
                style={{ width: `${progress.percent}%` }}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {progress.stage || 'Cloning…'} ({progress.percent}%)
            </p>
          </div>
        ) : (
          // min-w-0 keeps nowrap repo descriptions from widening the dialog's
          // grid track past max-w-lg, which pushed the footer out of view.
          <div className="min-w-0 space-y-4">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Filter repositories…"
                className="pl-8"
                disabled={isLoadingRepos || !!loadError}
                data-testid="repository-search-input"
              />
            </div>

            <div
              className="h-56 overflow-y-auto rounded-md border border-input"
              data-testid="repository-list"
            >
              {isLoadingRepos ? (
                <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading repositories…
                </div>
              ) : loadError ? (
                <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
                  <p className="text-sm text-destructive break-all">{loadError}</p>
                  <Button variant="outline" size="sm" onClick={() => void loadRepositories()}>
                    Retry
                  </Button>
                </div>
              ) : filteredRepos.length === 0 ? (
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  {repos.length === 0 ? 'No repositories found' : 'No matching repositories'}
                </div>
              ) : (
                <div className="p-1">
                  {visibleRepos.map((repo) => (
                    <button
                      key={repo.nameWithOwner}
                      type="button"
                      onClick={() => {
                        setSelectedRepo(repo)
                        setCloneError(null)
                      }}
                      className={cn(
                        'w-full rounded-md px-2 py-1.5 text-left hover:bg-accent',
                        selectedRepo?.nameWithOwner === repo.nameWithOwner && 'bg-accent'
                      )}
                      data-testid={`repository-item-${repo.nameWithOwner}`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">{repo.nameWithOwner}</span>
                        {repo.isPrivate && (
                          <Lock className="h-3 w-3 shrink-0 text-muted-foreground" />
                        )}
                      </div>
                      {repo.description && (
                        <p className="truncate text-xs text-muted-foreground">{repo.description}</p>
                      )}
                    </button>
                  ))}
                  {filteredRepos.length > visibleRepos.length && (
                    <p className="px-2 py-1.5 text-xs text-muted-foreground">
                      Showing {visibleRepos.length} of {filteredRepos.length} repositories — refine
                      your filter
                    </p>
                  )}
                </div>
              )}
            </div>

            <div className="space-y-2">
              <label htmlFor="repository-destination" className="text-sm font-medium">
                Clone into
              </label>
              <div className="flex gap-2">
                <Input
                  id="repository-destination"
                  readOnly
                  value={destination ?? ''}
                  placeholder="Select a folder…"
                  className="flex-1 cursor-pointer"
                  onClick={handleBrowse}
                  data-testid="repository-destination"
                />
                <Button variant="outline" onClick={handleBrowse}>
                  Browse…
                </Button>
              </div>
              {clonePath && (
                <p className="font-mono text-xs bg-muted rounded px-2 py-1 break-all">
                  {clonePath}
                </p>
              )}
            </div>
          </div>
        )}

        {cloneError && (
          <p className="text-sm text-destructive break-all" data-testid="clone-error">
            {cloneError}
          </p>
        )}

        <DialogFooter>
          {isCloning ? (
            <Button variant="outline" onClick={handleCancelClone} data-testid="cancel-clone">
              Cancel
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={handleClone} disabled={!canClone} data-testid="clone-repository">
                Clone
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
