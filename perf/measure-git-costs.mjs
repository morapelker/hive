#!/usr/bin/env node
// Measures what the main process pays per project/worktree when the sidebar
// search triggers worktree sync + branch info, using this repo as the sample.
// Writes perf/results/git-costs.json.
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const N = Number(process.env.N ?? 100)
const cmds = {
  'git worktree list --porcelain (sync, per project)': ['worktree', 'list', '--porcelain'],
  'git status (branch info, per worktree)': ['status', '--porcelain=v2', '--branch'],
  'git rev-parse --abbrev-ref HEAD (HEAD-only alternative)': ['rev-parse', '--abbrev-ref', 'HEAD']
}
const out = { sampleRepo: resolve(here, '..'), iterations: N, perCallMs: {} }
for (const [label, args] of Object.entries(cmds)) {
  for (let i = 0; i < 5; i++) execFileSync('git', args, { stdio: 'ignore' })
  const t0 = performance.now()
  for (let i = 0; i < N; i++) execFileSync('git', args, { stdio: 'ignore' })
  out.perCallMs[label] = (performance.now() - t0) / N
  console.log(label.padEnd(60), out.perCallMs[label].toFixed(2), 'ms')
}
writeFileSync(resolve(here, 'results', 'git-costs.json'), JSON.stringify(out, null, 2))
