import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  findProjectRoot,
  getServersForFile,
  TypescriptServer,
  GoplsServer,
  PyrightServer,
  RustAnalyzerServer,
  ALL_SERVERS
} from '../../src/main/services/lsp/lsp-servers'

describe('findProjectRoot', () => {
  let tmpDir: string

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('finds tsconfig.json marker in a nested directory structure', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-root-test-'))
    const nested = path.join(tmpDir, 'src', 'components')
    fs.mkdirSync(nested, { recursive: true })
    fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{}')

    const filePath = path.join(nested, 'App.tsx')
    const root = findProjectRoot(filePath, ['tsconfig.json'], tmpDir)
    expect(root).toBe(tmpDir)
  })

  it('returns stopDir when no marker exists', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-root-test-'))
    const nested = path.join(tmpDir, 'src', 'deep')
    fs.mkdirSync(nested, { recursive: true })

    const filePath = path.join(nested, 'file.ts')
    const root = findProjectRoot(filePath, ['tsconfig.json', 'package.json'], tmpDir)
    expect(root).toBe(tmpDir)
  })

  it('finds the closest marker when multiple exist', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-root-test-'))
    const subProject = path.join(tmpDir, 'packages', 'app')
    const deepDir = path.join(subProject, 'src')
    fs.mkdirSync(deepDir, { recursive: true })

    // Root tsconfig
    fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{}')
    // Sub-project tsconfig (closer to the file)
    fs.writeFileSync(path.join(subProject, 'tsconfig.json'), '{}')

    const filePath = path.join(deepDir, 'index.ts')
    const root = findProjectRoot(filePath, ['tsconfig.json'], tmpDir)
    expect(root).toBe(subProject)
  })
})

describe('getServersForFile', () => {
  it('returns TypescriptServer for .ts files', () => {
    const servers = getServersForFile('/path/to/file.ts')
    expect(servers).toContain(TypescriptServer)
    expect(servers).toHaveLength(1)
  })

  it('returns TypescriptServer for .tsx files (JSX variant)', () => {
    const servers = getServersForFile('/path/to/file.tsx')
    expect(servers).toContain(TypescriptServer)
    expect(servers).toHaveLength(1)
  })

  it('returns TypescriptServer for .js files', () => {
    const servers = getServersForFile('/path/to/file.js')
    expect(servers).toContain(TypescriptServer)
  })

  it('returns TypescriptServer for .mjs files', () => {
    const servers = getServersForFile('/path/to/file.mjs')
    expect(servers).toContain(TypescriptServer)
  })

  it('returns GoplsServer for .go files', () => {
    const servers = getServersForFile('/path/to/file.go')
    expect(servers).toContain(GoplsServer)
    expect(servers).toHaveLength(1)
  })

  it('returns PyrightServer for .py files', () => {
    const servers = getServersForFile('/path/to/file.py')
    expect(servers).toContain(PyrightServer)
    expect(servers).toHaveLength(1)
  })

  it('returns PyrightServer for .pyi files', () => {
    const servers = getServersForFile('/path/to/file.pyi')
    expect(servers).toContain(PyrightServer)
  })

  it('returns RustAnalyzerServer for .rs files', () => {
    const servers = getServersForFile('/path/to/file.rs')
    expect(servers).toContain(RustAnalyzerServer)
    expect(servers).toHaveLength(1)
  })

  it('returns empty array for .txt files (no matching server)', () => {
    const servers = getServersForFile('/path/to/file.txt')
    expect(servers).toEqual([])
  })

  it('returns empty array for files with no extension', () => {
    const servers = getServersForFile('/path/to/Makefile')
    expect(servers).toEqual([])
  })
})

describe('ALL_SERVERS', () => {
  it('contains all 4 server definitions', () => {
    expect(ALL_SERVERS).toHaveLength(4)
    expect(ALL_SERVERS).toContain(TypescriptServer)
    expect(ALL_SERVERS).toContain(GoplsServer)
    expect(ALL_SERVERS).toContain(PyrightServer)
    expect(ALL_SERVERS).toContain(RustAnalyzerServer)
  })
})

describe('server definitions', () => {
  it('TypescriptServer has correct id and extensions', () => {
    expect(TypescriptServer.id).toBe('typescript')
    expect(TypescriptServer.extensions).toContain('.ts')
    expect(TypescriptServer.extensions).toContain('.tsx')
    expect(TypescriptServer.extensions).toContain('.js')
    expect(TypescriptServer.extensions).toContain('.jsx')
    expect(TypescriptServer.extensions).toContain('.mjs')
    expect(TypescriptServer.extensions).toContain('.cjs')
    expect(TypescriptServer.extensions).toContain('.mts')
    expect(TypescriptServer.extensions).toContain('.cts')
    expect(TypescriptServer.rootMarkers).toContain('tsconfig.json')
    expect(TypescriptServer.rootMarkers).toContain('package.json')
  })

  it('GoplsServer has correct id and extensions', () => {
    expect(GoplsServer.id).toBe('gopls')
    expect(GoplsServer.extensions).toEqual(['.go'])
    expect(GoplsServer.rootMarkers).toContain('go.mod')
    expect(GoplsServer.rootMarkers).toContain('go.sum')
  })

  it('PyrightServer has correct id and extensions', () => {
    expect(PyrightServer.id).toBe('pyright')
    expect(PyrightServer.extensions).toEqual(['.py', '.pyi'])
    expect(PyrightServer.rootMarkers).toContain('pyproject.toml')
    expect(PyrightServer.rootMarkers).toContain('setup.py')
    expect(PyrightServer.rootMarkers).toContain('requirements.txt')
  })

  it('RustAnalyzerServer has correct id and extensions', () => {
    expect(RustAnalyzerServer.id).toBe('rust-analyzer')
    expect(RustAnalyzerServer.extensions).toEqual(['.rs'])
    expect(RustAnalyzerServer.rootMarkers).toEqual(['Cargo.toml'])
  })

  it('server spawn returns undefined when binary not found (does not throw)', async () => {
    // Use a server that requires a specific binary (like gopls or rust-analyzer)
    // Even if the binary doesn't exist, spawn should return undefined, not throw
    // We test this by checking that the function resolves (doesn't reject)
    const result = await RustAnalyzerServer.spawn('/tmp/nonexistent-project')
    // Result is either a handle (if binary exists) or undefined (if not)
    if (result) {
      // Clean up the spawned process
      result.process.kill()
    }
    expect(result === undefined || result?.process !== undefined).toBe(true)
  })
})
