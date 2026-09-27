// @vitest-environment node
/**
 * Pure-compute benchmark of the project filter itself (no React), 200 projects.
 * Compares the current filterProjects with cheaper matching strategies so the
 * findings doc can say how much of the search latency the matcher accounts for.
 */
import { describe, it } from 'vitest'
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { filterProjects, type FilterableProject } from '@/lib/project-filter'
import { subsequenceMatch, type SubsequenceMatch } from '@/lib/subsequence-match'
import { makeFixture } from './fixtures'

const SIZE = Number(process.env.SIDEBAR_BENCH_SIZE ?? 200)
const { projects } = makeFixture(SIZE)
const base = { activeLanguages: [], activeSpaceId: null, projectSpaceMap: {} }
const QUERIES = ['t', 'te', 'ted', 'tedo', 'a', 'ap', 'zqx', 'service']
const ITER = 3000

// ---- Variant B: pre-lowercased index, rebuilt only when the projects array changes
interface Indexed<P> {
  project: P
  name: string
  path: string
  mask: number
}
const indexCache = new WeakMap<object, Indexed<FilterableProject>[]>()
const charMask = (s: string): number => {
  let m = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 97 && c <= 122) m |= 1 << (c - 97)
    else if (c >= 48 && c <= 57)
      m |= 1 << 26 // any digit
    else m |= 1 << 27 // any punctuation
  }
  return m
}
function getIndex<P extends FilterableProject>(list: P[]): Indexed<P>[] {
  let idx = indexCache.get(list) as Indexed<P>[] | undefined
  if (!idx) {
    idx = list.map((project) => {
      const name = project.name.toLowerCase()
      const path = project.path.toLowerCase()
      return { project, name, path, mask: charMask(name) | charMask(path) }
    })
    indexCache.set(list, idx)
  }
  return idx
}
// subsequence match on an already-lowercased target
function matchLower(q: string, t: string): SubsequenceMatch {
  const indices: number[] = []
  let qi = 0
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t.charCodeAt(ti) === q.charCodeAt(qi)) {
      indices.push(ti)
      qi++
    }
  }
  if (qi < q.length) return { matched: false, indices: [], score: Infinity }
  let score = 0
  for (let i = 1; i < indices.length; i++) score += indices[i] - indices[i - 1] - 1
  return { matched: true, indices, score }
}
function filterIndexed<P extends FilterableProject>(
  list: P[],
  query: string,
  useMask: boolean
): Array<{ project: P; nameMatch: SubsequenceMatch; pathMatch: SubsequenceMatch }> {
  const q = query.toLowerCase()
  const qm = useMask ? charMask(q) : 0
  const out: Array<{ project: P; nameMatch: SubsequenceMatch; pathMatch: SubsequenceMatch }> = []
  for (const e of getIndex(list)) {
    if (useMask && (e.mask & qm) !== qm) continue
    const nameMatch = matchLower(q, e.name)
    const pathMatch = nameMatch.matched ? nameMatch : matchLower(q, e.path)
    if (!nameMatch.matched && !pathMatch.matched) continue
    out.push({ project: e.project, nameMatch, pathMatch })
  }
  out.sort((a, b) => {
    const as = a.nameMatch.matched ? a.nameMatch.score : a.pathMatch.score + 1000
    const bs = b.nameMatch.matched ? b.nameMatch.score : b.pathMatch.score + 1000
    return as - bs
  })
  return out
}

// ---- Variant D: incremental — when the query extends the previous one, only
// re-check the previous result set (a subsequence match can only shrink).
let prevQuery = ''
let prevResult: FilterableProject[] | null = null
function filterIncremental(list: FilterableProject[], query: string) {
  const q = query.toLowerCase()
  const source = prevResult && q.startsWith(prevQuery) && prevQuery ? prevResult : list
  const r = filterIndexed(source, q, true)
  prevQuery = q
  prevResult = r.map((x) => x.project)
  return r
}

function bench(label: string, fn: (q: string) => unknown): Record<string, number> {
  const out: Record<string, number> = {}
  for (const q of QUERIES) {
    for (let i = 0; i < 200; i++) fn(q) // warm-up / JIT
    const t0 = performance.now()
    for (let i = 0; i < ITER; i++) fn(q)
    out[q] = ((performance.now() - t0) / ITER) * 1000 // µs per call
  }

  console.log(label.padEnd(28), QUERIES.map((q) => `${q}:${out[q].toFixed(1)}µs`).join('  '))
  return out
}

describe('filter micro-benchmark', () => {
  it('measures matcher variants', () => {
    const results = {
      size: SIZE,
      iterations: ITER,
      queries: QUERIES,
      matchCounts: Object.fromEntries(
        QUERIES.map((q) => [q, filterProjects(projects, { ...base, filterQuery: q }).length])
      ),
      variants: {
        'current filterProjects': bench('current filterProjects', (q) =>
          filterProjects(projects, { ...base, filterQuery: q })
        ),
        'pre-lowercased index': bench('pre-lowercased index', (q) =>
          filterIndexed(projects, q, false)
        ),
        'index + char bitmask': bench('index + char bitmask', (q) =>
          filterIndexed(projects, q, true)
        ),
        'index + bitmask + incremental': bench('index + bitmask + incremental', (q) =>
          filterIncremental(projects, q)
        ),
        'subsequenceMatch x1 (name only)': bench('subsequenceMatch x1', (q) =>
          subsequenceMatch(q, projects[7].name)
        )
      }
    }
    const dir = resolve(__dirname, 'results')
    mkdirSync(dir, { recursive: true })
    writeFileSync(resolve(dir, 'filter-micro.json'), JSON.stringify(results, null, 2))
  })
})
