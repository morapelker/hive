import { createReadStream, statSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'

export interface ResolvedStaticFile {
  readonly filePath: string
  readonly contentType: string
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.lottie': 'application/octet-stream'
}

const contentTypeFor = (filePath: string): string =>
  CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream'

const isFile = (filePath: string): boolean => {
  try {
    return statSync(filePath).isFile()
  } catch {
    return false
  }
}

/** The URL folder Vite emits every hashed asset into, flat. */
const ASSETS_PREFIX = 'assets/'

/**
 * File kinds the shared assets directory never serves: the desktop renderer's own code,
 * styles and pages. The web build always has its own of these.
 */
const SHARED_ASSET_EXCLUDED_EXTENSIONS = new Set(['.js', '.mjs', '.css', '.html', '.map'])

/**
 * The desktop renderer's asset directory, a sibling of the web build
 * (`out/renderer-web` next to `out/renderer/assets`).
 *
 * The web build and the desktop renderer build emit the same pictures, animations and fonts
 * under the same content-hashed names (the pet atlases alone are tens
 * of MB). A packaged app keeps one copy: `scripts/finish-build.mjs` drops from
 * the web build every asset the desktop build already holds, and a request for one of them
 * is answered from here.
 */
export const sharedAssetsDirFor = (staticDir: string): string =>
  resolve(staticDir, '..', 'renderer', 'assets')

const resolveSharedAsset = (relative: string, sharedAssetsDir: string): string | null => {
  if (!relative.startsWith(ASSETS_PREFIX)) return null
  const name = relative.slice(ASSETS_PREFIX.length)
  if (SHARED_ASSET_EXCLUDED_EXTENSIONS.has(extname(name).toLowerCase())) return null

  const root = resolve(sharedAssetsDir)
  const candidate = resolve(root, normalize(name))
  if (!candidate.startsWith(root + sep)) return null
  return isFile(candidate) ? candidate : null
}

/**
 * Resolve a request pathname to a static file under `staticDir`.
 *
 * - `/` maps to `index.html`.
 * - Existing files are served with a content type inferred from their extension.
 * - A missing `/assets/<file>` that is not code is looked up in `sharedAssetsDir`, when one
 *   is given (see `sharedAssetsDirFor`).
 * - Extensionless paths that do not resolve to a file fall back to `index.html`
 *   (the renderer is state-routed, so this handles `/` and browser refreshes).
 * - Paths that escape `staticDir` (traversal) or missing files with an
 *   extension return `null` so the caller can emit a 404.
 */
export const resolveStaticFile = (
  pathname: string,
  staticDir: string,
  sharedAssetsDir: string | null = null
): ResolvedStaticFile | null => {
  const root = resolve(staticDir)
  const indexPath = join(root, 'index.html')

  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }

  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '')
  const candidate = resolve(root, normalize(relative))

  // Guard against path traversal escaping the static root.
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    return null
  }

  if (isFile(candidate)) {
    return { filePath: candidate, contentType: contentTypeFor(candidate) }
  }

  if (sharedAssetsDir) {
    const shared = resolveSharedAsset(relative, sharedAssetsDir)
    if (shared) return { filePath: shared, contentType: contentTypeFor(shared) }
  }

  // SPA fallback: extensionless route that does not map to a real file.
  if (!extname(relative) && isFile(indexPath)) {
    return { filePath: indexPath, contentType: contentTypeFor(indexPath) }
  }

  return null
}

/**
 * Stream a resolved static file to the response. Public (no auth) by design —
 * the web UI must load before any session exists.
 */
export const serveStaticFile = (
  resolved: ResolvedStaticFile,
  response: ServerResponse,
  corsHeaders: Record<string, string> = {}
): void => {
  response.writeHead(200, {
    'Content-Type': resolved.contentType,
    ...corsHeaders
  })
  createReadStream(resolved.filePath)
    .on('error', () => {
      if (!response.headersSent) response.writeHead(500)
      response.end()
    })
    .pipe(response)
}
