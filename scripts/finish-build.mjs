#!/usr/bin/env node
// Last step of `pnpm build`, after the main/preload/renderer build (electron-vite), the backend
// build (vite.server.config.ts) and the web build (vite.web.config.ts). It settles what the
// package holds (scripts/package-contents.mjs): one copy of the pictures both renderer builds
// emit, and no library the built code loads left unpacked.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { dropSharedWebAssets, findUndeclaredRuntimeImports } from './package-contents.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outMain = resolve(root, 'out/main')

if (!existsSync(outMain)) {
  process.stderr.write('ERROR: out/main is missing: run the builds before finish-build\n')
  process.exit(1)
}

if (existsSync(resolve(root, 'out/renderer-web'))) {
  const shared = dropSharedWebAssets(
    resolve(root, 'out/renderer/assets'),
    resolve(root, 'out/renderer-web/assets')
  )
  process.stdout.write(
    `finish-build: ${shared.files} web UI assets (${(shared.bytes / 1048576).toFixed(1)} MB) ` +
      'are served from out/renderer/assets instead of a second copy\n'
  )
} else {
  process.stderr.write('note: out/renderer-web missing (build:web not run): the web UI is not served\n')
}

const undeclared = findUndeclaredRuntimeImports(
  [outMain, resolve(root, 'out/preload')],
  JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
)
if (undeclared.length > 0) {
  process.stderr.write(
    'ERROR: the built main process, preload or backend loads libraries that the packaged app\n' +
      'would not contain. electron-builder packs only package.json "dependencies";\n' +
      'move these there from "devDependencies":\n' +
      undeclared.map(({ name, file }) => `  ${name}  (${relative(root, file)})\n`).join('')
  )
  process.exit(1)
}
