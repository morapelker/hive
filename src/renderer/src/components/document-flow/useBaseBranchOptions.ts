import { useEffect, useState } from 'react'
import { gitApi } from '@/api/git-api'
import { currentRootBranch } from './document-flow-ui'

export interface BaseBranchOptions {
  /** Local branches, sorted by name. */
  names: string[]
  /** The branch of the project's root checkout, which a run without a base branch starts from. */
  current: string | null
  error: string | null
}

const NONE: BaseBranchOptions = { names: [], current: null, error: null }

/** The project's local branches, read once per project path. */
export function useBaseBranchOptions(projectPath: string): BaseBranchOptions {
  const [options, setOptions] = useState<BaseBranchOptions>(NONE)

  useEffect(() => {
    let cancelled = false
    gitApi
      .listBranchesWithStatus(projectPath)
      .then((result) => {
        if (cancelled) return
        if (!result.success) {
          setOptions({ ...NONE, error: result.error || 'Failed to load branches' })
          return
        }
        setOptions({
          names: result.branches
            .filter((branch) => !branch.isRemote)
            .map((branch) => branch.name)
            .sort((a, b) => a.localeCompare(b)),
          current: currentRootBranch(result.branches, projectPath),
          error: null
        })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setOptions({
          ...NONE,
          error: error instanceof Error ? error.message : 'Failed to load branches'
        })
      })
    return () => {
      cancelled = true
    }
  }, [projectPath])

  return options
}
