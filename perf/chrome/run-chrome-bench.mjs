#!/usr/bin/env node
// Starts a Vite dev server for perf/chrome and drives every variant through
// headless Chromium (Playwright). Writes perf/results/chrome-bench.json.
import { createServer } from 'vite'
import { chromium } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const only = process.argv.slice(2)
// The committed perf/results were taken before Phase 1 landed (see the doc);
// re-running overwrites them with the new baseline.
const runs = [
  ['baseline', 200],
  ['noHydrate', 200],
  ['stableHintPrefix', 200],
  ['baseline', 25],
  ['noHydrate', 25],
  ['baseline', 50],
  ['noHydrate', 50]
].filter(([v, s]) => only.length === 0 || only.includes(`${v}-${s}`) || only.includes(v))

const server = await createServer({ configFile: resolve(here, '../vite.chrome.config.ts') })
await server.listen()
const url = server.resolvedUrls.local[0]
const browser = await chromium.launch({ headless: true })
const merged = {}
try {
  for (const [variant, size] of runs) {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
    page.on('pageerror', (e) => console.error('pageerror', e.message))
    await page.goto(`${url}?variant=${variant}&size=${size}&reps=${process.env.REPS ?? 5}`)
    await page.waitForFunction(() => typeof window.__bench === 'function', null, { timeout: 60000 })
    const result = await page.evaluate(() => window.__bench())
    merged[`${variant}-${size}`] = result
    const cold = result.cold.reduce((n, s) => n + s.paintMs, 0)
    console.log(
      `[${variant}/${size}] cold seq paint ${cold.toFixed(0)}ms; warm 'te' paint ${result.warm[1].paintMs.toFixed(1)}ms render ${result.warm[1].renderMs.toFixed(1)}ms; rpc cold ${result.cold.reduce((n, s) => n + s.rpcTotal, 0)}`
    )
    await page.close()
  }
} finally {
  await browser.close()
  await server.close()
}
const dir = resolve(here, '../results')
mkdirSync(dir, { recursive: true })
writeFileSync(resolve(dir, 'chrome-bench.json'), JSON.stringify(merged, null, 2))
console.log(`wrote ${Object.keys(merged).length} runs → perf/results/chrome-bench.json`)
