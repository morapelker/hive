/**
 * Real-Chrome counterpart of perf/sidebar-search.bench.tsx. Mounts the real
 * ProjectList tree; window.__bench(variant, size, reps) runs the same typing
 * sequence and returns per-keystroke timings that include layout + paint.
 */
import '@/styles/globals.css'
import React, { Profiler } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { setRendererRpcClient } from '@/api/rpc-client'
import { sidebarPerfFlags, type SidebarPerfFlags } from '@/lib/sidebar-perf-flags'
import { makeFixture } from '../fixtures'

// Phase 1 of the findings doc (expand loaded only, highlight runs, narrow
// selectors) is now unconditional, so today's 'baseline' corresponds to the
// 'combinedKeepHints' run in perf/results; 'stableHintPrefix' is the Phase 2 trial.
const VARIANTS: Record<string, Partial<SidebarPerfFlags>> = {
  baseline: {},
  stableHintPrefix: { stableHintPrefix: true },
  // See perf/sidebar-search.bench.tsx: skips the mount-time bulk hydrate for an
  // A/B against the previous behaviour (only already-expanded projects show worktrees).
  noHydrate: {}
}
// Stable like the store-provided array in production; a fresh [] per render would loop.
const NO_LANGUAGES: string[] = []
const SEQUENCE = ['t', 'te', 'ted', 'tedo', 'ted', 'te', 't', '', 'a', 'ap', '', 'zqx', '']

const params = new URLSearchParams(location.search)
const VARIANT = params.get('variant') ?? 'baseline'
const SIZE = Number(params.get('size') ?? 200)
const REPS = Number(params.get('reps') ?? 5)
Object.assign(sidebarPerfFlags, { stableHintPrefix: false }, VARIANTS[VARIANT] ?? {})
const HYDRATE = VARIANT !== 'noHydrate'

const { projects, worktreesByProject } = makeFixture(SIZE)
const EXPANDED_COUNT = Math.min(10, SIZE)
const expandedIds = projects.slice(0, EXPANDED_COUNT).map((p) => p.id)

const branchByPath = new Map<string, string>()
for (const wts of worktreesByProject.values())
  for (const w of wts) branchByPath.set(w.path, w.branch_name)
const rpcCounts = new Map<string, number>()
let rpcTotal = 0
setRendererRpcClient({
  request: async <T,>(method: string, p?: unknown): Promise<T> => {
    rpcTotal++
    rpcCounts.set(method, (rpcCounts.get(method) ?? 0) + 1)
    switch (method) {
      case 'db.project.getAll':
        return projects as T
      case 'db.worktree.getAllActive':
        return [...worktreesByProject.values()].flat() as T
      case 'db.worktree.getActiveByProject': {
        const { projectId } = p as { projectId: string }
        return (worktreesByProject.get(projectId) ?? []) as T
      }
      case 'worktreeOps.sync':
      case 'gitOps.watchBranch':
      case 'gitOps.unwatchBranch':
        return { success: true } as T
      case 'gitOps.getBranchInfo': {
        // Answer with the worktree's own branch: a mismatch would make the app
        // treat it as an external rename and re-sync forever.
        const { worktreePath } = p as { worktreePath: string }
        const name = branchByPath.get(worktreePath) ?? 'main'
        return {
          success: true,
          branch: { name, ahead: 0, behind: 0, tracking: `origin/${name}`, hasRemote: true }
        } as T
      }
      case 'db.space.list':
      case 'db.setting.getAll':
        return [] as T
      case 'settingsOps.getAll':
      case 'projectOps.loadLanguageIcons':
        return {} as T
      default:
        return undefined as T
    }
  },
  subscribe: () => () => {}
})

const { ProjectList } = await import('@/components/projects/ProjectList')
const { useProjectStore } = await import('@/stores/useProjectStore')
const { useWorktreeStore } = await import('@/stores/useWorktreeStore')
const { useHintStore } = await import('@/stores/useHintStore')
const { useSpaceStore } = await import('@/stores/useSpaceStore')
const { useSettingsStore } = await import('@/stores/useSettingsStore')

let profilerMs = 0
let commits = 0
const onRender = (_id: string, _phase: string, actualDuration: number): void => {
  profilerMs += actualDuration
  commits++
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const nextPaint = (): Promise<void> =>
  new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)))

function seedStores(): void {
  const wtMap = new Map<string, unknown[]>()
  for (const id of expandedIds) wtMap.set(id, worktreesByProject.get(id) ?? [])
  useProjectStore.setState({
    loadProjects: async () => {},
    projects: projects as never,
    isLoading: false,
    error: null,
    expandedProjectIds: new Set(expandedIds),
    selectedProjectId: expandedIds[0] ?? null
  })
  useWorktreeStore.setState({
    worktreesByProject: wtMap as never,
    loadedProjectIds: new Set(expandedIds),
    worktreeOrderByProject: new Map(),
    isLoading: false,
    ...(HYDRATE ? {} : { hydrateAllWorktrees: async () => {} })
  })
  useSpaceStore.setState({ loadSpaces: async () => {} })
  // Onboarding tips are a one-time-per-install affair; with the mock DB they would
  // never be marked seen, so every worktree row would open the same tip popover
  // and each dismissal would persist the seen list again (50k writes/keystroke).
  useSettingsStore.setState({ tipsEnabled: false })
  useHintStore.getState().clearHints()
  useHintStore.setState({ inputFocused: true, filterActive: false })
}

const container = document.getElementById('root') as HTMLElement
let root: Root
const renderQuery = (q: string): void => {
  flushSync(() => {
    root.render(
      <Profiler id="list" onRender={onRender}>
        <ProjectList onAddProject={() => {}} filterQuery={q} activeLanguages={NO_LANGUAGES} />
      </Profiler>
    )
  })
}

async function runSequence(seq: string[]) {
  const out = []
  for (const q of seq) {
    const rpcBefore = rpcTotal
    const countsBefore = new Map(rpcCounts)
    profilerMs = 0
    commits = 0
    const t0 = performance.now()
    renderQuery(q)
    const t1 = performance.now()
    await nextPaint()
    const t2 = performance.now()
    let idle = 0
    while (idle < 3) {
      const rs = rpcTotal
      const cs = commits
      await tick()
      await nextPaint()
      idle = rpcTotal === rs && commits === cs ? idle + 1 : 0
    }
    const t3 = performance.now()
    const rpc: Record<string, number> = {}
    for (const [m, n] of rpcCounts) {
      const d = n - (countsBefore.get(m) ?? 0)
      if (d > 0) rpc[m] = d
    }
    out.push({
      query: q,
      renderMs: t1 - t0,
      paintMs: t2 - t0,
      settleMs: t3 - t2,
      profilerMs,
      commits,
      rpc,
      rpcTotal: rpcTotal - rpcBefore,
      domNodes: container.querySelectorAll('*').length,
      mountedWorktreeLists: container.querySelectorAll('[data-testid^="worktree-list-"]').length,
      visibleProjects: container.querySelectorAll('[data-project-group]').length
    })
  }
  return out
}
type Step = Awaited<ReturnType<typeof runSequence>>[number]
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}

;(window as unknown as { __bench: () => Promise<unknown> }).__bench = async () => {
  seedStores()
  root = createRoot(container)
  renderQuery('')
  await nextPaint()
  await tick()
  await nextPaint()
  const cold = await runSequence(SEQUENCE)
  const runs: Step[][] = []
  for (let r = 0; r < REPS; r++) runs.push(await runSequence(SEQUENCE))
  const warm = SEQUENCE.map((_, i) => {
    const samples = runs.map((run) => run[i])
    return {
      ...samples[samples.length - 1],
      renderMs: median(samples.map((s) => s.renderMs)),
      paintMs: median(samples.map((s) => s.paintMs)),
      settleMs: median(samples.map((s) => s.settleMs)),
      profilerMs: median(samples.map((s) => s.profilerMs)),
      commits: median(samples.map((s) => s.commits))
    }
  })
  renderQuery('te')
  await nextPaint()
  const unrelated: Record<string, { ms: number; paintMs: number; commits: number }> = {}
  const measure = async (label: string, fn: () => void): Promise<void> => {
    const ms: number[] = []
    const paint: number[] = []
    let c = 0
    for (let r = 0; r < REPS; r++) {
      profilerMs = 0
      commits = 0
      const t0 = performance.now()
      flushSync(fn)
      ms.push(performance.now() - t0)
      await nextPaint()
      paint.push(performance.now() - t0)
      c = commits
    }
    unrelated[label] = { ms: median(ms), paintMs: median(paint), commits: c }
  }
  let flip = false
  await measure('hint pendingChar toggle', () => {
    flip = !flip
    useHintStore.setState({ mode: flip ? 'pending' : 'idle', pendingChar: flip ? 'T' : null })
  })
  await measure('select another project', () => {
    flip = !flip
    useProjectStore.getState().selectProject(flip ? projects[3].id : projects[4].id)
  })
  await measure('worktree store: unrelated project reload', () => {
    const s = useWorktreeStore.getState()
    const m = new Map(s.worktreesByProject)
    const id = projects[SIZE - 1].id
    m.set(id, [...(worktreesByProject.get(id) ?? [])] as never)
    useWorktreeStore.setState({ worktreesByProject: m })
  })
  return {
    variant: VARIANT,
    size: SIZE,
    flags: { ...sidebarPerfFlags },
    warmReps: REPS,
    expandedAtStart: EXPANDED_COUNT,
    totalWorktrees: [...worktreesByProject.values()].reduce((n, w) => n + w.length, 0),
    cold,
    warm,
    unrelated,
    userAgent: navigator.userAgent,
    react: React.version
  }
}
document.title = `bench ${VARIANT}/${SIZE} ready`
