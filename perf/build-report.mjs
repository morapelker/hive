#!/usr/bin/env node
// Builds the standalone findings document from perf/results/*.json.
//   node perf/build-report.mjs  →  docs/perf/project-filter-search-performance.html
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const res = (f) => resolve(here, 'results', f)
const load = (f) => (existsSync(res(f)) ? JSON.parse(readFileSync(res(f), 'utf8')) : null)
const jsdom = load('sidebar-bench.json') ?? {}
const chrome = load('chrome-bench.json') ?? {}
const micro = load('filter-micro.json')
const git = load('git-costs.json')
const OUT = resolve(here, '../../../docs/perf/project-filter-search-performance.html')

const esc = (s) =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]
  )
const f0 = (n) => (n == null || Number.isNaN(n) ? '–' : Math.round(n).toLocaleString('en-US'))
const f1 = (n) =>
  n == null || Number.isNaN(n)
    ? '–'
    : (Math.round(n * 10) / 10).toLocaleString('en-US', {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1
      })
const pct = (a, b) => (a && b ? `${Math.round((1 - b / a) * 100)}%` : '–')
const sum = (xs, k) => xs.reduce((n, s) => n + (s[k] ?? 0), 0)
const rpcSum = (steps, method) => steps.reduce((n, s) => n + (s.rpc?.[method] ?? 0), 0)

const VARIANT_LABEL = {
  baseline: 'Baseline (today)',
  expandLoaded: 'A · Expand loaded projects only',
  expandNone: 'B · No auto-expand on search',
  highlightRuns: 'C · Highlight runs, not chars',
  stableHintPrefix: 'D · Stable hint prefix',
  narrowSelectors: 'E · Narrow list selectors',
  combinedKeepHints: 'A+C+E (keeps hint prefix)',
  combined: 'A+C+D+E combined'
}
const ORDER = [
  'baseline',
  'expandLoaded',
  'expandNone',
  'highlightRuns',
  'stableHintPrefix',
  'narrowSelectors',
  'combinedKeepHints',
  'combined'
]
const key = (v, s) => `${v}-${s}`
const C = (v, s = 200) => chrome[key(v, s)]
const J = (v, s = 200) => jsdom[key(v, s)]
const SEQ = (C('baseline') ?? J('baseline'))?.cold.map((s) => s.query) ?? []
const qLabel = (q) => (q === '' ? '⌫ clear' : `“${q}”`)

// ---------- derived main-process cost (measured RPC counts × measured git cost)
const gitMs = git?.perCallMs ?? {}
const SYNC_MS = gitMs['git worktree list --porcelain (sync, per project)'] ?? 0
const STATUS_MS = gitMs['git status (branch info, per worktree)'] ?? 0
const mainCost = (steps) => {
  const sync = rpcSum(steps, 'worktreeOps.sync')
  const info = rpcSum(steps, 'gitOps.getBranchInfo')
  const watch = rpcSum(steps, 'gitOps.watchBranch')
  const unwatch = rpcSum(steps, 'gitOps.unwatchBranch')
  const loads = rpcSum(steps, 'db.worktree.getActiveByProject')
  return { sync, info, watch, unwatch, loads, gitMs: sync * SYNC_MS + info * STATUS_MS }
}

// ---------- SVG bar chart helpers (single hue or 2-series categorical)
const COLORS = { s1: '#2a78d6', s2: '#eb6834', s3: '#1baf7a' }
function barChart({ id, title, subtitle, rows, series, unit = 'ms', width = 880 }) {
  // rows: [{label, values:[...]}], series: [{name, color}]
  const labelW = 240
  const barH = 14
  const gap = 2
  const groupPad = 10
  const groupH = series.length * (barH + gap) + groupPad
  const plotW = width - labelW - 90
  const max = Math.max(1, ...rows.flatMap((r) => r.values.filter((v) => v != null)))
  const nice = niceMax(max)
  const x = (v) => (v / nice) * plotW
  const h = rows.length * groupH + 40
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * nice)
  let g = ''
  for (const t of ticks) {
    g += `<line x1="${labelW + x(t)}" y1="8" x2="${labelW + x(t)}" y2="${h - 28}" class="grid"/>`
    g += `<text x="${labelW + x(t)}" y="${h - 12}" class="tick" text-anchor="middle">${f0(t)}</text>`
  }
  let b = ''
  rows.forEach((r, i) => {
    const y0 = 12 + i * groupH
    b += `<text x="${labelW - 8}" y="${y0 + (series.length * (barH + gap)) / 2 + 4}" class="lbl" text-anchor="end">${esc(r.label)}</text>`
    r.values.forEach((v, j) => {
      if (v == null) return
      const y = y0 + j * (barH + gap)
      const w = Math.max(0, x(v))
      const rr = Math.min(4, w / 2)
      const d = `M${labelW},${y} h${Math.max(0, w - rr)} a${rr},${rr} 0 0 1 ${rr},${rr} v${barH - 2 * rr} a${rr},${rr} 0 0 1 -${rr},${rr} h-${Math.max(0, w - rr)} z`
      b += `<path d="${d}" fill="${series[j].color}" class="bar" data-tip="${esc(r.label)} · ${esc(series[j].name)}: ${f1(v)} ${unit}"><title>${esc(r.label)} · ${esc(series[j].name)}: ${f1(v)} ${unit}</title></path>`
      b += `<text x="${labelW + w + 6}" y="${y + barH - 3}" class="val">${f0(v)}</text>`
    })
  })
  const legend =
    series.length > 1
      ? `<div class="legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('')}</div>`
      : ''
  return `<figure class="chart" id="${id}"><figcaption><b>${esc(title)}</b>${subtitle ? `<span>${esc(subtitle)}</span>` : ''}</figcaption>${legend}
<svg viewBox="0 0 ${width} ${h}" width="100%" role="img" aria-label="${esc(title)}">${g}<line x1="${labelW}" y1="8" x2="${labelW}" y2="${h - 28}" class="axis"/>${b}</svg></figure>`
}
function niceMax(v) {
  const p = Math.pow(10, Math.floor(Math.log10(v)))
  const m = v / p
  const n = m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10
  return n * p
}
function table(headers, rows, opts = {}) {
  return `<table class="${opts.cls ?? ''}"><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows
    .map(
      (r) => `<tr>${r.map((c, i) => `<td class="${i === 0 ? 'k' : 'n'}">${c}</td>`).join('')}</tr>`
    )
    .join('')}</tbody></table>`
}

// ---------- numbers used in prose
const base = C('baseline')
const comb = C('combined')
const combKH = C('combinedKeepHints')
const baseJ = J('baseline')
const combJ = J('combined')
const step = (run, i, phase = 'cold') => run?.[phase]?.[i]
const idx = (q, nth = 0) => {
  let n = -1
  for (let i = 0; i < SEQ.length; i++) if (SEQ[i] === q && ++n === nth) return i
  return -1
}
const iT = idx('t'),
  iTE = idx('te'),
  iTED = idx('ted'),
  iClear = idx(''),
  iA = idx('a'),
  iZ = idx('zqx')
const worstCold = (run) =>
  run?.cold.reduce((m, s) => (s.paintMs > (m?.paintMs ?? -1) ? s : m), null)
const rpcCold = (run) => (run ? sum(run.cold, 'rpcTotal') : null)
const baseMain = base ? mainCost(base.cold) : null
const combMain = comb ? mainCost(comb.cold) : null
const DEBOUNCE = 150

// ---------- charts
const perKeyRows = SEQ.map((q, i) => ({
  label: `${i + 1}. ${qLabel(q)}`,
  values: [step(base, i)?.paintMs, step(combKH, i)?.paintMs, step(comb, i)?.paintMs]
}))
const chartCold = barChart({
  id: 'c-cold',
  title: 'Chrome: time to paint after each keystroke, first search of the session (cold)',
  subtitle:
    '200 projects · 500 worktrees · headless Chromium · ms from render call to next painted frame',
  rows: perKeyRows,
  series: [
    { name: 'Baseline', color: COLORS.s1 },
    { name: 'A+C+E', color: COLORS.s2 },
    { name: 'A+C+D+E', color: COLORS.s3 }
  ]
})
const perKeyWarm = SEQ.map((q, i) => ({
  label: `${i + 1}. ${qLabel(q)}`,
  values: [
    step(base, i, 'warm')?.paintMs,
    step(combKH, i, 'warm')?.paintMs,
    step(comb, i, 'warm')?.paintMs
  ]
}))
const chartWarm = barChart({
  id: 'c-warm',
  title: 'Chrome: time to paint after each keystroke, steady state (warm, median of 5)',
  subtitle: 'Same sequence once every project has been loaded once',
  rows: perKeyWarm,
  series: [
    { name: 'Baseline', color: COLORS.s1 },
    { name: 'A+C+E', color: COLORS.s2 },
    { name: 'A+C+D+E', color: COLORS.s3 }
  ]
})
const variantRows = ORDER.filter((v) => C(v)).map((v) => ({
  label: VARIANT_LABEL[v],
  values: [sum(C(v).cold, 'paintMs')]
}))
const chartVariants = barChart({
  id: 'c-variants',
  title: 'Chrome: total paint time for the whole 13-keystroke cold sequence, per option',
  subtitle: 'Lower is better · each option measured alone, then combined',
  rows: variantRows,
  series: [{ name: 'cold sequence total', color: COLORS.s1 }]
})
const rpcRows = ORDER.filter((v) => C(v)).map((v) => ({
  label: VARIANT_LABEL[v],
  values: [rpcCold(C(v))]
}))
const chartRpc = barChart({
  id: 'c-rpc',
  title: 'RPC calls to the main process during the cold sequence, per option',
  subtitle:
    'DB loads + git syncs + git status + watcher add/remove; this is what the main process actually has to do',
  rows: rpcRows,
  series: [{ name: 'RPC calls', color: COLORS.s1 }],
  unit: 'calls'
})
const sizeRows = [25, 50, 200]
  .filter((s) => C('baseline', s) && C('combined', s))
  .map((s) => ({
    label: `${s} projects`,
    values: [
      step(C('baseline', s), iTE, 'warm')?.paintMs,
      step(C('combined', s), iTE, 'warm')?.paintMs
    ]
  }))
const chartSize = barChart({
  id: 'c-size',
  title: 'Chrome: warm keystroke “te” by list size (what virtualisation would buy)',
  subtitle: 'A virtualised list renders ~25–50 rows regardless of project count',
  rows: sizeRows,
  series: [
    { name: 'Baseline', color: COLORS.s1 },
    { name: 'A+C+D+E', color: COLORS.s3 }
  ]
})
const microRows = micro
  ? Object.entries(micro.variants)
      .filter(([k]) => !k.startsWith('subsequenceMatch'))
      .map(([k, v]) => ({ label: k, values: [v.te, v.a] }))
  : []
const chartMicro = micro
  ? barChart({
      id: 'c-micro',
      title: 'The matcher itself: microseconds per call over 200 projects',
      subtitle: `${micro.iterations.toLocaleString()} iterations per query · node ${process.version}`,
      rows: microRows,
      series: [
        { name: 'query “te”', color: COLORS.s1 },
        { name: 'query “a”', color: COLORS.s2 }
      ],
      unit: 'µs'
    })
  : ''

// ---------- tables
const optionTable = table(
  [
    'Option',
    'Cold sequence paint (Chrome)',
    'Cold “t” paint',
    'Warm “te” paint',
    'RPC calls, cold seq',
    'DOM nodes at “te”',
    'jsdom cold render sum'
  ],
  ORDER.filter((v) => C(v) || J(v)).map((v) => {
    const c = C(v),
      j = J(v)
    return [
      esc(VARIANT_LABEL[v]),
      c
        ? `${f0(sum(c.cold, 'paintMs'))} ms${v === 'baseline' ? '' : ` <small>(${pct(sum(base.cold, 'paintMs'), sum(c.cold, 'paintMs'))} less)</small>`}`
        : '–',
      c ? `${f0(step(c, iT).paintMs)} ms` : '–',
      c ? `${f1(step(c, iTE, 'warm').paintMs)} ms` : '–',
      c ? f0(rpcCold(c)) : '–',
      c ? f0(step(c, iTE).domNodes) : '–',
      j ? `${f0(sum(j.cold, 'renderMs'))} ms` : '–'
    ]
  })
)
const perStepTable = (run, phase) =>
  table(
    [
      '#',
      'Query',
      'Visible projects',
      'Worktree lists mounted',
      'DOM nodes',
      'Render (JS) ms',
      'Paint ms',
      'Settle ms',
      'React commits',
      'RPC calls'
    ],
    run[phase].map((s, i) => [
      String(i + 1),
      esc(qLabel(s.query)),
      f0(s.visibleProjects),
      f0(s.mountedWorktreeLists),
      f0(s.domNodes),
      f1(s.renderMs),
      f1(s.paintMs),
      f1(s.settleMs),
      f0(s.commits),
      f0(s.rpcTotal)
    ])
  )
const rpcBreakdown = (label, m) =>
  m
    ? `<tr><td class="k">${esc(label)}</td><td class="n">${f0(m.loads)}</td><td class="n">${f0(m.sync)}</td><td class="n">${f0(m.info)}</td><td class="n">${f0(m.watch)}</td><td class="n">${f0(m.unwatch)}</td><td class="n"><b>${f1(m.gitMs / 1000)} s</b></td></tr>`
    : ''
const unrelatedTable = base
  ? table(
      ['Store update while “te” is active', 'Baseline', 'E · narrow selectors', 'A+C+D+E'],
      Object.keys(base.unrelated).map((k) => [
        esc(k),
        `${f1(base.unrelated[k].paintMs)} ms · ${base.unrelated[k].commits} commits`,
        C('narrowSelectors')
          ? `${f1(C('narrowSelectors').unrelated[k].paintMs)} ms · ${C('narrowSelectors').unrelated[k].commits} commits`
          : '–',
        comb ? `${f1(comb.unrelated[k].paintMs)} ms · ${comb.unrelated[k].commits} commits` : '–'
      ])
    )
  : ''

const d = new Date()
const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Project filter search performance — findings &amp; strategy</title>
<style>
:root{color-scheme:light;--surface:#fcfcfb;--surface-2:#f3f2ee;--ink:#0b0b0b;--ink-2:#52514e;--ink-3:#8a8984;--line:#e6e4de;--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--good:#0ca30c;--warn:#fab219;--crit:#d03b3b}
*{box-sizing:border-box}body{margin:0;background:var(--surface);color:var(--ink);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif}
main{max-width:1040px;margin:0 auto;padding:40px 28px 80px}
h1{font-size:30px;line-height:1.2;margin:0 0 6px}h2{font-size:21px;margin:48px 0 12px;padding-top:8px;border-top:1px solid var(--line)}h3{font-size:16px;margin:24px 0 8px}
p{max-width:78ch}.muted{color:var(--ink-2)}.small{font-size:13px;color:var(--ink-2)}
code{font:12.5px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--surface-2);padding:1px 5px;border-radius:4px}
pre{font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--surface-2);padding:12px 14px;border-radius:8px;overflow:auto}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin:22px 0}
.tile{background:var(--surface-2);border-radius:10px;padding:14px 16px}.tile .l{font-size:13px;color:var(--ink-2)}.tile .v{font-size:30px;font-weight:600;line-height:1.15;margin:4px 0 2px}.tile .d{font-size:13px;color:var(--ink-2)}.tile .d.good{color:var(--good)}
table{border-collapse:collapse;width:100%;margin:12px 0 18px;font-size:13.5px}th{text-align:left;font-weight:600;color:var(--ink-2);border-bottom:1px solid var(--line);padding:6px 8px;font-size:12.5px}td{padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}td.n{font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}th:not(:first-child){text-align:right}td.k{white-space:nowrap}
small{color:var(--ink-3)}
figure.chart{margin:22px 0;padding:14px 16px 6px;background:var(--surface-2);border-radius:10px}figcaption b{display:block;font-size:14px}figcaption span{font-size:12.5px;color:var(--ink-2)}
.legend{display:flex;gap:16px;font-size:12.5px;color:var(--ink-2);margin:8px 0 2px}.legend i{display:inline-block;width:12px;height:12px;border-radius:3px;margin-right:6px;vertical-align:-2px}
svg .grid{stroke:var(--line);stroke-width:1}svg .axis{stroke:#cfcdc5;stroke-width:1}svg .tick{font-size:11px;fill:var(--ink-3)}svg .lbl{font-size:12px;fill:var(--ink-2)}svg .val{font-size:11px;fill:var(--ink-2);font-variant-numeric:tabular-nums}svg .bar:hover{filter:brightness(1.12)}
.pc{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin:8px 0 6px}.pc>div{background:var(--surface-2);border-radius:8px;padding:10px 14px;font-size:13.5px}.pc h4{margin:0 0 6px;font-size:12.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--ink-2)}.pc ul{margin:0;padding-left:18px}
.gain{display:inline-block;background:#e6f2e6;color:#0a5c0a;border-radius:6px;padding:2px 8px;font-size:13px;font-weight:600;margin:4px 0}
.phase{border-left:3px solid var(--s1);padding:2px 0 2px 14px;margin:14px 0}.phase b{display:block}
details{margin:8px 0}summary{cursor:pointer;color:var(--ink-2);font-size:13.5px}
#tip{position:fixed;pointer-events:none;background:#0b0b0b;color:#fff;font-size:12px;padding:5px 8px;border-radius:5px;display:none;z-index:9}
</style></head><body><main>
<div id="tip"></div>
<h1>Project filter search performance</h1>
<p class="muted">Findings, measured options and an implementation strategy · Hive sidebar (<code>apps/hive</code>) · ${today} · measured on this machine, 200-project fixture</p>

<h2>Summary</h2>
<p><b>The matcher is not the problem.</b> Filtering 200 projects with the current subsequence matcher costs about ${micro ? f0(micro.variants['current filterProjects'].te) : '40'} µs. What makes a search feel slow is everything the sidebar does <em>because</em> the query changed: it force-expands every matching project, mounts a worktree list for each, and each of those lists asks the main process to load worktrees from SQLite, run a git worktree sync, add a branch watcher per worktree and run <code>git status</code> per worktree. On the first search of a session that is <b>${baseMain ? f0(rpcCold(base)) : '–'} RPC calls</b> for one 13-keystroke sequence, of which <b>${baseMain ? f0(baseMain.sync) : '–'} git syncs and ${baseMain ? f0(baseMain.info) : '–'} git status calls</b> — roughly <b>${baseMain ? f1(baseMain.gitMs / 1000) : '–'} s of serial git time</b> at this machine's measured per-call cost, on top of a 150 ms debounce and a render of ${base ? f0(step(base, iTE).domNodes) : '–'} DOM nodes.</p>
<div class="tiles">
<div class="tile"><div class="l">First keystroke, cold (Chrome, paint)</div><div class="v">${base ? f0(step(base, iT).paintMs) : '–'} → ${comb ? f0(step(comb, iT).paintMs) : '–'} ms</div><div class="d good">${base && comb ? pct(step(base, iT).paintMs, step(comb, iT).paintMs) : '–'} less · baseline → A+C+D+E</div></div>
<div class="tile"><div class="l">Steady-state keystroke “te” (Chrome, paint)</div><div class="v">${base ? f0(step(base, iTE, 'warm').paintMs) : '–'} → ${comb ? f0(step(comb, iTE, 'warm').paintMs) : '–'} ms</div><div class="d good">${base && comb ? pct(step(base, iTE, 'warm').paintMs, step(comb, iTE, 'warm').paintMs) : '–'} less · median of 5</div></div>
<div class="tile"><div class="l">Main-process RPC calls, cold sequence</div><div class="v">${base ? f0(rpcCold(base)) : '–'} → ${comb ? f0(rpcCold(comb)) : '–'}</div><div class="d good">${base && comb ? pct(rpcCold(base), rpcCold(comb)) : '–'} fewer · git/DB/watcher calls</div></div>
<div class="tile"><div class="l">Serial git time implied, cold sequence</div><div class="v">${baseMain ? f1(baseMain.gitMs / 1000) : '–'} → ${combMain ? f1(combMain.gitMs / 1000) : '–'} s</div><div class="d">measured RPC counts × measured git cost</div></div>
<div class="tile"><div class="l">Fixed latency floor today</div><div class="v">${DEBOUNCE} ms</div><div class="d">trailing debounce before any filtering starts</div></div>
</div>

<h2>1 · Where the time actually goes</h2>
<p>Per keystroke, after the ${DEBOUNCE} ms debounce fires, this is the cascade in <code>ProjectList</code> → <code>ProjectItem</code> → <code>WorktreeList</code> (file references are to <code>apps/hive/src/renderer/src</code>):</p>
<ol>
<li><b>Filtering</b> (<code>lib/project-filter.ts</code>): ~${micro ? f0(micro.variants['current filterProjects'].te) : '40'} µs for 200 projects. It is also run a second time by <code>ConnectionList</code> for the same query. Negligible either way.</li>
<li><b>Force-expansion</b> (<code>ProjectItem.tsx</code>, <code>isExpanded = isSearchMode || isExpandedInStore</code>): every matching project expands. For the ${base ? f0(step(base, iT).visibleProjects) : '–'} matches of “t” that mounts ${base ? f0(step(base, iT).mountedWorktreeLists) : '–'} worktree lists at once.</li>
<li><b>Per-project I/O on mount</b> (<code>WorktreeList.tsx</code>): the first mount of each project calls <code>loadWorktrees</code> (SQLite) and <code>syncWorktrees</code> (<code>git worktree list</code> + DB reconcile), and <code>useSidebarBranchWatcher</code> adds a HEAD watcher and calls <code>getBranchInfo</code> (<code>git status</code>) per worktree. Measured on this repo: <code>git worktree list</code> ≈ ${f1(SYNC_MS)} ms, <code>git status</code> ≈ ${f1(STATUS_MS)} ms per call, serial.</li>
<li><b>Watcher churn on every keystroke</b>: when a project leaves the result set its list unmounts and un-watches every worktree; when it comes back (backspace) it re-watches. Cold sequence: ${baseMain ? f0(baseMain.watch) : '–'} watch + ${baseMain ? f0(baseMain.unwatch) : '–'} unwatch calls.</li>
<li><b>Store-update storm</b>: each load/sync resolving replaces <code>worktreesByProject</code>, which <code>ProjectList</code> subscribes to; it recomputes the hint map and calls <code>setHints</code>, and every row re-renders. Cold “t” produced ${base ? f0(step(base, iT).commits) : '–'} React commits in Chrome.</li>
<li><b>Hint codes reshuffle</b>: <code>assignHints(targets, lastChar)</code> prefers the last typed character as the hint prefix, so <em>every</em> hint code changes on every keystroke and every row with a badge re-renders even when its match did not change.</li>
<li><b>Highlight rendering</b> (<code>HighlightedText.tsx</code>): one <code>&lt;span&gt;</code> per character of the name <em>and</em> the path; at “te” the list is ${base ? f0(step(base, iTE).domNodes) : '–'} DOM nodes.</li>
<li><b>Whole-store subscriptions</b> in <code>ProjectList</code> (<code>useProjectStore()</code>, <code>useHintStore()</code> without selectors) re-render the list on unrelated changes such as selecting a project or a hint keypress.</li>
</ol>
${chartMicro}
<p class="small">Matcher variants: a pre-lowercased index removes the per-call <code>toLowerCase()</code>; a 27-bit character mask skips projects that cannot contain the query's letters; incremental narrowing re-checks only the previous result set when the query grows. All are tens of microseconds — worth doing only as part of a bigger change, never on their own.</p>

<h2>2 · What each option does, with measurements</h2>
<p>Every option is implemented behind a runtime flag (<code>lib/sidebar-perf-flags.ts</code>) so it could be measured alone and in combination. Two harnesses drive the <em>real</em> <code>ProjectList</code> tree with a 200-project / ${base ? f0(base.totalWorktrees) : '–'}-worktree fixture and a counting RPC mock: headless Chromium (Playwright; includes layout and paint) and jsdom (vitest; JS only). “Cold” = first search in a session with 10 projects expanded; “warm” = the same 13-keystroke sequence once everything has loaded, median of 5.</p>
${chartVariants}
${chartRpc}
${optionTable}
<p class="small">“Cold sequence” = the 13 keystrokes <code>t, te, ted, tedo, ted, te, t, ⌫, a, ap, ⌫, zqx, ⌫</code>. The full per-keystroke tables are in section 4.</p>

<h3>Option A · Search only expands projects whose worktrees are already loaded <span class="gain">cold “t”: ${base ? f0(step(base, iT).paintMs) : '–'} → ${C('expandLoaded') ? f0(step(C('expandLoaded'), iT).paintMs) : '–'} ms · RPC ${base ? f0(rpcCold(base)) : '–'} → ${C('expandLoaded') ? f0(rpcCold(C('expandLoaded'))) : '–'}</span></h3>
<p>Search mode still auto-expands, but only projects whose worktrees are already in the store (previously expanded, pinned, recent). A search-driven mount never calls load/sync/watch. Never-opened projects show as a collapsed header the user can expand as today.</p>
<div class="pc"><div><h4>Pros</h4><ul><li>Removes the git/DB storm entirely: a keystroke never triggers main-process work.</li><li>Removes watcher add/remove churn for cold projects.</li><li>Smallest possible behaviour change: everything you have looked at still expands.</li></ul></div><div><h4>Cons / what you lose</h4><ul><li>Projects you have never opened this session stay collapsed in search results; hint badges (<code>Aa</code>-style jump codes) for their worktrees do not exist until expanded.</li><li>Worktree counts for cold projects are unknown until expansion (pill shows nothing).</li></ul></div></div>

<h3>Option B · Search never auto-expands <span class="gain">cold “t”: ${base ? f0(step(base, iT).paintMs) : '–'} → ${C('expandNone') ? f0(step(C('expandNone'), iT).paintMs) : '–'} ms</span></h3>
<p>Search filters the project headers only; expansion state is whatever the user set. Fastest possible list, but a different product.</p>
<div class="pc"><div><h4>Pros</h4><ul><li>Cheapest render in every scenario; the list is just headers.</li><li>Very predictable: search does not move anything except which headers are visible.</li></ul></div><div><h4>Cons / what you lose</h4><ul><li>“Type a few letters, then hit a hint code to jump to a worktree” stops working for collapsed projects — that flow is a core keyboard feature today.</li><li>Needs an extra step (expand) to reach a worktree from a search.</li></ul></div></div>

<h3>Option C · Render highlight runs instead of one span per character <span class="gain">DOM at “te”: ${base ? f0(step(base, iTE).domNodes) : '–'} → ${C('highlightRuns') ? f0(step(C('highlightRuns'), iTE).domNodes) : '–'} nodes</span></h3>
<p><code>HighlightedText</code> groups consecutive matched/unmatched characters into runs. A 60-character path becomes ~5 nodes instead of 60. Pixel-identical output.</p>
<div class="pc"><div><h4>Pros</h4><ul><li>Pure win, no UX change, ~20 lines.</li><li>Less DOM to diff on every keystroke; less memory.</li></ul></div><div><h4>Cons / what you lose</h4><ul><li>Nothing. Only meaningful once A removes the I/O storm; on its own it moves totals by a few percent.</li></ul></div></div>

<h3>Option D · Stable hint-code prefix across keystrokes <span class="gain">warm “te”: ${C('combinedKeepHints') ? f1(step(combKH, iTE, 'warm').paintMs) : '–'} → ${comb ? f1(step(comb, iTE, 'warm').paintMs) : '–'} ms (measured on top of A+C+E)</span></h3>
<p>Today the hint prefix is the uppercase of the last typed character, so all codes change on every keystroke and every badge re-renders. With a fixed prefix order only rows whose position changed get a new code.</p>
<div class="pc"><div><h4>Pros</h4><ul><li>Rows that did not change no longer re-render; the hint map rarely changes.</li><li>Codes stop jumping around under the cursor while typing.</li></ul></div><div><h4>Cons / what you lose</h4><ul><li>Loses the “first hint letter is the key you just typed” convention. If that convention matters to muscle memory, keep it (A+C+E still gives most of the gain — see table).</li></ul></div></div>

<h3>Option E · Narrow store selectors in <code>ProjectList</code> <span class="gain">unrelated hint keypress: ${base ? f1(base.unrelated['hint pendingChar toggle'].paintMs) : '–'} → ${C('narrowSelectors') ? f1(C('narrowSelectors').unrelated['hint pendingChar toggle'].paintMs) : '–'} ms</span></h3>
<p><code>ProjectList</code> subscribes to the whole project store and the whole hint store, so it re-renders (and re-maps 200 rows) on any store change, including the pending-hint keypress and project selection.</p>
${unrelatedTable}
<div class="pc"><div><h4>Pros</h4><ul><li>Mechanical change, no behaviour change.</li><li>Makes the hint two-key flow itself cheaper.</li></ul></div><div><h4>Cons / what you lose</h4><ul><li>Nothing. The remaining cost of a hint keypress is the badges themselves re-rendering (every row with a badge subscribes to <code>mode</code>/<code>pendingChar</code>); fixing that means moving those reads into <code>HintBadge</code>, which is a follow-up.</li></ul></div></div>

<h3>Option F · Virtualise the list <span class="gain">projected: warm “te” ${sizeRows.length ? `${f0(sizeRows[sizeRows.length - 1].values[1])} → ~${f0(sizeRows[0].values[1])} ms` : '–'}</span></h3>
<p>Not implemented; projected by measuring the same sequence with 25, 50 and 200 projects. A virtualised sidebar renders only the ~25–50 rows in the viewport, so its cost is the “25/50 projects” bar regardless of how many projects exist.</p>
${chartSize}
<div class="pc"><div><h4>Pros</h4><ul><li>Makes render cost flat in project count: 200 or 2,000 projects cost the same.</li><li>The repo already uses <code>@tanstack/react-virtual</code> elsewhere (file tree, messages).</li></ul></div><div><h4>Cons / what you lose</h4><ul><li>Biggest change: sticky project headers, drag-to-reorder, expand/collapse with variable-height worktree cards and hint targets all have to be re-done on top of a virtualiser. Weeks, not hours.</li><li>Row measurement can jank when many rows change height at once (expand-all on search).</li><li>Not the first thing to do: A–E already take a steady-state keystroke from ${base ? f0(step(base, iTE, 'warm').paintMs) : '–'} to ${comb ? f0(step(comb, iTE, 'warm').paintMs) : '–'} ms; what is left is rendering 200 headers, which virtualisation would cut to the 25-project figure.</li></ul></div></div>

<h3>Option G · Debounce: ${DEBOUNCE} ms fixed → adaptive / transition-based</h3>
<p>The store debounces the query by ${DEBOUNCE} ms before filtering starts, so even a free render shows results ≥ ${DEBOUNCE} ms after the keystroke. Once A–E are in, a keystroke costs ~${comb ? f0(step(comb, iTE, 'warm').paintMs) : '–'} ms of paint in Chrome and the ${DEBOUNCE} ms debounce becomes the single largest part of what the user waits for. Options: drop to ~30 ms; or remove it and wrap the list update in <code>startTransition</code> / <code>useDeferredValue</code> so typing stays responsive while the list catches up.</p>
<div class="pc"><div><h4>Pros</h4><ul><li>Removes up to ${DEBOUNCE} ms of guaranteed latency per keystroke.</li></ul></div><div><h4>Cons / what you lose</h4><ul><li>Without A the debounce is what protects the main process from a storm per keystroke; do not change it first.</li><li>Transitions keep the old list visible briefly; fine for a sidebar, but test with the hint flow (hint codes are computed from the deferred value).</li></ul></div></div>

<h3>Option H · Main-process hygiene (not measured, derived)</h3>
<p>Even with A, an explicit expand still costs one <code>git worktree list</code> + one <code>git status</code> per worktree. Two cheap improvements: (1) replace the sidebar's <code>getBranchInfo</code> (<code>git status --porcelain --branch</code>, ${f1(STATUS_MS)} ms) with a HEAD-only read (<code>git rev-parse --abbrev-ref HEAD</code> ${f1(gitMs['git rev-parse --abbrev-ref HEAD (HEAD-only alternative)'])} ms, or reading <code>.git/HEAD</code> directly, µs) since the sidebar only shows the branch name; (2) queue sync/status calls through a small concurrency limiter so a burst cannot saturate the main process.</p>

<h2>3 · Compromises, side by side</h2>
${table(
  ['Choice', 'Keeps', 'Gives up', 'Effort', 'Measured / projected effect'],
  [
    [
      'A · expand loaded only',
      'Expand-on-search for everything you have opened; hint jump for those worktrees',
      'Expand-on-search for never-opened projects',
      'Small (done behind flag)',
      `cold “t” ${base ? f0(step(base, iT).paintMs) : '–'} → ${C('expandLoaded') ? f0(step(C('expandLoaded'), iT).paintMs) : '–'} ms; RPC −${base && C('expandLoaded') ? pct(rpcCold(base), rpcCold(C('expandLoaded'))) : '–'}`
    ],
    [
      'B · never expand',
      'Cheapest list',
      'Hint jump to worktrees from a search',
      'Small',
      `cold “t” → ${C('expandNone') ? f0(step(C('expandNone'), iT).paintMs) : '–'} ms`
    ],
    [
      'A+C+E (keep hint prefix)',
      'Every visible behaviour incl. last-char hint prefix',
      'Nothing user-visible for opened projects',
      'Small',
      `warm “te” ${base ? f1(step(base, iTE, 'warm').paintMs) : '–'} → ${combKH ? f1(step(combKH, iTE, 'warm').paintMs) : '–'} ms`
    ],
    [
      'A+C+D+E',
      'Everything above',
      'Last-char hint prefix',
      'Small',
      `warm “te” → ${comb ? f1(step(comb, iTE, 'warm').paintMs) : '–'} ms`
    ],
    [
      '+ G (debounce → transition)',
      'Everything above',
      'The 150 ms safety net (only safe after A)',
      'Small–medium',
      `−${DEBOUNCE} ms floor per keystroke`
    ],
    [
      '+ F (virtualise)',
      'Flat cost at any size',
      'Simplicity of the current DOM list; sticky headers/drag need rework',
      'Large',
      `warm “te” → ~${sizeRows.length ? f0(sizeRows[0].values[1]) : '–'} ms at any size`
    ]
  ]
)}

<h2>4 · Per-keystroke detail</h2>
${chartCold}
${chartWarm}
<h3>Main-process work implied by the cold sequence</h3>
<p class="small">Counts are measured RPC calls; seconds = counts × per-call cost measured on this repo (<code>git worktree list</code> ${f1(SYNC_MS)} ms, <code>git status</code> ${f1(STATUS_MS)} ms). Serial time; the main process runs several at once, but each also blocks the DB reconcile and a store update in the renderer.</p>
<table><thead><tr><th>Option</th><th>DB loads</th><th>git syncs</th><th>git status</th><th>watch</th><th>unwatch</th><th>serial git time</th></tr></thead><tbody>
${ORDER.filter((v) => C(v))
  .map((v) => rpcBreakdown(VARIANT_LABEL[v], mainCost(C(v).cold)))
  .join('')}
</tbody></table>
<details><summary>Baseline, Chrome, cold — per keystroke</summary>${base ? perStepTable(base, 'cold') : ''}</details>
<details><summary>Baseline, Chrome, warm — per keystroke (median of 5)</summary>${base ? perStepTable(base, 'warm') : ''}</details>
<details><summary>A+C+D+E, Chrome, cold — per keystroke</summary>${comb ? perStepTable(comb, 'cold') : ''}</details>
<details><summary>A+C+D+E, Chrome, warm — per keystroke</summary>${comb ? perStepTable(comb, 'warm') : ''}</details>
<details><summary>Baseline, jsdom, cold — per keystroke (JS only, no layout)</summary>${
  baseJ
    ? table(
        ['#', 'Query', 'Visible', 'Lists', 'DOM nodes', 'Render ms', 'Settle ms', 'Commits', 'RPC'],
        baseJ.cold.map((s, i) => [
          String(i + 1),
          esc(qLabel(s.query)),
          f0(s.visibleProjects),
          f0(s.mountedWorktreeLists),
          f0(s.domNodes),
          f1(s.renderMs),
          f1(s.settleMs),
          f0(s.commits),
          f0(s.rpcTotal)
        ])
      )
    : ''
}</details>
<details><summary>A+C+D+E, jsdom, cold — per keystroke</summary>${
  combJ
    ? table(
        ['#', 'Query', 'Visible', 'Lists', 'DOM nodes', 'Render ms', 'Settle ms', 'Commits', 'RPC'],
        combJ.cold.map((s, i) => [
          String(i + 1),
          esc(qLabel(s.query)),
          f0(s.visibleProjects),
          f0(s.mountedWorktreeLists),
          f0(s.domNodes),
          f1(s.renderMs),
          f1(s.settleMs),
          f0(s.commits),
          f0(s.rpcTotal)
        ])
      )
    : ''
}</details>

<h2>5 · Recommended strategy</h2>
<div class="phase"><b>Phase 1 — stop the I/O storm (Option A + E + C). One PR, low risk.</b>
Make the flags unconditional: search-driven expansion never loads/syncs/watches; <code>ProjectList</code> uses narrow selectors; <code>HighlightedText</code> renders runs. Delete <code>sidebar-perf-flags.ts</code>. Expected: cold first keystroke ${base ? f0(step(base, iT).paintMs) : '–'} → ~${combKH ? f0(step(combKH, iT).paintMs) : '–'} ms in Chrome and zero git calls per keystroke. Ship with the existing tests plus two new ones: “search does not call loadWorktrees/syncWorktrees/watchBranch for unloaded projects” and “HighlightedText runs match per-char output”.</div>
<div class="phase"><b>Phase 2 — decide on the hint prefix (Option D), then shorten the debounce (Option G).</b>
Try D for a week behind the flag; if nobody misses the last-char prefix, keep it. Then reduce <code>FILTER_DEBOUNCE_MS</code> to ~30 ms, or replace it with <code>useDeferredValue</code> for the list while the input stays uncontrolled by the debounce. Only after Phase 1: the debounce is currently what keeps the storm to one burst per pause.</div>
<div class="phase"><b>Phase 3 — main-process hygiene (Option H).</b>
Switch the sidebar branch display to a HEAD-only read and put sync/status behind a concurrency limiter, so an explicit expand of a big project or a “Refresh” never stalls the main process. This also fixes the un-watch/re-watch churn by keeping watchers alive for a grace period after unmount.</div>
<div class="phase"><b>Phase 4 — only if the project count keeps growing: virtualise (Option F).</b>
At 200 projects Phases 1–3 put a keystroke at ~${comb ? f0(step(comb, iTE, 'warm').paintMs) : '–'} ms of paint (measured) with no main-process work; virtualisation would bring that to the ~${sizeRows.length ? f0(sizeRows[0].values[1]) : '–'} ms of the 25-project run and keep it flat as the list grows. Prototype with <code>@tanstack/react-virtual</code> on the flat row model (header rows + worktree rows) and keep sticky headers via the virtualiser's range API.</div>
<p><b>Explicitly not recommended:</b> optimising the matcher first (µs), adding a search index/worker (the filter is already free), or Option B (breaks the hint jump flow) unless A turns out not to be enough.</p>

<h2>6 · Method, caveats, how to re-run</h2>
<ul>
<li><b>Fixture:</b> ${base ? f0(base.size) : 200} projects with realistic names/paths (<code>perf/fixtures.ts</code>), ${base ? f0(base.totalWorktrees) : '–'} worktrees (0–5 per project), 10 projects expanded at start. The RPC layer is a counting mock returning fixture data instantly, so renderer numbers exclude real IPC/git latency — that is why the main-process cost is derived separately from measured git command timings (<code>perf/measure-git-costs.mjs</code>).</li>
<li><b>Chrome harness:</b> <code>perf/chrome/main.tsx</code> + <code>perf/chrome/run-chrome-bench.mjs</code> (Vite dev server + Playwright headless Chromium). “Render” = <code>flushSync</code> time, “paint” = until the next <code>requestAnimationFrame</code> after it; “settle” = until no more RPC or commits for three frames.</li>
<li><b>jsdom harness:</b> <code>perf/sidebar-search.bench.tsx</code> via <code>node perf/run-sidebar-bench.mjs</code>. No layout, so absolute numbers are lower in some places and higher in others than Chrome; use it for ratios and for RPC/DOM/commit counts. Two jsdom-only workarounds were needed: nwsapi cannot evaluate the <code>:modal</code> pseudo-class floating-ui probes (short-circuited), and the recording <code>localStorage</code> mock from <code>test/setup.ts</code> was replaced.</li>
<li><b>Tips disabled in both harnesses:</b> with a mock DB the onboarding tip is never “seen”, so every worktree row opened the same tip popover and each dismissal persisted the seen list (50,000 writes per keystroke). Real installs see the tip once. Worth a look anyway: <code>Tip</code> instances with the same id all mount their popover when that id becomes active.</li>
<li><b>Noise:</b> single machine, other processes running; cold numbers are single runs, warm numbers are medians of 5. Treat differences under ~15% as noise.</li>
<li><b>Re-run everything:</b> <code>cd apps/hive && node perf/run-sidebar-bench.mjs && node perf/chrome/run-chrome-bench.mjs && node perf/measure-git-costs.mjs && node perf/build-report.mjs</code>; micro-benchmark: <code>npx vitest run --config perf/vitest.perf.config.ts perf/filter-micro.bench.ts</code>.</li>
</ul>
<p class="small">Environment: ${esc(base?.userAgent ?? '')} · React ${esc(base?.react ?? '')} · node ${esc(process.version)}</p>
</main>
<script>
(function(){var t=document.getElementById('tip');document.querySelectorAll('svg .bar').forEach(function(b){b.addEventListener('pointermove',function(e){t.textContent=b.getAttribute('data-tip');t.style.display='block';t.style.left=(e.clientX+12)+'px';t.style.top=(e.clientY+12)+'px'});b.addEventListener('pointerleave',function(){t.style.display='none'})})})();
</script>
</body></html>`
mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, html)
console.log(
  `wrote ${OUT} (${(html.length / 1024).toFixed(0)} KB); runs: chrome=${Object.keys(chrome).length} jsdom=${Object.keys(jsdom).length}`
)
