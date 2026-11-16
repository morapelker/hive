// What goes into the packaged app, decided after the build (scripts/finish-build.mjs runs both):
//
//   - dropSharedWebAssets: the web build (out/renderer-web) and the desktop renderer build
//     (out/renderer) emit the same pictures, animations and fonts under the same
//     content-hashed names; the pet atlases alone are tens of MB. The package keeps the
//     desktop copy only, and the backend answers the Web UI's request for a dropped file from
//     there (src/server/static.ts, sharedAssetsDirFor).
//
//   - findUndeclaredRuntimeImports: electron-builder packs `dependencies` and nothing else.
//     Libraries the renderer uses are compiled into its bundle and listed under
//     `devDependencies`, so they stay out of the package. The main and preload builds bundle
//     a devDependency they import, but the backend build (vite.server.config.ts, SSR) leaves
//     every library as a `require()`; one that is only a devDependency would be missing from
//     the packaged app and fail when first used.
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { extname, join } from 'node:path'

/**
 * File kinds that are never shared: each build has its own code, styles and pages. Must match
 * SHARED_ASSET_EXCLUDED_EXTENSIONS in src/server/static.ts, which refuses to
 * answer these from the desktop copy.
 */
export const NEVER_SHARED_EXTENSIONS = new Set(['.js', '.mjs', '.css', '.html', '.map'])

/**
 * Removes from `webAssetsDir` every file that `rendererAssetsDir` holds under the same name
 * with the same bytes. Returns what was removed.
 */
export function dropSharedWebAssets(rendererAssetsDir, webAssetsDir) {
  const removed = { files: 0, bytes: 0 }
  if (!existsSync(rendererAssetsDir) || !existsSync(webAssetsDir)) return removed

  for (const name of readdirSync(webAssetsDir)) {
    if (NEVER_SHARED_EXTENSIONS.has(extname(name).toLowerCase())) continue
    const webFile = join(webAssetsDir, name)
    const rendererFile = join(rendererAssetsDir, name)
    const webStat = statSync(webFile)
    if (!webStat.isFile() || !existsSync(rendererFile)) continue
    const rendererStat = statSync(rendererFile)
    if (!rendererStat.isFile() || rendererStat.size !== webStat.size) continue
    if (!readFileSync(webFile).equals(readFileSync(rendererFile))) continue
    rmSync(webFile)
    removed.files += 1
    removed.bytes += webStat.size
  }
  return removed
}

const BUILTIN = new Set([...builtinModules, 'electron'])

/** `@scope/name/sub/path` → `@scope/name`, `name/sub` → `name`. */
export function packageNameOf(specifier) {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

/** The libraries a built CommonJS file loads: `require("x")` and `import("x")`. */
export function runtimeImportsOf(source) {
  const names = new Set()
  const pattern = /\b(?:require|import)\(\s*["']([^"'\n]+)["']\s*\)/g
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1]
    if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) {
      continue
    }
    const name = packageNameOf(specifier)
    if (!BUILTIN.has(name)) names.add(name)
  }
  return names
}

function* scriptFilesUnder(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* scriptFilesUnder(path)
    else if (/\.(js|cjs|mjs)$/.test(entry.name)) yield path
  }
}

/**
 * Libraries that the built files under `outDirs` load at runtime although the package lists
 * them under `devDependencies` only. Each entry: `{ name, file }` (the first file that loads it).
 */
export function findUndeclaredRuntimeImports(outDirs, packageJson) {
  const packed = new Set([
    ...Object.keys(packageJson.dependencies ?? {}),
    ...Object.keys(packageJson.optionalDependencies ?? {})
  ])
  const notPacked = new Set(
    Object.keys(packageJson.devDependencies ?? {}).filter((name) => !packed.has(name))
  )
  const found = new Map()
  for (const dir of outDirs) {
    if (!existsSync(dir)) continue
    for (const file of scriptFilesUnder(dir)) {
      for (const name of runtimeImportsOf(readFileSync(file, 'utf8'))) {
        if (notPacked.has(name) && !found.has(name)) found.set(name, file)
      }
    }
  }
  return [...found].map(([name, file]) => ({ name, file }))
}