import { useCallback, useEffect, useRef, useState } from 'react'
import { gitApi } from '@/api/git-api'
import {
  changedFilesSourceKey,
  loadChangedFiles,
  type ChangedFile,
  type ChangedFilesSource
} from './changed-files'

export interface ChangedFilesState {
  /** `null` until the first load for the current source finishes */
  files: ChangedFile[] | null
  error: string | null
  loading: boolean
  reload: () => void
}

/**
 * Load the changed files for a source and keep them fresh while the worktree's
 * git status changes (an agent may still be writing when the dialog opens).
 */
export function useChangedFiles(source: ChangedFilesSource | null): ChangedFilesState {
  const [files, setFiles] = useState<ChangedFile[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [version, setVersion] = useState(0)
  const loadedKey = useRef<string | null>(null)

  const reload = useCallback(() => setVersion((v) => v + 1), [])

  // Depend on primitives so a re-created source object with the same content
  // doesn't refetch
  const kind = source?.kind ?? null
  const worktreePath = source?.worktreePath ?? null
  const baseBranch = source?.kind === 'branch' ? source.baseBranch : null

  useEffect(() => {
    if (!kind || !worktreePath || (kind === 'branch' && !baseBranch)) {
      loadedKey.current = null
      setFiles(null)
      setError(null)
      setLoading(false)
      return
    }
    const current: ChangedFilesSource =
      kind === 'branch'
        ? { kind, worktreePath, baseBranch: baseBranch as string }
        : { kind, worktreePath }
    const key = changedFilesSourceKey(current)
    // A new source starts from scratch; a refresh keeps the old list on screen
    if (loadedKey.current !== key) setFiles(null)

    let cancelled = false
    setLoading(true)
    setError(null)
    loadChangedFiles(current)
      .then((result) => {
        if (cancelled) return
        if (result.ok) {
          loadedKey.current = key
          setFiles(result.value)
        } else {
          setError(result.error)
        }
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [kind, worktreePath, baseBranch, version])

  useEffect(() => {
    if (!worktreePath) return
    return gitApi.onStatusChanged((event) => {
      if (event.worktreePath === worktreePath) reload()
    })
  }, [worktreePath, reload])

  return { files, error, loading, reload }
}
