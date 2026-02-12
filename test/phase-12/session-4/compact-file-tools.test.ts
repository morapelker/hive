import { describe, test, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const sessionsDir = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'src',
  'renderer',
  'src',
  'components',
  'sessions'
)

function readFile(fileName: string): string {
  return fs.readFileSync(path.join(sessionsDir, fileName), 'utf-8')
}

describe('Session 4: Compact File Tools', () => {
  describe('isFileOperation detection', () => {
    test('isFileOperation is exported from ToolCard.tsx', () => {
      const content = readFile('ToolCard.tsx')
      expect(content).toContain('export function isFileOperation')
    })

    test('detects read tool variants', () => {
      const content = readFile('ToolCard.tsx')
      // The function should match read, cat, view
      expect(content).toContain("lower.includes('read')")
      expect(content).toContain("lower === 'cat'")
      expect(content).toContain("lower === 'view'")
    })

    test('detects write tool variants', () => {
      const content = readFile('ToolCard.tsx')
      expect(content).toContain("lower.includes('write')")
      expect(content).toContain("lower === 'create'")
    })

    test('detects edit tool variants', () => {
      const content = readFile('ToolCard.tsx')
      expect(content).toContain("lower.includes('edit')")
      expect(content).toContain("lower.includes('replace')")
      expect(content).toContain("lower.includes('patch')")
    })

    test('does not match non-file tools', () => {
      // Verify the function only checks file-related names
      const content = readFile('ToolCard.tsx')
      // isFileOperation should not include bash, grep, glob, task, question
      const fnMatch = content.match(/export function isFileOperation[\s\S]*?^}/m)
      expect(fnMatch).toBeTruthy()
      const fnBody = fnMatch![0]
      expect(fnBody).not.toContain("'bash'")
      expect(fnBody).not.toContain("'grep'")
      expect(fnBody).not.toContain("'glob'")
      expect(fnBody).not.toContain("'task'")
      expect(fnBody).not.toContain("'question'")
    })
  })

  describe('CompactFileToolCard component', () => {
    test('CompactFileToolCard exists as internal component', () => {
      const content = readFile('ToolCard.tsx')
      expect(content).toContain('CompactFileToolCard')
      expect(content).toContain('compact-file-tool')
    })

    test('uses Plus, Minus, Loader2, and X icons for states', () => {
      const content = readFile('ToolCard.tsx')
      // Extract the CompactFileToolCard section
      const compactStart = content.indexOf('const CompactFileToolCard')
      const compactEnd = content.indexOf('interface ToolCardProps')
      const compactSection = content.slice(compactStart, compactEnd)

      // Expanded state shows Minus
      expect(compactSection).toContain('<Minus')
      // Running state shows Loader2 spinner
      expect(compactSection).toContain('<Loader2')
      expect(compactSection).toContain('animate-spin')
      // Error state shows X
      expect(compactSection).toContain('<X')
      // Success collapsed shows Plus
      expect(compactSection).toContain('<Plus')
    })

    test('has no border, no card background, no left color accent', () => {
      const content = readFile('ToolCard.tsx')
      const compactStart = content.indexOf('const CompactFileToolCard')
      const compactEnd = content.indexOf('interface ToolCardProps')
      const compactSection = content.slice(compactStart, compactEnd)

      // Should not use border-l-2 or borderLeftColor
      expect(compactSection).not.toContain('border-l-2')
      expect(compactSection).not.toContain('borderLeftColor')
      // Should not use the card wrapper classes from the regular ToolCard
      expect(compactSection).not.toContain('rounded-md border border-l-2')
    })

    test('renders file path using shortenPath', () => {
      const content = readFile('ToolCard.tsx')
      const compactStart = content.indexOf('const CompactFileToolCard')
      const compactEnd = content.indexOf('interface ToolCardProps')
      const compactSection = content.slice(compactStart, compactEnd)

      expect(compactSection).toContain('shortenPath')
      expect(compactSection).toContain('filePath')
    })

    test('shows tool label (Read, Write, or Edit)', () => {
      const content = readFile('ToolCard.tsx')
      expect(content).toContain('getFileToolLabel')
      // Should resolve to Read, Write, or Edit
      const labelFn = content.match(/function getFileToolLabel[\s\S]*?^}/m)
      expect(labelFn).toBeTruthy()
      const fnBody = labelFn![0]
      expect(fnBody).toContain("return 'Read'")
      expect(fnBody).toContain("return 'Write'")
      expect(fnBody).toContain("return 'Edit'")
    })

    test('error state applies red text to file path', () => {
      const content = readFile('ToolCard.tsx')
      const compactStart = content.indexOf('const CompactFileToolCard')
      const compactEnd = content.indexOf('interface ToolCardProps')
      const compactSection = content.slice(compactStart, compactEnd)

      expect(compactSection).toContain('text-red-400')
      expect(compactSection).toContain('isError')
    })

    test('expanded content is indented with ml-5', () => {
      const content = readFile('ToolCard.tsx')
      const compactStart = content.indexOf('const CompactFileToolCard')
      const compactEnd = content.indexOf('interface ToolCardProps')
      const compactSection = content.slice(compactStart, compactEnd)

      expect(compactSection).toContain('ml-5')
    })

    test('uses getToolRenderer for expanded view', () => {
      const content = readFile('ToolCard.tsx')
      const compactStart = content.indexOf('const CompactFileToolCard')
      const compactEnd = content.indexOf('interface ToolCardProps')
      const compactSection = content.slice(compactStart, compactEnd)

      expect(compactSection).toContain('getToolRenderer')
      expect(compactSection).toContain('<Renderer')
    })
  })

  describe('ToolCard routing', () => {
    test('ToolCard routes file operations to CompactFileToolCard', () => {
      const content = readFile('ToolCard.tsx')
      // The main ToolCard should check isFileOperation and return CompactFileToolCard
      const toolCardExport = content.slice(content.indexOf('export const ToolCard'))
      expect(toolCardExport).toContain('isFileOperation(toolUse.name)')
      expect(toolCardExport).toContain('CompactFileToolCard')
    })

    test('non-file tools still use the bordered card layout', () => {
      const content = readFile('ToolCard.tsx')
      // After the isFileOperation check, the rest of the ToolCard still has
      // the bordered card layout with data-testid="tool-card"
      const toolCardExport = content.slice(content.indexOf('export const ToolCard'))
      expect(toolCardExport).toContain('data-testid="tool-card"')
      expect(toolCardExport).toContain('border-l-2')
      expect(toolCardExport).toContain('borderLeftColor')
    })
  })

  describe('data-testid attributes', () => {
    test('compact file tool has data-testid="compact-file-tool"', () => {
      const content = readFile('ToolCard.tsx')
      expect(content).toContain('data-testid="compact-file-tool"')
    })

    test('regular tool card still has data-testid="tool-card"', () => {
      const content = readFile('ToolCard.tsx')
      expect(content).toContain('data-testid="tool-card"')
    })

    test('spinner has data-testid="tool-spinner"', () => {
      const content = readFile('ToolCard.tsx')
      const compactStart = content.indexOf('const CompactFileToolCard')
      const compactEnd = content.indexOf('interface ToolCardProps')
      const compactSection = content.slice(compactStart, compactEnd)

      expect(compactSection).toContain('data-testid="tool-spinner"')
    })
  })
})
