#!/usr/bin/env node
// Builds src/native/uv-pool-waker/build/uv-pool-waker.node —
// the addon the main process uses to wake a wedged libuv thread pool (see the
// comment in uv_pool_waker.c). macOS only; elsewhere this is a no-op.
//
// One universal (arm64 + x86_64) bundle compiled straight with clang: the
// addon is plain C against the stable N-API ABI, so it needs neither
// node-gyp nor Node/Electron headers and serves both mac package arches.
//
// `--optional` (postinstall) reports a failure and exits 0; packaging runs it
// without the flag so a mac build never ships without the waker.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const log = (message) => process.stdout.write(`[hive] ${message}\n`)

const optional = process.argv.includes('--optional')

if (process.platform !== 'darwin') process.exit(0)

const addonDir = resolve(projectRoot, 'src/native/uv-pool-waker')
const source = join(addonDir, 'uv_pool_waker.c')
const output = join(addonDir, 'build/uv-pool-waker.node')
mkdirSync(join(addonDir, 'build'), { recursive: true })

const baseArgs = [
  '-arch', 'arm64',
  '-arch', 'x86_64',
  '-bundle',
  '-undefined', 'dynamic_lookup',
  '-mmacosx-version-min=11.0',
  '-O2',
  '-Wall',
  '-o', output,
  source
]

// The default SDK first; then every other installed SDK, newest first — a
// Command Line Tools linker older than its newest SDK cannot read that SDK's
// .tbd stubs ("unknown architecture"), and an older SDK links fine.
function candidateSdks() {
  const roots = [
    '/Library/Developer/CommandLineTools/SDKs',
    '/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs'
  ]
  const sdks = []
  for (const root of roots) {
    if (!existsSync(root)) continue
    for (const name of readdirSync(root)) {
      if (/^MacOSX\d[\d.]*\.sdk$/.test(name)) sdks.push(join(root, name))
    }
  }
  const version = (path) => path.match(/MacOSX([\d.]+)\.sdk$/)[1].split('.').map(Number)
  return sdks.sort((a, b) => {
    const [x, y] = [version(a), version(b)]
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      if ((y[i] ?? 0) !== (x[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0)
    }
    return 0
  })
}

const attempts = [null, ...candidateSdks()]
let lastError = ''
for (const sdk of attempts) {
  const args = sdk ? ['-isysroot', sdk, ...baseArgs] : baseArgs
  const result = spawnSync('xcrun', ['clang', ...args], { encoding: 'utf8' })
  if (result.status === 0) {
    log(`built ${output}${sdk ? ` (SDK ${sdk})` : ''}`)
    process.exit(0)
  }
  lastError = (result.stderr || result.error?.message || '').trim()
}

const message = `uv-pool-waker build failed:\n${lastError}`
if (optional) {
  process.stderr.write(`[hive] warning: ${message}\n`)
  process.exit(0)
}
process.stderr.write(`${message}\n`)
process.exit(1)
