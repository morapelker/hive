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

/**
 * Resolve a request pathname to a static file under `staticDir`.
 *
 * - `/` maps to `index.html`.
 * - Existing files are served with a content type inferred from their extension.
 * - Extensionless paths that do not resolve to a file fall back to `index.html`
 *   (the renderer is state-routed, so this handles `/` and browser refreshes).
 * - Paths that escape `staticDir` (traversal) or missing files with an
 *   extension return `null` so the caller can emit a 404.
 */
export const resolveStaticFile = (
  pathname: string,
  staticDir: string
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
