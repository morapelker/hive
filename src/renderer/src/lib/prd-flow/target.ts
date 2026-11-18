import { worktreeApi } from '@/api/worktree-api'
import { findBaseInstanceConnection, isConnectionProject } from '@/lib/connection-project'
import { useConnectionStore } from '@/stores/useConnectionStore'
import type { PrdFlowCheckout } from '@/stores/usePrdFlowStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { prdFlowDocumentCandidates } from './paths'

// Where a PRD flow runs: in the project's root, not in a worktree of its own. A git project's
// root is its default worktree (the main checkout); a connection project's is its base
// instance, the directory its members' main checkouts are linked into. The form ("New PRD →
// orchestrator ticket…") resolves it to say where the two documents will be written, and the
// start (./start) resolves it again to pin it on the flow.

/** Where the session of a PRD flow runs and its two documents are written. */
export interface PrdFlowTarget {
  checkout: PrdFlowCheckout
  /** Absolute path of the directory the session runs in. */
  cwd: string
  /** Directories inside `cwd` a document may be written into instead (connection members). */
  memberDirs: string[]
}

export type PrdFlowTargetResult = { ok: true; target: PrdFlowTarget } | { ok: false; error: string }

/** The base instance of a connection project, read from the server when this page has not got it. */
async function resolveBaseInstance(projectId: string): Promise<PrdFlowTargetResult> {
  let base = findBaseInstanceConnection(projectId)
  if (!base) {
    // Not loaded yet, or only just made by the server (listing heals a missing base).
    await useConnectionStore.getState().loadConnections()
    base = findBaseInstanceConnection(projectId)
  }
  if (!base || base.status !== 'active') {
    return { ok: false, error: 'This project has no base instance to run in.' }
  }
  const memberDirs = [...new Set(base.members.map((member) => member.symlink_name))].filter(Boolean)
  return {
    ok: true,
    target: {
      checkout: { kind: 'connection', connectionId: base.id },
      cwd: base.path,
      memberDirs
    }
  }
}

/** The main checkout of a git project: the worktree marked as its default. */
async function resolveMainCheckout(projectId: string): Promise<PrdFlowTargetResult> {
  const worktrees = useWorktreeStore.getState()
  // A project that was never expanded has no worktrees on this page yet.
  await worktrees.loadWorktrees(projectId)
  let main = useWorktreeStore.getState().getDefaultWorktree(projectId)
  if (!main) {
    // What the page holds may be older than the checkout: asked once more, past the cache.
    await worktrees.loadWorktrees(projectId, { force: true })
    main = useWorktreeStore.getState().getDefaultWorktree(projectId)
  }
  if (!main) return { ok: false, error: 'This project has no main checkout to run in.' }
  return {
    ok: true,
    target: { checkout: { kind: 'worktree', worktreeId: main.id }, cwd: main.path, memberDirs: [] }
  }
}

/**
 * The directory a PRD flow of the project runs in, or why it cannot run. Never rejects for a
 * project without one: that is an answer (`ok: false`), said in the form.
 */
export async function resolvePrdFlowTarget(projectId: string): Promise<PrdFlowTargetResult> {
  const project = useProjectStore.getState().projects.find((p) => p.id === projectId)
  if (!project) return { ok: false, error: 'The project was not found.' }
  return isConnectionProject(project)
    ? resolveBaseInstance(projectId)
    : resolveMainCheckout(projectId)
}

/**
 * The documents of that prefix that are already there, the PRD's before the tasks', each at the
 * top of the directory before the member directories. A flow started over them would take a
 * file it did not ask for as its own. Rejects when the directory could not be looked at.
 */
export async function findExistingPrdFlowFiles(
  target: Pick<PrdFlowTarget, 'cwd' | 'memberDirs'>,
  prefix: string
): Promise<string[]> {
  const flow = { cwd: target.cwd, memberDirs: target.memberDirs, prefix }
  const candidates = [
    ...prdFlowDocumentCandidates(flow, 'prd'),
    ...prdFlowDocumentCandidates(flow, 'tasks')
  ]
  const found = await Promise.all(candidates.map((path) => worktreeApi.exists(path)))
  return candidates.filter((_, index) => found[index])
}

const lastSeparator = (path: string): number =>
  Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))

/**
 * What the person is told about documents that are already there (`existing` as
 * `findExistingPrdFlowFiles` gives it, not empty): the file names, and the directory the first
 * of them is in.
 */
export function describeExistingPrdFlowFiles(existing: readonly string[]): string {
  const names = [...new Set(existing.map((path) => path.slice(lastSeparator(path) + 1)))]
  const directory = existing[0].slice(0, lastSeparator(existing[0]))
  return names.length > 1
    ? `${names.join(' and ')} already exist in ${directory}. Pick another name, or remove the files.`
    : `${names[0]} already exists in ${directory}. Pick another name, or remove the file.`
}
