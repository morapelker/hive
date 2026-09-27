import { defineConfig, mergeConfig } from 'vitest/config'
import base from '../vitest.config'

// Perf benchmarks are excluded from the normal `vitest run` globs; run with
//   node perf/run-sidebar-bench.mjs
export default mergeConfig(
  base,
  defineConfig({
    test: {
      include: ['perf/**/*.bench.{ts,tsx}'],
      testTimeout: 600_000,
      hookTimeout: 600_000,
      isolate: true,
      pool: 'forks',
      poolOptions: {
        forks: {
          // e.g. SIDEBAR_BENCH_EXECARGV=--prof to tick-profile the worker (survives a kill)
          execArgv: process.env.SIDEBAR_BENCH_EXECARGV
            ? process.env.SIDEBAR_BENCH_EXECARGV.split(' ')
            : []
        }
      },
      fileParallelism: false
    }
  })
)
