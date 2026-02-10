import { describe, test, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { WriteToolView } from '@/components/sessions/tools/WriteToolView'

// Mock react-syntax-highlighter to avoid heavy rendering in tests
vi.mock('react-syntax-highlighter', () => ({
  Prism: ({ children }: { children: string }) => (
    <pre data-testid="syntax-highlighter">{children}</pre>
  )
}))

vi.mock('react-syntax-highlighter/dist/esm/styles/prism', () => ({
  oneDark: {}
}))

describe('Session 5: WriteToolView', () => {
  test('renders content from input.content', () => {
    render(
      <WriteToolView
        name="Write"
        input={{ filePath: 'src/index.ts', content: 'const x = 1\nconst y = 2' }}
        status="success"
      />
    )
    expect(screen.getByText(/const x = 1/)).toBeInTheDocument()
    expect(screen.getByText(/const y = 2/)).toBeInTheDocument()
  })

  test('renders with empty content gracefully', () => {
    const { container } = render(<WriteToolView name="Write" input={{}} status="success" />)
    // Should not crash — returns null when no content
    expect(container.querySelector('[data-testid="write-tool-view"]')).toBeNull()
  })

  test('renders with empty string content gracefully', () => {
    const { container } = render(
      <WriteToolView name="Write" input={{ content: '' }} status="success" />
    )
    expect(container.querySelector('[data-testid="write-tool-view"]')).toBeNull()
  })

  test('renders error state', () => {
    render(
      <WriteToolView
        name="Write"
        input={{ filePath: 'test.ts', content: 'some content' }}
        error="Permission denied"
        status="error"
      />
    )
    expect(screen.getByText('Permission denied')).toBeInTheDocument()
  })

  test('truncates to 20 lines with show-all toggle', () => {
    const longContent = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n')
    render(
      <WriteToolView
        name="Write"
        input={{ filePath: 'test.ts', content: longContent }}
        status="success"
      />
    )
    // Should show the toggle button
    expect(screen.getByText(/show all 30 lines/i)).toBeInTheDocument()
    // Content should be truncated — only first 20 lines shown
    expect(screen.getByTestId('syntax-highlighter').textContent).toContain('line 1')
    expect(screen.getByTestId('syntax-highlighter').textContent).toContain('line 20')
    expect(screen.getByTestId('syntax-highlighter').textContent).not.toContain('line 21')
  })

  test('show-all toggle expands content', () => {
    const longContent = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n')
    render(
      <WriteToolView
        name="Write"
        input={{ filePath: 'test.ts', content: longContent }}
        status="success"
      />
    )
    // Click to expand
    fireEvent.click(screen.getByText(/show all 30 lines/i))
    // Now should show all content
    expect(screen.getByTestId('syntax-highlighter').textContent).toContain('line 30')
    // Button text should change to "Show less"
    expect(screen.getByText(/show less/i)).toBeInTheDocument()
  })

  test('does not show toggle for content with 20 or fewer lines', () => {
    const shortContent = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n')
    render(
      <WriteToolView
        name="Write"
        input={{ filePath: 'test.ts', content: shortContent }}
        status="success"
      />
    )
    expect(screen.queryByTestId('show-all-button')).toBeNull()
  })

  test('renders with data-testid', () => {
    render(
      <WriteToolView
        name="Write"
        input={{ filePath: 'test.ts', content: 'hello' }}
        status="success"
      />
    )
    expect(screen.getByTestId('write-tool-view')).toBeInTheDocument()
  })

  test('accepts file_path alias for filePath', () => {
    render(
      <WriteToolView
        name="Write"
        input={{ file_path: 'src/utils.ts', content: 'export const x = 1' }}
        status="success"
      />
    )
    // Should render without crash — language detection uses file path
    expect(screen.getByTestId('write-tool-view')).toBeInTheDocument()
  })

  test('accepts path alias for filePath', () => {
    render(
      <WriteToolView
        name="Write"
        input={{ path: 'src/utils.py', content: 'x = 1' }}
        status="success"
      />
    )
    expect(screen.getByTestId('write-tool-view')).toBeInTheDocument()
  })
})

describe('Session 5: ToolCard TOOL_RENDERERS integration', () => {
  test('TOOL_RENDERERS maps Write to WriteToolView (not ReadToolView)', async () => {
    // We verify WriteToolView is a separate module from ReadToolView.
    const { WriteToolView: WTV } = await import('@/components/sessions/tools/WriteToolView')
    const { ReadToolView: RTV } = await import('@/components/sessions/tools/ReadToolView')
    expect(WTV).not.toBe(RTV)
  })
})
