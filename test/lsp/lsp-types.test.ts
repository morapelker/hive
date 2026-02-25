import { describe, it, expect } from 'vitest'
import { LANGUAGE_EXTENSIONS } from '../../src/main/services/lsp/lsp-language-map'
import { LSP_OPERATIONS } from '../../src/main/services/lsp/lsp-types'

describe('LANGUAGE_EXTENSIONS', () => {
  it('maps .ts to typescript', () => {
    expect(LANGUAGE_EXTENSIONS['.ts']).toBe('typescript')
  })

  it('maps .py to python', () => {
    expect(LANGUAGE_EXTENSIONS['.py']).toBe('python')
  })

  it('maps .go to go', () => {
    expect(LANGUAGE_EXTENSIONS['.go']).toBe('go')
  })

  it('maps .rs to rust', () => {
    expect(LANGUAGE_EXTENSIONS['.rs']).toBe('rust')
  })

  it('maps .tsx to typescriptreact', () => {
    expect(LANGUAGE_EXTENSIONS['.tsx']).toBe('typescriptreact')
  })

  it('maps .js to javascript', () => {
    expect(LANGUAGE_EXTENSIONS['.js']).toBe('javascript')
  })

  it('maps .jsx to javascriptreact', () => {
    expect(LANGUAGE_EXTENSIONS['.jsx']).toBe('javascriptreact')
  })

  it('covers all required extensions', () => {
    const required = ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs']
    for (const ext of required) {
      expect(LANGUAGE_EXTENSIONS).toHaveProperty(ext)
    }
  })
})

describe('LSP_OPERATIONS', () => {
  it('contains all 9 operation strings', () => {
    expect(LSP_OPERATIONS).toHaveLength(9)
  })

  it('includes goToDefinition', () => {
    expect(LSP_OPERATIONS).toContain('goToDefinition')
  })

  it('includes hover', () => {
    expect(LSP_OPERATIONS).toContain('hover')
  })

  it('includes findReferences', () => {
    expect(LSP_OPERATIONS).toContain('findReferences')
  })

  it('includes documentSymbol', () => {
    expect(LSP_OPERATIONS).toContain('documentSymbol')
  })

  it('includes workspaceSymbol', () => {
    expect(LSP_OPERATIONS).toContain('workspaceSymbol')
  })

  it('includes goToImplementation', () => {
    expect(LSP_OPERATIONS).toContain('goToImplementation')
  })

  it('includes incomingCalls', () => {
    expect(LSP_OPERATIONS).toContain('incomingCalls')
  })

  it('includes outgoingCalls', () => {
    expect(LSP_OPERATIONS).toContain('outgoingCalls')
  })

  it('includes diagnostics', () => {
    expect(LSP_OPERATIONS).toContain('diagnostics')
  })
})
