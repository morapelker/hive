/**
 * A text search must never fan out into per-project I/O: only projects whose
 * worktrees are already loaded auto-expand, and a search-driven mount never
 * loads, syncs or installs branch watchers (Phase 1 of
 * docs/perf/project-filter-search-performance.html).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { setRendererRpcClient } from '@/api/rpc-client'
import { ProjectItem } from './ProjectItem'
import { useProjectStore } from '@/stores/useProjectStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useHintStore } from '@/stores/useHintStore'
import { useSettingsStore } from '@/stores/useSettingsStore'

const project = (id: string) => ({
  id,
  name: id,
  path: `/tmp/${id}`,
  description: null,
  tags: null,
  language: null,
  custom_icon: null,
  detected_icon: 'none',
  setup_script: null,
  run_script: null,
  archive_script: null,
  auto_assign_port: false,
  sort_order: 0,
  created_at: '2026-01-01',
  last_accessed_at: '2026-01-01'
})
const worktree = (projectId: string, k: number) => ({
  id: `${projectId}-wt-${k}`,
  project_id: projectId,
  name: `${projectId}-${k}`,
  branch_name: k === 0 ? 'main' : `feature-${k}`,
  path: `/tmp/${projectId}${k === 0 ? '' : `-wt-${k}`}`,
  status: 'active' as const,
  is_default: k === 0,
  branch_renamed: 0,
  last_message_at: null,
  session_titles: '[]',
  last_model_provider_id: null,
  last_model_id: null,
  last_model_variant: null,
  attachments: '[]',
  created_at: '2026-01-01',
  last_accessed_at: '2026-01-01',
  github_pr_number: null,
  github_pr_url: null
})

const rpc = new Map<string, number>()
const loadWorktrees = vi.fn(async () => {})
const syncWorktrees = vi.fn(async () => {})

describe('ProjectItem in search mode', () => {
  beforeEach(() => {
    cleanup()
    rpc.clear()
    loadWorktrees.mockClear()
    syncWorktrees.mockClear()
    setRendererRpcClient({
      request: async <T,>(method: string): Promise<T> => {
        rpc.set(method, (rpc.get(method) ?? 0) + 1)
        return { success: true } as T
      },
      subscribe: () => () => {}
    })
    useSettingsStore.setState({ tipsEnabled: false })
    useProjectStore.setState({ expandedProjectIds: new Set(), selectedProjectId: null })
    useWorktreeStore.setState({
      loadWorktrees,
      syncWorktrees,
      worktreesByProject: new Map([
        ['loaded', [worktree('loaded', 0), worktree('loaded', 1)]],
        // A worktree created for a never-loaded project: an entry, but not the full list.
        ['partial', [worktree('partial', 0)]]
      ]),
      loadedProjectIds: new Set(['loaded']),
      worktreeOrderByProject: new Map()
    })
    useHintStore.setState({ filterActive: true, inputFocused: true })
  })

  it('does not expand, load, sync or watch a project whose worktrees are not loaded', () => {
    render(<ProjectItem project={project('cold')} nameMatchIndices={[0]} />)
    expect(screen.queryByTestId('worktree-list-cold')).toBeNull()
    expect(loadWorktrees).not.toHaveBeenCalled()
    expect(syncWorktrees).not.toHaveBeenCalled()
    expect(rpc.get('gitOps.watchBranch') ?? 0).toBe(0)
    expect(rpc.get('gitOps.getBranchInfo') ?? 0).toBe(0)
  })

  it("does not present a partial worktree list as the project's worktrees", () => {
    render(<ProjectItem project={project('partial')} nameMatchIndices={[0]} />)
    expect(screen.queryByTestId('worktree-list-partial')).toBeNull()
    expect(screen.queryByTestId('project-worktree-count-partial')).toBeNull()
    expect(loadWorktrees).not.toHaveBeenCalled()
    expect(syncWorktrees).not.toHaveBeenCalled()
  })

  it('shows already-loaded worktrees without loading, syncing or watching', () => {
    render(<ProjectItem project={project('loaded')} nameMatchIndices={[0]} />)
    expect(screen.getByTestId('worktree-list-loaded')).toBeInTheDocument()
    expect(screen.getByTestId('worktree-list-loaded').children).toHaveLength(2)
    expect(loadWorktrees).not.toHaveBeenCalled()
    expect(syncWorktrees).not.toHaveBeenCalled()
    expect(rpc.get('gitOps.watchBranch') ?? 0).toBe(0)
    expect(rpc.get('gitOps.getBranchInfo') ?? 0).toBe(0)
  })

  it('keeps a match beyond the auto-expand limit collapsed, with its real count', () => {
    render(
      <ProjectItem project={project('loaded')} nameMatchIndices={[0]} searchAutoExpand={false} />
    )
    expect(screen.queryByTestId('worktree-list-loaded')).toBeNull()
    expect(screen.getByTestId('project-worktree-count-loaded')).toHaveTextContent('2')
    expect(loadWorktrees).not.toHaveBeenCalled()
    expect(syncWorktrees).not.toHaveBeenCalled()
  })

  it('still loads and syncs on an explicit expand', () => {
    useProjectStore.setState({ expandedProjectIds: new Set(['cold']) })
    useHintStore.setState({ filterActive: false })
    render(<ProjectItem project={project('cold')} />)
    expect(screen.getByTestId('worktree-list-cold')).toBeInTheDocument()
    expect(loadWorktrees).toHaveBeenCalledWith('cold')
    expect(syncWorktrees).toHaveBeenCalledWith('cold', '/tmp/cold')
  })
})
