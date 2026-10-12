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

export const NO_BASE_BRANCH_OPTIONS: BaseBranchOptions = { names: [], current: null, error: null }

/** The branches of one project, by its root path. */
export type BaseBranchOptionsByPath = Readonly<Record<string, BaseBranchOptions>>

const EMPTY: BaseBranchOptionsByPath = {}

async function loadBaseBranchOptions(projectPath: string): Promise<BaseBranchOptions> {
  try {
    const result = await gitApi.listBranchesWithStatus(projectPath)
    if (!result.success) {
      return { ...NO_BASE_BRANCH_OPTIONS, error: result.error || 'Failed to load branches' }
    }
    return {
      names: result.branches
        .filter((branch) => !branch.isRemote)
        .map((branch) => branch.name)
        .sort((a, b) => a.localeCompare(b)),
      current: currentRootBranch(result.branches, projectPath),
      error: null
    }
  } catch (error: unknown) {
    return {
      ...NO_BASE_BRANCH_OPTIONS,
      error: error instanceof Error ? error.message : 'Failed to load branches'
    }
  }
}

/**
 * The local branches of several projects at once — the member projects of a connection
 * project, each with its own base-branch pick — read once per set of paths. Entries are
 * missing until their list arrived (or failed: the error is in the entry).
 */
export function useBaseBranchOptionsByPath(
  projectPaths: readonly string[]
): BaseBranchOptionsByPath {
  const [options, setOptions] = useState<BaseBranchOptionsByPath>(EMPTY)
  // Compared by content: the caller builds the list on every render.
  const pathsKey = projectPaths.join('\0')

  useEffect(() => {
    let cancelled = false
    setOptions(EMPTY)
    const paths = pathsKey ? pathsKey.split('\0') : []
    for (const path of paths) {
      void loadBaseBranchOptions(path).then((loaded) => {
        if (cancelled) return
        setOptions((current) => ({ ...current, [path]: loaded }))
      })
    }
    return () => {
      cancelled = true
    }
  }, [pathsKey])

  return options
}

/** The project's local branches, read once per project path. */
export function useBaseBranchOptions(projectPath: string): BaseBranchOptions {
  const byPath = useBaseBranchOptionsByPath([projectPath])
  return byPath[projectPath] ?? NO_BASE_BRANCH_OPTIONS
}
