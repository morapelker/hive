import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { resolveStaticFile } from '../static'

describe('resolveStaticFile', () => {
  let staticDir: string

  beforeAll(() => {
    staticDir = mkdtempSync(join(tmpdir(), 'hive-static-'))
    writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>Hive</title>')
    mkdirSync(join(staticDir, 'assets'))
    writeFileSync(join(staticDir, 'assets', 'app.js'), 'console.log(1)')
    writeFileSync(join(staticDir, 'assets', 'app.css'), 'body{}')
  })

  it('maps "/" to index.html with an HTML content type', () => {
    const resolved = resolveStaticFile('/', staticDir)
    expect(resolved?.filePath).toBe(join(staticDir, 'index.html'))
    expect(resolved?.contentType).toContain('text/html')
  })

  it('serves a JS asset with a JavaScript content type', () => {
    const resolved = resolveStaticFile('/assets/app.js', staticDir)
    expect(resolved?.filePath).toBe(join(staticDir, 'assets', 'app.js'))
    expect(resolved?.contentType).toContain('javascript')
  })

  it('serves a CSS asset with a CSS content type', () => {
    const resolved = resolveStaticFile('/assets/app.css', staticDir)
    expect(resolved?.contentType).toContain('text/css')
  })

  it('falls back to index.html for extensionless SPA routes', () => {
    const resolved = resolveStaticFile('/projects/some-route', staticDir)
    expect(resolved?.filePath).toBe(join(staticDir, 'index.html'))
  })

  it('returns null for a missing file that has an extension', () => {
    expect(resolveStaticFile('/assets/missing.js', staticDir)).toBeNull()
  })

  it('blocks path traversal outside the static directory', () => {
    expect(resolveStaticFile('/../secret.txt', staticDir)).toBeNull()
    expect(resolveStaticFile('/..%2f..%2fsecret', staticDir)).toBeNull()
  })
})
