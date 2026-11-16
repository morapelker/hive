import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { resolveStaticFile, sharedAssetsDirFor } from '../static'

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

// A packaged app keeps one copy of the pictures the web build and the desktop renderer build
// both emit (apps/shell/scripts/finish-build.mjs): the web build's copy is dropped and the
// request is answered from the desktop renderer's assets, a sibling directory.
describe('resolveStaticFile with a shared assets directory', () => {
  let staticDir: string
  let sharedAssetsDir: string

  beforeAll(() => {
    const out = mkdtempSync(join(tmpdir(), 'hive-static-shared-'))
    staticDir = join(out, 'renderer-web')
    mkdirSync(join(staticDir, 'assets'), { recursive: true })
    writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>Hive</title>')
    writeFileSync(join(staticDir, 'assets', 'app.js'), 'console.log("web")')
    writeFileSync(join(staticDir, 'assets', 'own-1a2b3c4d.png'), 'web copy')

    sharedAssetsDir = sharedAssetsDirFor(staticDir)
    mkdirSync(sharedAssetsDir, { recursive: true })
    writeFileSync(join(sharedAssetsDir, 'pug-run-1-z_d1pzzq.webp'), 'atlas')
    writeFileSync(join(sharedAssetsDir, 'own-1a2b3c4d.png'), 'desktop copy')
    writeFileSync(join(sharedAssetsDir, 'App-C072bxnK.js'), 'console.log("desktop")')
    writeFileSync(join(sharedAssetsDir, 'index-Dxdp4qrB.css'), 'body{}')
    writeFileSync(join(out, 'renderer', 'index.html'), '<!doctype html>')
    writeFileSync(join(out, 'secret.webp'), 'outside')
  })

  it('is the desktop renderer assets next to the web build', () => {
    expect(sharedAssetsDirFor('/app/out/renderer-web')).toBe('/app/out/renderer/assets')
  })

  it('serves an asset the web build no longer holds from the shared directory', () => {
    const resolved = resolveStaticFile(
      '/assets/pug-run-1-z_d1pzzq.webp',
      staticDir,
      sharedAssetsDir
    )
    expect(resolved?.filePath).toBe(join(sharedAssetsDir, 'pug-run-1-z_d1pzzq.webp'))
    expect(resolved?.contentType).toBe('image/webp')
  })

  it("prefers the web build's own file", () => {
    const resolved = resolveStaticFile('/assets/own-1a2b3c4d.png', staticDir, sharedAssetsDir)
    expect(resolved?.filePath).toBe(join(staticDir, 'assets', 'own-1a2b3c4d.png'))
  })

  it("never serves the desktop renderer's code or styles", () => {
    expect(resolveStaticFile('/assets/App-C072bxnK.js', staticDir, sharedAssetsDir)).toBeNull()
    expect(resolveStaticFile('/assets/index-Dxdp4qrB.css', staticDir, sharedAssetsDir)).toBeNull()
  })

  it('only answers under /assets/ and stays inside the shared directory', () => {
    expect(resolveStaticFile('/pug-run-1-z_d1pzzq.webp', staticDir, sharedAssetsDir)).toBeNull()
    expect(resolveStaticFile('/assets/../../secret.webp', staticDir, sharedAssetsDir)).toBeNull()
    expect(
      resolveStaticFile('/assets/..%2f..%2fsecret.webp', staticDir, sharedAssetsDir)
    ).toBeNull()
    expect(resolveStaticFile('/assets/missing.webp', staticDir, sharedAssetsDir)).toBeNull()
  })

  it('does not look there when no shared directory is given', () => {
    expect(resolveStaticFile('/assets/pug-run-1-z_d1pzzq.webp', staticDir)).toBeNull()
  })
})
