import { describe, test, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SkillToolView } from '@/components/sessions/tools/SkillToolView'
import { ToolCard, isFileOperation } from '@/components/sessions/ToolCard'
import type { ToolUseInfo } from '@/components/sessions/ToolCard'

// Mock sonner toast
vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn()
  }
}))

// Mock react-markdown to render content directly
vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>
}))

// Mock remark-gfm
vi.mock('remark-gfm', () => ({
  default: {}
}))

// Mock CodeBlock
vi.mock('@/components/sessions/CodeBlock', () => ({
  CodeBlock: ({ code }: { code: string }) => <pre data-testid="code-block">{code}</pre>
}))

describe('Session 4: Skill Card UI', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('SkillToolView', () => {
    test('extracts content from skill_content tags', () => {
      const output = '<skill_content name="test"># Hello\n\nWorld</skill_content>'
      render(
        <SkillToolView name="mcp_skill" input={{ name: 'test' }} output={output} status="success" />
      )
      const markdown = screen.getByTestId('markdown')
      expect(markdown).toBeInTheDocument()
      expect(markdown.textContent).toContain('# Hello')
      expect(markdown.textContent).toContain('World')
    })

    test('renders full output when no skill_content tags found', () => {
      const output = '# Some raw markdown content'
      render(
        <SkillToolView name="mcp_skill" input={{ name: 'test' }} output={output} status="success" />
      )
      const markdown = screen.getByTestId('markdown')
      expect(markdown.textContent).toContain('# Some raw markdown content')
    })

    test('shows loading state when output is empty', () => {
      render(<SkillToolView name="mcp_skill" input={{ name: 'test' }} output="" status="running" />)
      expect(screen.getByText('Loading skill...')).toBeInTheDocument()
    })

    test('shows loading state when output is undefined', () => {
      render(<SkillToolView name="mcp_skill" input={{ name: 'test' }} status="pending" />)
      expect(screen.getByText('Loading skill...')).toBeInTheDocument()
    })

    test('has data-testid attribute', () => {
      render(
        <SkillToolView
          name="mcp_skill"
          input={{ name: 'test' }}
          output="content"
          status="success"
        />
      )
      expect(screen.getByTestId('skill-tool-view')).toBeInTheDocument()
    })

    test('extracts content with various attribute formats', () => {
      const output =
        '<skill_content name="brainstorming">## Step 1\n\n- Do this\n- Do that</skill_content>'
      render(
        <SkillToolView
          name="mcp_skill"
          input={{ name: 'brainstorming' }}
          output={output}
          status="success"
        />
      )
      const markdown = screen.getByTestId('markdown')
      expect(markdown.textContent).toContain('## Step 1')
      expect(markdown.textContent).toContain('- Do this')
    })

    test('has scrollable container with max height', () => {
      const output = '<skill_content name="test">Long content</skill_content>'
      render(
        <SkillToolView name="mcp_skill" input={{ name: 'test' }} output={output} status="success" />
      )
      const container = screen.getByTestId('skill-tool-view').querySelector('.max-h-\\[400px\\]')
      expect(container).toBeInTheDocument()
      expect(container?.className).toContain('overflow-y-auto')
    })
  })

  describe('ToolCard routing', () => {
    test('skill tools are not treated as file operations', () => {
      expect(isFileOperation('Skill')).toBe(false)
      expect(isFileOperation('mcp_skill')).toBe(false)
    })

    test('skill tools render through CompactFileToolCard layout', () => {
      const toolUse: ToolUseInfo = {
        id: 'tool-1',
        name: 'mcp_skill',
        input: { skill: 'test-driven-development' },
        status: 'success',
        output: '<skill_content name="tdd">TDD content</skill_content>',
        startTime: Date.now(),
        endTime: Date.now() + 1000
      }

      render(<ToolCard toolUse={toolUse} />)
      const compact = screen.getByTestId('compact-file-tool')
      expect(compact).toBeInTheDocument()
      expect(compact).toHaveAttribute('data-tool-name', 'mcp_skill')
    })

    test('Skill tool collapsed header shows skill name from skill param', () => {
      const toolUse: ToolUseInfo = {
        id: 'tool-1',
        name: 'Skill',
        input: { skill: 'superpowers:executing-plans' },
        status: 'success',
        output: 'some output',
        startTime: Date.now(),
        endTime: Date.now() + 500
      }

      render(<ToolCard toolUse={toolUse} />)
      expect(screen.getByText('Skill')).toBeInTheDocument()
      expect(screen.getByText('superpowers:executing-plans')).toBeInTheDocument()
    })

    test('Skill tool collapsed header shows "unknown" when no name', () => {
      const toolUse: ToolUseInfo = {
        id: 'tool-1',
        name: 'mcp_skill',
        input: {},
        status: 'success',
        output: 'some output',
        startTime: Date.now()
      }

      render(<ToolCard toolUse={toolUse} />)
      expect(screen.getByText('Skill')).toBeInTheDocument()
      expect(screen.getByText('unknown')).toBeInTheDocument()
    })

    test('skill tool expands to show SkillToolView content', async () => {
      const user = userEvent.setup()
      const toolUse: ToolUseInfo = {
        id: 'tool-1',
        name: 'mcp_skill',
        input: { skill: 'brainstorming' },
        status: 'success',
        output: '<skill_content name="brainstorming">## Brainstorming Guide</skill_content>',
        startTime: Date.now(),
        endTime: Date.now() + 500
      }

      render(<ToolCard toolUse={toolUse} />)

      // Click to expand
      const button = screen.getByRole('button')
      await user.click(button)

      // Verify expanded content
      const output = screen.getByTestId('tool-output')
      expect(output).toBeInTheDocument()
      expect(screen.getByTestId('skill-tool-view')).toBeInTheDocument()
    })

    test('file operations still route correctly alongside skill tools', () => {
      const readTool: ToolUseInfo = {
        id: 'tool-2',
        name: 'Read',
        input: { filePath: '/some/file.ts' },
        status: 'success',
        output: 'file content',
        startTime: Date.now()
      }

      render(<ToolCard toolUse={readTool} />)
      const compact = screen.getByTestId('compact-file-tool')
      expect(compact).toBeInTheDocument()
      expect(compact).toHaveAttribute('data-tool-name', 'Read')
    })
  })
})
