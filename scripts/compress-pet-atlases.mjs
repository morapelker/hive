// Re-encodes the lossless run-cycle atlases of the pet registry as lossy WebP, the way they
// ship: quality 90 for the colours, 95 for the transparency (cwebp -q 90 -alpha_q 95 -m 6).
// The settings were approved pet by pet against the lossless originals on 16 Nov 2026 (Udi,
// Bella, Twix, Shiba) and earlier for Milla: no visible difference at the desktop sizes, about a
// third of the bytes. The four pets went from 104 MB to 36 MB.
//
// The extract scripts (extract:pug, extract:french-bulldog, extract:udi) and a new art package
// write lossless atlases; run this after them. An atlas that is already lossy is left alone,
// so the script can be run again at any time.
//
//   pnpm -C apps/hive compress:pets            # every pet
//   pnpm -C apps/hive compress:pets pug bella  # only these
//
// Needs `cwebp` on the PATH (macOS: `brew install webp`).
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, renameSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const QUALITY = '90'
const ALPHA_QUALITY = '95'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const registry = join(root, 'src/renderer/src/pet/registry')

/** True when the WebP file stores its picture in a lossless (VP8L) chunk. */
export function isLosslessWebp(bytes) {
  if (bytes.length < 16 || bytes.toString('latin1', 0, 4) !== 'RIFF') return false
  if (bytes.toString('latin1', 8, 12) !== 'WEBP') return false
  let offset = 12
  while (offset + 8 <= bytes.length) {
    const tag = bytes.toString('latin1', offset, offset + 4)
    if (tag === 'VP8L') return true
    if (tag === 'VP8 ') return false
    const size = bytes.readUInt32LE(offset + 4)
    offset += 8 + size + (size % 2)
  }
  return false
}

function main() {
  const wanted = process.argv.slice(2)
  const pets = readdirSync(registry, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(registry, entry.name, 'assets')))
    .map((entry) => entry.name)
    .filter((name) => wanted.length === 0 || wanted.includes(name))
  const unknown = wanted.filter((name) => !pets.includes(name))
  if (unknown.length > 0) {
    throw new Error(`no such pet in the registry: ${unknown.join(', ')}`)
  }

  const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`
  let before = 0
  let after = 0
  for (const pet of pets) {
    const assets = join(registry, pet, 'assets')
    for (const name of readdirSync(assets).sort()) {
      if (!/-run-\d+\.webp$/.test(name)) continue
      const file = join(assets, name)
      if (!isLosslessWebp(readFileSync(file))) continue
      const size = statSync(file).size
      const output = `${file}.tmp`
      execFileSync(
        'cwebp',
        ['-quiet', '-q', QUALITY, '-alpha_q', ALPHA_QUALITY, '-m', '6', file, '-o', output],
        { stdio: 'inherit' }
      )
      renameSync(output, file)
      before += size
      after += statSync(file).size
      console.log(`${pet}/${name}: ${mb(size)} -> ${mb(statSync(file).size)}`)
    }
  }
  console.log(before === 0 ? 'nothing to compress' : `total: ${mb(before)} -> ${mb(after)}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
