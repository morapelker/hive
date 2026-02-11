import { describe, test, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const markdownRendererPath = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'src',
  'renderer',
  'src',
  'components',
  'sessions',
  'MarkdownRenderer.tsx'
)

const codeBlockPath = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'src',
  'renderer',
  'src',
  'components',
  'sessions',
  'CodeBlock.tsx'
)

function readMarkdownRenderer(): string {
  return fs.readFileSync(markdownRendererPath, 'utf-8')
}

function readCodeBlock(): string {
  return fs.readFileSync(codeBlockPath, 'utf-8')
}

describe('Session 1: Markdown Code Block Fix', () => {
  describe('code component override', () => {
    test('extracts content string before isBlock check', () => {
      const content = readMarkdownRenderer()
      // content should be extracted as String(children) before the isBlock condition
      expect(content).toContain('const content = String(children)')
    })

    test('isBlock detects multiline content (bare fenced blocks)', () => {
      const content = readMarkdownRenderer()
      // isBlock should check for newlines in content, not just language match
      expect(content).toContain("content.includes('\\n')")
    })

    test('isBlock condition includes both language match and newline check', () => {
      const content = readMarkdownRenderer()
      expect(content).toContain('const isBlock = match !== null || content.includes')
    })

    test('uses optional chaining for language fallback to text', () => {
      const content = readMarkdownRenderer()
      // Should use match?.[1] ?? 'text' instead of match![1]
      expect(content).toContain("match?.[1] ?? 'text'")
    })

    test('does not use non-null assertion on match', () => {
      const content = readMarkdownRenderer()
      // match![1] should no longer be present
      expect(content).not.toContain('match![1]')
    })

    test('uses content variable for code extraction', () => {
      const content = readMarkdownRenderer()
      // Should use content.replace instead of String(children).replace
      expect(content).toContain("const code = content.replace(/\\n$/, '')")
    })

    test('passes language to CodeBlock component', () => {
      const content = readMarkdownRenderer()
      expect(content).toContain("<CodeBlock code={code} language={match?.[1] ?? 'text'} />")
    })
  })

  describe('inline code is unaffected', () => {
    test('inline code renders with bg-muted styling', () => {
      const content = readMarkdownRenderer()
      expect(content).toContain(
        '<code className="bg-muted px-1.5 py-0.5 rounded text-sm font-mono">'
      )
    })

    test('inline code uses children directly (not content variable)', () => {
      const content = readMarkdownRenderer()
      // The inline code path should still render {children} directly
      expect(content).toContain('rounded text-sm font-mono">{children}</code>')
    })
  })

  describe('CodeBlock component compatibility', () => {
    test('CodeBlock accepts optional language prop', () => {
      const content = readCodeBlock()
      expect(content).toContain('language?: string')
    })

    test('CodeBlock has data-testid for testing', () => {
      const content = readCodeBlock()
      expect(content).toContain('data-testid="code-block"')
    })

    test('CodeBlock displays language label', () => {
      const content = readCodeBlock()
      // The language is rendered as text in the header
      expect(content).toContain('{language}')
    })

    test('CodeBlock defaults to typescript if no language provided', () => {
      const content = readCodeBlock()
      expect(content).toContain("language = 'typescript'")
    })
  })

  describe('pre override unchanged', () => {
    test('pre component passes through children', () => {
      const content = readMarkdownRenderer()
      expect(content).toContain('pre: ({ children }) => <>{children}</>')
    })
  })

  describe('tree structure rendering logic', () => {
    test('multiline content triggers block rendering', () => {
      const content = readMarkdownRenderer()
      // The key fix: content with \n characters (like tree structures) triggers isBlock
      // This means bare ``` blocks with tree chars will use CodeBlock
      expect(content).toContain("content.includes('\\n')")
      // And CodeBlock preserves whitespace via <pre> tag
      const codeBlock = readCodeBlock()
      expect(codeBlock).toContain('<pre')
      expect(codeBlock).toContain('<code>{code}</code>')
    })
  })
})
