import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, normalize, extname, sep } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

const MIME_TYPES: Record<string, string> = {
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.html': 'text/html',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.map': 'application/json'
}

export function createStaticHandler(
  webRoot: string
): (req: IncomingMessage, res: ServerResponse) => boolean {
  const resolvedRoot = normalize(webRoot)

  return (req: IncomingMessage, res: ServerResponse): boolean => {
    const url = req.url ?? '/'
    // Strip query string and hash, decode URI components safely
    let pathname: string
    try {
      pathname = decodeURIComponent(url.split('?')[0].split('#')[0])
    } catch {
      res.writeHead(400)
      res.end()
      return true
    }

    // Pass through GraphQL and API routes
    if (pathname === '/graphql' || pathname.startsWith('/api/')) {
      return false
    }

    // Resolve the file path within webRoot
    const resolved = normalize(join(resolvedRoot, pathname))

    // Path traversal prevention: resolved path must stay within webRoot.
    // Compare against resolvedRoot + '/' to prevent prefix collision
    // (e.g. /tmp/foo matching /tmp/foobar). Allow exact match on root itself.
    if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + sep)) {
      res.writeHead(403)
      res.end()
      return true
    }

    // Try to serve the exact file
    if (existsSync(resolved) && statSync(resolved).isFile()) {
      serveFile(resolved, pathname, res)
      return true
    }

    // SPA fallback: serve index.html for any unmatched path
    const indexPath = join(resolvedRoot, 'index.html')
    if (existsSync(indexPath)) {
      serveFile(indexPath, '/index.html', res)
      return true
    }

    // No index.html available
    res.writeHead(404)
    res.end()
    return true
  }
}

function serveFile(filePath: string, pathname: string, res: ServerResponse): void {
  const ext = extname(filePath)
  const contentType = MIME_TYPES[ext] ?? 'application/octet-stream'

  // Cache headers
  if (pathname === '/index.html') {
    res.setHeader('Cache-Control', 'no-cache')
  } else if (pathname.startsWith('/assets/')) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
  }

  const body = readFileSync(filePath)
  res.writeHead(200, { 'Content-Type': contentType })
  res.end(body)
}
