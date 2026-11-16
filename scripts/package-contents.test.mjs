// node --test scripts/package-contents.test.mjs  (pnpm test:package:contents)
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  dropSharedWebAssets,
  findUndeclaredRuntimeImports,
  packageNameOf,
  runtimeImportsOf
} from './package-contents.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const makeOut = () => {
  const out = mkdtempSync(join(tmpdir(), 'hive-package-contents-'))
  const renderer = join(out, 'renderer', 'assets')
  const web = join(out, 'renderer-web', 'assets')
  mkdirSync(renderer, { recursive: true })
  mkdirSync(web, { recursive: true })
  return { out, renderer, web }
}

test('dropSharedWebAssets removes the web copy of a file the desktop build holds', () => {
  const { renderer, web } = makeOut()
  writeFileSync(join(renderer, 'pug-run-1-z_d1pzzq.webp'), 'atlas bytes')
  writeFileSync(join(web, 'pug-run-1-z_d1pzzq.webp'), 'atlas bytes')
  writeFileSync(join(renderer, 'bee-1dOy32yk.png'), 'badge')
  writeFileSync(join(web, 'bee-1dOy32yk.png'), 'badge')

  const removed = dropSharedWebAssets(renderer, web)

  assert.deepEqual(removed, { files: 2, bytes: 'atlas bytes'.length + 'badge'.length })
  assert.deepEqual(readdirSync(web), [])
  assert.equal(readFileSync(join(renderer, 'pug-run-1-z_d1pzzq.webp'), 'utf8'), 'atlas bytes')
})

test('dropSharedWebAssets keeps what differs, what is only in the web build, and all code', () => {
  const { renderer, web } = makeOut()
  // Same name, same size, other bytes.
  writeFileSync(join(renderer, 'icon-BsQ1jSR3.png'), 'aaaa')
  writeFileSync(join(web, 'icon-BsQ1jSR3.png'), 'bbbb')
  // Same name, other size.
  writeFileSync(join(renderer, 'bee-CI1VOmt_.png'), 'short')
  writeFileSync(join(web, 'bee-CI1VOmt_.png'), 'longer bytes')
  // Web only.
  writeFileSync(join(web, 'web-only-AAAAAAAA.webp'), 'x')
  // Identical code, styles and pages are still not shared.
  for (const name of ['App-C072bxnK.js', 'index-Dxdp4qrB.css', 'chunk.mjs', 'x.html', 'a.js.map']) {
    writeFileSync(join(renderer, name), 'same')
    writeFileSync(join(web, name), 'same')
  }
  // A directory under the same name is left alone.
  mkdirSync(join(renderer, 'nested'))
  mkdirSync(join(web, 'nested'))

  const removed = dropSharedWebAssets(renderer, web)

  assert.deepEqual(removed, { files: 0, bytes: 0 })
  assert.equal(readdirSync(web).length, 9)
})

test('dropSharedWebAssets does nothing when a build is missing', () => {
  const { out, web } = makeOut()
  writeFileSync(join(web, 'pug-run-1-z_d1pzzq.webp'), 'atlas bytes')
  assert.deepEqual(dropSharedWebAssets(join(out, 'nope'), web), { files: 0, bytes: 0 })
  assert.deepEqual(dropSharedWebAssets(web, join(out, 'nope')), { files: 0, bytes: 0 })
  assert.equal(existsSync(join(web, 'pug-run-1-z_d1pzzq.webp')), true)
})

test('packageNameOf strips the path inside a package', () => {
  assert.equal(packageNameOf('effect'), 'effect')
  assert.equal(packageNameOf('effect/Schema'), 'effect')
  assert.equal(packageNameOf('@noble/curves/ed25519.js'), '@noble/curves')
})

test('runtimeImportsOf reads require() and import(), not builtins or relative paths', () => {
  const source = `
    const a = require("better-sqlite3")
    const b = require('@noble/curves/ed25519.js')
    const c = await import("mongodb")
    const d = require("node:fs"), e = require("path"), f = require("electron")
    const g = require("./chunks/x.js"), h = require("/abs/path.js")
    const text = "import x from 'react'"
  `
  assert.deepEqual([...runtimeImportsOf(source)].sort(), [
    '@noble/curves',
    'better-sqlite3',
    'mongodb'
  ])
})

test('findUndeclaredRuntimeImports names a devDependency the built output loads', () => {
  const { out } = makeOut()
  const main = join(out, 'main')
  mkdirSync(join(main, 'server-chunks'), { recursive: true })
  writeFileSync(join(main, 'index.js'), 'const a = require("effect"); require("ws")')
  writeFileSync(join(main, 'server-chunks', 'x-AAAAAAAA.js'), 'require("qrcode"); require("effect")')
  writeFileSync(join(main, 'notes.txt'), 'require("react")')

  const packageJson = {
    dependencies: { effect: '1', ws: '1' },
    devDependencies: { qrcode: '1', react: '1', ws: '1' }
  }
  assert.deepEqual(findUndeclaredRuntimeImports([main, join(out, 'missing')], packageJson), [
    { name: 'qrcode', file: join(main, 'server-chunks', 'x-AAAAAAAA.js') }
  ])
  assert.deepEqual(
    findUndeclaredRuntimeImports([main], {
      dependencies: { effect: '1', ws: '1', qrcode: '1' },
      devDependencies: { react: '1' }
    }),
    []
  )
})

// The libraries the main process, the preload and the backend are known to load. A renderer
// library moving up here is fine; one of these moving to devDependencies would leave the
// packaged app without it.
test('package.json lists the libraries the main process and the backend load as dependencies', () => {
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const runtime = [
    '@anthropic-ai/claude-agent-sdk',
    '@clickhouse/client',
    '@electron-toolkit/utils',
    '@mongodb-js/shell-bson-parser',
    '@opencode-ai/sdk',
    'acorn',
    'better-sqlite3',
    'chokidar',
    'discord.js',
    'effect',
    'electron-updater',
    'mongodb',
    'mysql2',
    'node-pty',
    'pg',
    'pg-cursor',
    'posthog-node',
    'sherpa-onnx-node',
    'simple-git',
    'ssh2',
    'ws',
    'yaml',
    'zod'
  ]
  const missing = runtime.filter((name) => !(name in packageJson.dependencies))
  assert.deepEqual(missing, [])
})