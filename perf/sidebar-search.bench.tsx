/**
 * Sidebar search benchmark (jsdom) — renders the REAL ProjectList/ProjectItem/
 * WorktreeList tree with a 200-project fixture and a counting RPC mock, then
 * drives the filter query like a user typing. Same protocol as perf/chrome/main.tsx.
 *
 * Per keystroke it records:
 *   - renderMs: wall time of the synchronous React render + commit (+ layout effects)
 *   - settleMs: extra time until async store updates (loads/syncs) stop re-rendering
 *   - profilerMs / commits: React Profiler actualDuration + commit count for the list
 *   - rpc: RPC calls issued, by method (the git/DB work the main process would do)
 *   - domNodes / mountedWorktreeLists / visibleProjects
 *
 * Variant + size come from env (see run-sidebar-bench.mjs). jsdom has no layout,
 * so absolute numbers are lower than Chrome; ratios between variants are what matter.
 */
import { describe, it, vi } from 'vitest'
import React, { Profiler } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { setRendererRpcClient } from '@/api/rpc-client'
import { sidebarPerfFlags, type SidebarPerfFlags } from '@/lib/sidebar-perf-flags'
import { makeFixture } from './fixtures'

const T0 = performance.now()
const mark = (l: string): void => {
  if (process.env.SIDEBAR_BENCH_TRACE)
    console.log(
      `  [t+${((performance.now() - T0) / 1000).toFixed(1)}s heap ${(process.memoryUsage().heapUsed / 1048576).toFixed(0)}MB] ${l}`
    )
}

const VARIANT = process.env.SIDEBAR_BENCH_VARIANT ?? 'baseline'
const SIZE = Number(process.env.SIDEBAR_BENCH_SIZE ?? 200)
const WARM_REPS = Number(process.env.SIDEBAR_BENCH_REPS ?? 5)

// Phase 1 of the findings doc (expand loaded only, highlight runs, narrow
// selectors) is now unconditional, so today's 'baseline' corresponds to the
// 'combinedKeepHints' run in perf/results; 'stableHintPrefix' is the Phase 2 trial.
const VARIANTS: Record<string, Partial<SidebarPerfFlags>> = {
  baseline: {},
  stableHintPrefix: { stableHintPrefix: true },
  // The app bulk-hydrates every project's worktrees from the DB on mount, so a
  // search expands every match. 'noHydrate' skips that for an A/B against the
  // previous behaviour, where only already-expanded projects showed worktrees.
  noHydrate: {}
}
const HYDRATE = VARIANT !== 'noHydrate'
Object.assign(sidebarPerfFlags, VARIANTS[VARIANT] ?? {})

// jsdom gaps hit by sidebar rows
class RO {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO
Element.prototype.scrollIntoView = vi.fn()
Element.prototype.hasPointerCapture = vi.fn(() => false)
Element.prototype.releasePointerCapture = vi.fn()
// jsdom/nwsapi cannot evaluate the top-layer pseudo-classes floating-ui probes
// (`:modal`, `:popover-open`): each probe recurses until the stack overflows
// (~270ms) and Radix poppers probe on every reposition. Chrome answers these in
// nanoseconds, so short-circuit them here.
{
  const origMatches = Element.prototype.matches
  const TOP_LAYER = new Set([':modal', ':popover-open', ':fullscreen', ':open'])
  Element.prototype.matches = function (sel: string) {
    if (TOP_LAYER.has(sel)) return false
    return origMatches.call(this, sel)
  }
}
// test/setup.ts installs a recording vi.fn() localStorage; zustand persist writes the
// whole project list on every store change, so the recorded calls alone exhaust the heap.
{
  const storage = new Map<string, string>()
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, String(v)),
      removeItem: (k: string) => void storage.delete(k),
      clear: () => storage.clear(),
      key: (i: number) => [...storage.keys()][i] ?? null,
      get length() {
        return storage.size
      }
    }
  })
}
// We drive React directly (flushSync + real timers), not through act().
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = false

const { projects, worktreesByProject } = makeFixture(SIZE)
const EXPANDED_COUNT = Math.min(10, SIZE)
const expandedIds = projects.slice(0, EXPANDED_COUNT).map((p) => p.id)
const branchByPath = new Map<string, string>()
for (const wts of worktreesByProject.values())
  for (const w of wts) branchByPath.set(w.path, w.branch_name)

const rpcCounts = new Map<string, number>()
const settingKeys = new Map<string, number>()
let rpcTotal = 0
setRendererRpcClient({
  request: async <T,>(method: string, params?: unknown): Promise<T> => {
    rpcTotal++
    rpcCounts.set(method, (rpcCounts.get(method) ?? 0) + 1)
    if (method === 'db.setting.set') {
      const k = String((params as { key?: string })?.key)
      settingKeys.set(k, (settingKeys.get(k) ?? 0) + 1)
    }
    switch (method) {
      case 'db.project.getAll':
        return projects as T
      case 'db.worktree.getAllActive':
        return [...worktreesByProject.values()].flat() as T
      case 'db.worktree.getActiveByProject': {
        const { projectId } = params as { projectId: string }
        return (worktreesByProject.get(projectId) ?? []) as T
      }
      case 'worktreeOps.sync':
      case 'gitOps.watchBranch':
      case 'gitOps.unwatchBranch':
        return { success: true } as T
      case 'gitOps.getBranchInfo': {
        // Answer with the worktree's own branch: a mismatch reads as an external rename.
        const { worktreePath } = params as { worktreePath: string }
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

// Import after the RPC client is in place (stores call it on module init).
const { ProjectList } = await import('@/components/projects/ProjectList')
const { useProjectStore } = await import('@/stores/useProjectStore')
const { useWorktreeStore } = await import('@/stores/useWorktreeStore')
const { useHintStore } = await import('@/stores/useHintStore')
const { useSpaceStore } = await import('@/stores/useSpaceStore')
const { useSettingsStore } = await import('@/stores/useSettingsStore')

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
// Stable like the store-provided array in production; a fresh [] per render would loop.
const NO_LANGUAGES: string[] = []
const SEQUENCE = process.env.SIDEBAR_BENCH_SEQ
  ? process.env.SIDEBAR_BENCH_SEQ.split(',')
  : ['t', 'te', 'ted', 'tedo', 'ted', 'te', 't', '', 'a', 'ap', '', 'zqx', '']

let profilerMs = 0
let commits = 0
const onRender = (_id: string, _phase: string, actualDuration: number): void => {
  profilerMs += actualDuration
  commits++
}

function seedStores(): void {
  const wtMap = new Map<string, unknown[]>()
  for (const id of expandedIds) wtMap.set(id, worktreesByProject.get(id) ?? [])
  useProjectStore.setState({
    // Startup loaders are not search work; the fixture is already in the store.
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

const container = document.createElement('div')
document.body.appendChild(container)
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

interface StepResult {
  query: string
  renderMs: number
  settleMs: number
  profilerMs: number
  commits: number
  rpc: Record<string, number>
  rpcTotal: number
  domNodes: number
  mountedWorktreeLists: number
  visibleProjects: number
}

async function settle(): Promise<void> {
  let idle = 0
  let spins = 0
  while (idle < 3) {
    const rs = rpcTotal
    const cs = commits
    await tick()
    if (
      process.env.SIDEBAR_BENCH_HEAP_EXIT_MB &&
      process.memoryUsage().heapUsed > Number(process.env.SIDEBAR_BENCH_HEAP_EXIT_MB) * 1048576
    ) {
      mark(
        `heap guard tripped (commits=${commits}, rpc=${rpcTotal}); setting keys=${JSON.stringify(Object.fromEntries(settingKeys))}`
      )
      process.exit(5)
    }
    idle = rpcTotal === rs && commits === cs ? idle + 1 : 0
    if (++spins > 500)
      throw new Error(`settle did not converge (commits=${commits}, rpc=${rpcTotal})`)
  }
}

async function runSequence(seq: string[]): Promise<StepResult[]> {
  const out: StepResult[] = []
  for (const q of seq) {
    const rpcBefore = rpcTotal
    const countsBefore = new Map(rpcCounts)
    profilerMs = 0
    commits = 0
    const t0 = performance.now()
    renderQuery(q)
    const t1 = performance.now()
    mark(`rendered ${JSON.stringify(q)} in ${(t1 - t0).toFixed(0)}ms`)
    await settle()
    const t2 = performance.now()
    mark(`settled ${JSON.stringify(q)} in ${(t2 - t1).toFixed(0)}ms`)
    const rpc: Record<string, number> = {}
    for (const [m, n] of rpcCounts) {
      const d = n - (countsBefore.get(m) ?? 0)
      if (d > 0) rpc[m] = d
    }
    out.push({
      query: q,
      renderMs: t1 - t0,
      settleMs: t2 - t1,
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

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}

describe(`sidebar search bench [${VARIANT}, ${SIZE} projects]`, () => {
  it('measures cold + warm typing sequences', async () => {
    mark('start')
    seedStores()
    root = createRoot(container)
    const tMount = performance.now()
    renderQuery('')
    await settle()
    const mountMs = performance.now() - tMount
    const loadedAfterMount = useWorktreeStore.getState().loadedProjectIds.size
    mark('mounted')
    const mountRpc = Object.fromEntries(rpcCounts)

    // ---- Cold: only the 10 expanded projects have worktrees loaded (fresh app session)
    const cold = await runSequence(SEQUENCE)
    mark('cold done')

    // ---- Warm: everything the first search loaded is now in the store; repeat N times.
    const warmRuns: StepResult[][] = []
    for (let r = 0; r < WARM_REPS; r++) {
      warmRuns.push(await runSequence(SEQUENCE))
      mark(`warm rep ${r} done`)
    }
    const warm: StepResult[] = SEQUENCE.map((_, i) => {
      const samples = warmRuns.map((run) => run[i])
      return {
        ...samples[samples.length - 1],
        renderMs: median(samples.map((s) => s.renderMs)),
        settleMs: median(samples.map((s) => s.settleMs)),
        profilerMs: median(samples.map((s) => s.profilerMs)),
        commits: median(samples.map((s) => s.commits))
      }
    })

    // ---- Unrelated store updates while a query is active ('te')
    renderQuery('te')
    await settle()
    const unrelated: Record<string, { ms: number; commits: number }> = {}
    const measure = (label: string, fn: () => void): void => {
      const samples: number[] = []
      let c = 0
      for (let r = 0; r < WARM_REPS; r++) {
        profilerMs = 0
        commits = 0
        const t0 = performance.now()
        flushSync(fn)
        samples.push(performance.now() - t0)
        c = commits
      }
      unrelated[label] = { ms: median(samples), commits: c }
    }
    let flip = false
    measure('hint pendingChar toggle', () => {
      flip = !flip
      useHintStore.setState({ mode: flip ? 'pending' : 'idle', pendingChar: flip ? 'T' : null })
    })
    measure('select another project', () => {
      flip = !flip
      useProjectStore.getState().selectProject(flip ? projects[3 % SIZE].id : projects[4 % SIZE].id)
    })
    measure('worktree store: unrelated project reload', () => {
      const s = useWorktreeStore.getState()
      const m = new Map(s.worktreesByProject)
      const id = projects[SIZE - 1].id
      m.set(id, [...(worktreesByProject.get(id) ?? [])] as never)
      useWorktreeStore.setState({ worktreesByProject: m })
    })
    mark('unrelated done')

    const result = {
      variant: VARIANT,
      size: SIZE,
      flags: { ...sidebarPerfFlags },
      warmReps: WARM_REPS,
      expandedAtStart: EXPANDED_COUNT,
      totalWorktrees: [...worktreesByProject.values()].reduce((n, w) => n + w.length, 0),
      hydrate: HYDRATE,
      mountMs,
      loadedAfterMount,
      mountRpc,
      cold,
      warm,
      unrelated,
      node: process.version,
      react: React.version
    }
    const dir = resolve(__dirname, 'results')
    mkdirSync(dir, { recursive: true })
    writeFileSync(resolve(dir, `${VARIANT}-${SIZE}.json`), JSON.stringify(result, null, 2))

    console.log(
      `[${VARIANT}/${SIZE}] cold total render ${cold.reduce((n, s) => n + s.renderMs, 0).toFixed(1)}ms, ` +
        `settle ${cold.reduce((n, s) => n + s.settleMs, 0).toFixed(1)}ms, rpc ${cold.reduce((n, s) => n + s.rpcTotal, 0)}; ` +
        `warm 'ted' render ${warm[2].renderMs.toFixed(1)}ms; ` +
        `mount ${mountMs.toFixed(1)}ms, ${loadedAfterMount}/${SIZE} projects loaded`
    )
  })
})
