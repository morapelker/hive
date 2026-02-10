import { describe, test, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const fileViewerDir = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'src',
  'renderer',
  'src',
  'components',
  'file-viewer'
)

function readFile(fileName: string): string {
  return fs.readFileSync(path.join(fileViewerDir, fileName), 'utf-8')
}

describe('Session 6: Markdown Preview', () => {
  describe('isMarkdownFile helper', () => {
    test('isMarkdownFile is exported from FileViewer.tsx', () => {
      const content = readFile('FileViewer.tsx')
      expect(content).toContain('export function isMarkdownFile')
    })

    test('detects .md files', () => {
      const content = readFile('FileViewer.tsx')
      // The function checks for .md and .mdx extensions
      expect(content).toContain("ext === '.md'")
      expect(content).toContain("ext === '.mdx'")
    })

    test('extracts extension using lastIndexOf', () => {
      const content = readFile('FileViewer.tsx')
      expect(content).toContain("filePath.substring(filePath.lastIndexOf('.'))")
    })
  })

  describe('viewMode state', () => {
    test('FileViewer has viewMode state with preview and source options', () => {
      const content = readFile('FileViewer.tsx')
      expect(content).toContain("useState<'preview' | 'source'>")
    })

    test('markdown files default to preview mode', () => {
      const content = readFile('FileViewer.tsx')
      // Initial state is set based on isMarkdown
      expect(content).toContain("isMarkdown ? 'preview' : 'source'")
    })

    test('viewMode resets when filePath changes', () => {
      const content = readFile('FileViewer.tsx')
      // Effect that resets viewMode on filePath change
      expect(content).toContain('setViewMode(isMarkdownFile(filePath)')
      expect(content).toMatch(
        /useEffect\(\(\) => \{[\s\S]*?setViewMode\(isMarkdownFile\(filePath\)[\s\S]*?\}, \[filePath\]\)/
      )
    })
  })

  describe('Source/Preview toggle', () => {
    test('renders Source and Preview toggle buttons', () => {
      const content = readFile('FileViewer.tsx')
      expect(content).toMatch(/>\s*Source\s*</)
      expect(content).toMatch(/>\s*Preview\s*</)
    })

    test('toggle only appears for markdown files', () => {
      const content = readFile('FileViewer.tsx')
      // Conditionally renders based on isMarkdown
      expect(content).toContain('{isMarkdown && (')
    })

    test('Source button sets viewMode to source', () => {
      const content = readFile('FileViewer.tsx')
      expect(content).toContain("setViewMode('source')")
    })

    test('Preview button sets viewMode to preview', () => {
      const content = readFile('FileViewer.tsx')
      expect(content).toContain("setViewMode('preview')")
    })

    test('active toggle uses accent styling', () => {
      const content = readFile('FileViewer.tsx')
      expect(content).toContain("viewMode === 'source' ? 'bg-accent text-accent-foreground'")
      expect(content).toContain("viewMode === 'preview' ? 'bg-accent text-accent-foreground'")
    })

    test('toggle buttons have data-testid attributes', () => {
      const content = readFile('FileViewer.tsx')
      expect(content).toContain('data-testid="source-toggle"')
      expect(content).toContain('data-testid="preview-toggle"')
    })
  })

  describe('conditional rendering', () => {
    test('renders MarkdownRenderer in preview mode', () => {
      const content = readFile('FileViewer.tsx')
      expect(content).toContain('<MarkdownRenderer content={content} />')
    })

    test('MarkdownRenderer is imported', () => {
      const content = readFile('FileViewer.tsx')
      expect(content).toContain(
        "import { MarkdownRenderer } from '@/components/sessions/MarkdownRenderer'"
      )
    })

    test('preview mode condition checks both viewMode and isMarkdown', () => {
      const content = readFile('FileViewer.tsx')
      expect(content).toContain("viewMode === 'preview' && isMarkdown")
    })

    test('markdown preview has prose styling', () => {
      const content = readFile('FileViewer.tsx')
      expect(content).toContain('prose prose-sm dark:prose-invert max-w-none')
    })

    test('markdown preview has data-testid', () => {
      const content = readFile('FileViewer.tsx')
      expect(content).toContain('data-testid="file-viewer-markdown-preview"')
    })

    test('SyntaxHighlighter still renders in source mode', () => {
      const content = readFile('FileViewer.tsx')
      expect(content).toContain('<SyntaxHighlighter')
      expect(content).toContain('data-testid="file-viewer-content"')
    })

    test('cn utility is imported for toggle styling', () => {
      const content = readFile('FileViewer.tsx')
      expect(content).toContain("import { cn } from '@/lib/utils'")
    })
  })

  describe('MarkdownRenderer compatibility', () => {
    test('MarkdownRenderer accepts content prop', () => {
      const mdRendererPath = path.join(fileViewerDir, '..', 'sessions', 'MarkdownRenderer.tsx')
      const content = fs.readFileSync(mdRendererPath, 'utf-8')
      expect(content).toContain('content: string')
      expect(content).toContain('MarkdownRendererProps')
    })

    test('MarkdownRenderer uses react-markdown with remark-gfm', () => {
      const mdRendererPath = path.join(fileViewerDir, '..', 'sessions', 'MarkdownRenderer.tsx')
      const content = fs.readFileSync(mdRendererPath, 'utf-8')
      expect(content).toContain('ReactMarkdown')
      expect(content).toContain('remarkGfm')
    })

    test('MarkdownRenderer renders links with target=_blank', () => {
      const mdRendererPath = path.join(fileViewerDir, '..', 'sessions', 'MarkdownRenderer.tsx')
      const content = fs.readFileSync(mdRendererPath, 'utf-8')
      expect(content).toContain('target="_blank"')
      expect(content).toContain('rel="noopener noreferrer"')
    })
  })

  describe('search compatibility', () => {
    test('FileSearch still renders in both modes', () => {
      const content = readFile('FileViewer.tsx')
      // FileSearch is above the conditional content area, so it works in both modes
      expect(content).toContain('<FileSearch')
      expect(content).toContain('searchOpen &&')
    })
  })
})
