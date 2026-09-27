#!/usr/bin/env node
// Runs every sidebar-search variant in its own vitest process (module-level
// caches such as WorktreeList's initializedProjects must start fresh) and
// merges perf/results/*.json into perf/results/sidebar-bench.json.
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const hive = resolve(here, '..')
const only = process.argv.slice(2)
// The committed perf/results were taken before Phase 1 landed (see the doc);
// re-running overwrites them with the new baseline.
const runs = [
  ['baseline', 200],
  ['noHydrate', 200],
  ['stableHintPrefix', 200],
  ['baseline', 25],
  ['baseline', 50]
].filter(([v, s]) => only.length === 0 || only.includes(`${v}-${s}`) || only.includes(v))

for (const [variant, size] of runs) {
  const r = spawnSync(
    'npx',
    ['vitest', 'run', '--config', 'perf/vitest.perf.config.ts', 'perf/sidebar-search.bench.tsx'],
    {
      cwd: hive,
      stdio: 'inherit',
      env: {
        ...process.env,
        SIDEBAR_BENCH_VARIANT: variant,
        SIDEBAR_BENCH_SIZE: String(size),
        SIDEBAR_BENCH_EXECARGV: process.env.SIDEBAR_BENCH_EXECARGV ?? '--max-old-space-size=8192'
      }
    }
  )
  if (r.status !== 0) {
    console.error(`variant ${variant}/${size} failed`)
    process.exit(r.status ?? 1)
  }
}

const dir = resolve(here, 'results')
const merged = {}
for (const f of readdirSync(dir)) {
  if (!f.endsWith('.json') || f === 'sidebar-bench.json') continue
  const j = JSON.parse(readFileSync(resolve(dir, f), 'utf8'))
  if (!j.variant) continue
  merged[`${j.variant}-${j.size}`] = j
}
writeFileSync(resolve(dir, 'sidebar-bench.json'), JSON.stringify(merged, null, 2))
console.log(`merged ${Object.keys(merged).length} runs → perf/results/sidebar-bench.json`)
