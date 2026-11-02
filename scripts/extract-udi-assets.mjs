// Pulls Udi's approved assets out of the standalone study page (docs/udi-preview.html) into the
// pet registry, so the page stays the single source of truth for the artwork:
//   - the idle portrait (PNG)
//   - the "Smooth · 64 fps" atlases (8x8, 64 frames, 352 px cells, lossless WebP) for the
//     levels the manifest references. Level 2 reuses level 1 and level 5 reuses level 4.
// Badge anchors and the level copy live in the manifest and are not extracted.
//
//   pnpm extract:udi
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'docs/udi-preview.html')
const target = join(root, 'src/renderer/src/pet/registry/german-shepherd/assets')
const html = readFileSync(source, 'utf8')

function asset(id) {
  const match = html.match(new RegExp(`<script id="${id}" type="application/octet-stream">([^<]+)</script>`))
  if (!match) throw new Error(`${id} not found in ${source}`)
  return Buffer.from(match[1].trim(), 'base64')
}

mkdirSync(target, { recursive: true })
const written = []
const idle = join(target, 'german-shepherd.png')
writeFileSync(idle, asset('idle-asset'))
written.push(idle)
for (const level of [1, 3, 4, 10, 15, 20]) {
  const file = join(target, `german-shepherd-run-${level}.webp`)
  writeFileSync(file, asset(`smooth-asset-${level}`))
  written.push(file)
}
for (const file of written) console.log(file)
