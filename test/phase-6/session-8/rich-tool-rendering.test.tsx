import { describe, test, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ToolCard } from '../../../src/renderer/src/components/sessions/ToolCard'
import { ReadToolView } from '../../../src/renderer/src/components/sessions/tools/ReadToolView'
import { EditToolView } from '../../../src/renderer/src/components/sessions/tools/EditToolView'
import { GrepToolView } from '../../../src/renderer/src/components/sessions/tools/GrepToolView'
import { BashToolView } from '../../../src/renderer/src/components/sessions/tools/BashToolView'
import { TodoToolView } from '../../../src/renderer/src/components/sessions/tools/TodoToolView'

/**
 * Session 8: Rich Tool Call Rendering
 *
 * Tests tool-specific view components for known tools (Read, Edit, Grep, Bash)
 * and a fallback TodoToolView for unknown tools, plus ToolCard routing logic.
 */

function generateLines(count: number): string {
  return Array.from({ length: count }, (_, i) => `line ${i + 1} content`).join('\n')
}

describe('Session 8: Rich Tool Rendering', () => {
  describe('ReadToolView', () => {
    test('renders content with syntax highlighting', () => {
      render(
        <ReadToolView
          name="Read"
          input={{ file_path: 'src/main/index.ts' }}
          output="import { app } from 'electron'\nimport { join } from 'path'"
          status="success"
        />
      )

      expect(screen.getByTestId('read-tool-view')).toBeTruthy()
      // Content is rendered inside SyntaxHighlighter
      expect(screen.getByTestId('read-tool-view').textContent).toContain('import')
    })

    test('shows line numbers', () => {
      render(
        <ReadToolView
          name="Read"
          input={{ file_path: 'test.ts' }}
          output={'line1\nline2\nline3'}
          status="success"
        />
      )

      expect(screen.getByText('1')).toBeTruthy()
      expect(screen.getByText('2')).toBeTruthy()
      expect(screen.getByText('3')).toBeTruthy()
    })

    test('truncates to 20 lines with "Show all" button', () => {
      const output = generateLines(50)

      render(
        <ReadToolView
          name="Read"
          input={{ file_path: 'test.ts' }}
          output={output}
          status="success"
        />
      )

      // Should show "Show all 50 lines" button
      const showAllBtn = screen.getByTestId('show-all-button')
      expect(showAllBtn).toBeTruthy()
      expect(showAllBtn.textContent).toContain('50 lines')

      // Only 20 lines should be visible initially
      // Line 21 should not be visible
      expect(screen.queryByText('line 21 content')).toBeNull()
    })

    test('expands to show all lines when "Show all" clicked', () => {
      const output = generateLines(30)

      render(
        <ReadToolView
          name="Read"
          input={{ file_path: 'test.ts' }}
          output={output}
          status="success"
        />
      )

      // Click "Show all" button
      const showAllBtn = screen.getByTestId('show-all-button')
      expect(showAllBtn.textContent).toContain('30 lines')
      fireEvent.click(showAllBtn)

      // After expanding, button should say "Show less"
      expect(showAllBtn.textContent).toContain('Show less')
    })

    test('shows line range when offset/limit provided', () => {
      render(
        <ReadToolView
          name="Read"
          input={{ file_path: 'test.ts', offset: 10, limit: 20 }}
          output="content"
          status="success"
        />
      )

      // Component renders "Lines 10–30" format
      expect(screen.getByText(/Lines 10/)).toBeTruthy()
    })

    test('renders error state', () => {
      render(
        <ReadToolView
          name="Read"
          input={{ file_path: 'missing.ts' }}
          error="File not found"
          status="error"
        />
      )

      expect(screen.getByText('File not found')).toBeTruthy()
    })

    test('uses monospace font for content', () => {
      render(
        <ReadToolView
          name="Read"
          input={{ file_path: 'test.ts' }}
          output="content"
          status="success"
        />
      )

      const view = screen.getByTestId('read-tool-view')
      // SyntaxHighlighter renders code with monospace via codeTagProps inline style
      const codeElements = view.querySelectorAll('code')
      expect(codeElements.length).toBeGreaterThan(0)
    })
  })

  describe('EditToolView', () => {
    test('renders diff with old and new strings', () => {
      render(
        <EditToolView
          name="Edit"
          input={{
            file_path: 'src/App.tsx',
            old_string: "import { OldComponent } from './old'",
            new_string: "import { NewComponent } from './new'"
          }}
          status="success"
        />
      )

      expect(screen.getByTestId('edit-tool-view')).toBeTruthy()
      // Verify diff content is rendered
      const removedLines = screen.getAllByTestId('diff-removed')
      const addedLines = screen.getAllByTestId('diff-added')
      expect(removedLines.length).toBe(1)
      expect(addedLines.length).toBe(1)
    })

    test('shows red lines for removed content', () => {
      render(
        <EditToolView
          name="Edit"
          input={{
            file_path: 'test.ts',
            old_string: 'old line',
            new_string: 'new line'
          }}
          status="success"
        />
      )

      const removedLines = screen.getAllByTestId('diff-removed')
      expect(removedLines.length).toBe(1)
      expect(removedLines[0].textContent).toContain('old line')
    })

    test('shows green lines for added content', () => {
      render(
        <EditToolView
          name="Edit"
          input={{
            file_path: 'test.ts',
            old_string: 'old line',
            new_string: 'new line'
          }}
          status="success"
        />
      )

      const addedLines = screen.getAllByTestId('diff-added')
      expect(addedLines.length).toBe(1)
      expect(addedLines[0].textContent).toContain('new line')
    })

    test('handles multi-line diffs', () => {
      render(
        <EditToolView
          name="Edit"
          input={{
            file_path: 'test.ts',
            old_string: 'line1\nline2\nline3',
            new_string: 'newLine1\nnewLine2'
          }}
          status="success"
        />
      )

      // Input object values go through JS, so \n is real newlines
      const removedLines = screen.getAllByTestId('diff-removed')
      const addedLines = screen.getAllByTestId('diff-added')
      expect(removedLines.length).toBe(3)
      expect(addedLines.length).toBe(2)
    })

    test('renders error state', () => {
      render(
        <EditToolView
          name="Edit"
          input={{ file_path: 'test.ts', old_string: 'x', new_string: 'y' }}
          error="old_string not found in file"
          status="error"
        />
      )

      expect(screen.getByText('old_string not found in file')).toBeTruthy()
    })
  })

  describe('GrepToolView', () => {
    test('shows pattern and matches', () => {
      render(
        <GrepToolView
          name="Grep"
          input={{ pattern: 'auth', path: 'src/' }}
          output={
            "src/auth/login.ts:15:const auth = getAuth()\nsrc/auth/session.ts:8:import { auth } from './'"
          }
          status="success"
        />
      )

      expect(screen.getByTestId('grep-tool-view')).toBeTruthy()
      // Pattern shown in header
      expect(screen.getByText(/2 matches/)).toBeTruthy()
      // Highlighted matches exist
      const view = screen.getByTestId('grep-tool-view')
      const highlighted = view.querySelectorAll('.text-yellow-500')
      expect(highlighted.length).toBeGreaterThan(0)
    })

    test('highlights matched text in output', () => {
      render(
        <GrepToolView
          name="Grep"
          input={{ pattern: 'auth' }}
          output="src/auth.ts:1:const auth = true"
          status="success"
        />
      )

      // The matched text should be highlighted with yellow styling
      const view = screen.getByTestId('grep-tool-view')
      const highlighted = view.querySelectorAll('.text-yellow-500')
      expect(highlighted.length).toBeGreaterThan(0)
    })

    test('shows no matches message when output is empty', () => {
      render(
        <GrepToolView name="Grep" input={{ pattern: 'nonexistent' }} output="" status="success" />
      )

      // Empty output returns null, so no view rendered
      expect(screen.queryByTestId('grep-tool-view')).toBeNull()
    })

    test('truncates long match lists', () => {
      const output = generateLines(30)

      render(
        <GrepToolView name="Grep" input={{ pattern: 'line' }} output={output} status="success" />
      )

      const showAllBtn = screen.getByTestId('show-all-button')
      expect(showAllBtn).toBeTruthy()
    })
  })

  describe('BashToolView', () => {
    test('renders terminal style with command', () => {
      render(
        <BashToolView
          name="Bash"
          input={{ command: 'pnpm test' }}
          output="PASS  test/session-1.test.ts\nTests: 5 passed, 5 total"
          status="success"
        />
      )

      expect(screen.getByTestId('bash-tool-view')).toBeTruthy()
      expect(screen.getByText('pnpm test')).toBeTruthy()
    })

    test('shows $ prefix for command', () => {
      render(
        <BashToolView
          name="Bash"
          input={{ command: 'ls -la' }}
          output="total 42"
          status="success"
        />
      )

      expect(screen.getByText('$')).toBeTruthy()
    })

    test('uses dark background', () => {
      render(
        <BashToolView
          name="Bash"
          input={{ command: 'echo hello' }}
          output="hello"
          status="success"
        />
      )

      const view = screen.getByTestId('bash-tool-view')
      const darkBg = view.querySelectorAll('.bg-zinc-900')
      expect(darkBg.length).toBeGreaterThan(0)
    })

    test('shows description comment if present', () => {
      render(
        <BashToolView
          name="Bash"
          input={{ command: 'pnpm test', description: 'Run unit tests' }}
          output="PASS"
          status="success"
        />
      )

      expect(screen.getByText('# Run unit tests')).toBeTruthy()
    })

    test('strips ANSI escape codes from output', () => {
      render(
        <BashToolView
          name="Bash"
          input={{ command: 'test' }}
          output={'\x1b[32mPASS\x1b[0m test.ts'}
          status="success"
        />
      )

      // Should show clean text without escape codes
      expect(screen.getByText('PASS test.ts')).toBeTruthy()
    })

    test('renders error output', () => {
      render(
        <BashToolView
          name="Bash"
          input={{ command: 'bad-cmd' }}
          error="command not found: bad-cmd"
          status="error"
        />
      )

      expect(screen.getByText('command not found: bad-cmd')).toBeTruthy()
    })
  })

  describe('TodoToolView', () => {
    test('renders for unknown tool with TODO badge', () => {
      render(
        <TodoToolView
          name="mcp__custom_tool"
          input={{ query: 'SELECT * FROM users', limit: 10 }}
          output="Found 42 records"
          status="success"
        />
      )

      expect(screen.getByTestId('todo-tool-view')).toBeTruthy()
      expect(screen.getByText('mcp__custom_tool')).toBeTruthy()
      expect(screen.getByText('TODO')).toBeTruthy()
    })

    test('shows raw input JSON', () => {
      render(<TodoToolView name="SomeNewTool" input={{ key: 'value' }} status="success" />)

      expect(screen.getByText(/"key"/)).toBeTruthy()
      expect(screen.getByText(/"value"/)).toBeTruthy()
    })

    test('shows raw output text', () => {
      render(
        <TodoToolView name="SomeNewTool" input={{}} output="some output data" status="success" />
      )

      expect(screen.getByText('some output data')).toBeTruthy()
    })

    test('shows "No custom renderer" note', () => {
      render(<TodoToolView name="SomeNewTool" input={{}} status="success" />)

      expect(screen.getByText(/No custom renderer/)).toBeTruthy()
    })

    test('truncates long output', () => {
      const longOutput = 'x'.repeat(600)

      render(<TodoToolView name="SomeNewTool" input={{}} output={longOutput} status="success" />)

      // Output should be truncated (500 chars + "...")
      const outputEl = screen.getByText(/^x+\.\.\.$/s)
      expect(outputEl.textContent!.length).toBeLessThan(longOutput.length)
    })
  })

  describe('ToolCard routing', () => {
    function makeToolUse(
      name: string,
      output: string = 'output',
      input: Record<string, unknown> = {}
    ) {
      return {
        id: `tool-${name}`,
        name,
        input,
        status: 'success' as const,
        output,
        startTime: 1000,
        endTime: 2000
      }
    }

    test('routes Read tool to ReadToolView', () => {
      render(<ToolCard toolUse={makeToolUse('Read', 'content', { file_path: 'test.ts' })} />)

      // Expand the compact file tool card
      const compactTool = screen.getByTestId('compact-file-tool')
      fireEvent.click(compactTool.querySelector('button')!)

      expect(screen.getByTestId('read-tool-view')).toBeTruthy()
    })

    test('routes Edit tool to EditToolView', () => {
      render(
        <ToolCard
          toolUse={makeToolUse('Edit', 'ok', {
            file_path: 'test.ts',
            old_string: 'old',
            new_string: 'new'
          })}
        />
      )

      const compactTool = screen.getByTestId('compact-file-tool')
      fireEvent.click(compactTool.querySelector('button')!)

      expect(screen.getByTestId('edit-tool-view')).toBeTruthy()
    })

    test('routes Grep tool to GrepToolView', () => {
      render(<ToolCard toolUse={makeToolUse('Grep', 'src/a.ts:1:match', { pattern: 'test' })} />)

      fireEvent.click(screen.getByTestId('tool-card-header'))

      expect(screen.getByTestId('grep-tool-view')).toBeTruthy()
    })

    test('routes Glob tool to GrepToolView', () => {
      render(<ToolCard toolUse={makeToolUse('Glob', 'src/a.ts\nsrc/b.ts', { pattern: '*.ts' })} />)

      fireEvent.click(screen.getByTestId('tool-card-header'))

      expect(screen.getByTestId('grep-tool-view')).toBeTruthy()
    })

    test('routes Bash tool to BashToolView', () => {
      render(<ToolCard toolUse={makeToolUse('Bash', 'output', { command: 'ls' })} />)

      fireEvent.click(screen.getByTestId('tool-card-header'))

      expect(screen.getByTestId('bash-tool-view')).toBeTruthy()
    })

    test('routes Write tool to WriteToolView', () => {
      render(
        <ToolCard
          toolUse={makeToolUse('Write', 'File written', {
            file_path: 'new.ts',
            content: 'const x = 1'
          })}
        />
      )

      const compactTool = screen.getByTestId('compact-file-tool')
      fireEvent.click(compactTool.querySelector('button')!)

      expect(screen.getByTestId('write-tool-view')).toBeTruthy()
    })

    test('routes unknown tool to TodoToolView', () => {
      render(<ToolCard toolUse={makeToolUse('mcp__custom', 'custom output', { key: 'val' })} />)

      fireEvent.click(screen.getByTestId('tool-card-header'))

      expect(screen.getByTestId('todo-tool-view')).toBeTruthy()
    })

    test('routes case-insensitive tool names correctly', () => {
      render(<ToolCard toolUse={makeToolUse('read_file', 'content', { file_path: 'test.ts' })} />)

      const compactTool = screen.getByTestId('compact-file-tool')
      fireEvent.click(compactTool.querySelector('button')!)

      expect(screen.getByTestId('read-tool-view')).toBeTruthy()
    })

    test('collapsed tool card shows same header as before', () => {
      render(
        <ToolCard
          toolUse={{
            id: 'test-1',
            name: 'Read',
            input: { file_path: 'src/main.ts' },
            status: 'success',
            output: 'content',
            startTime: 1000,
            endTime: 2500
          }}
        />
      )

      // Compact file tool should show tool name, file path, and success icon
      const compactTool = screen.getByTestId('compact-file-tool')
      expect(compactTool).toBeTruthy()
      expect(screen.getByText('Read')).toBeTruthy()
      const mainTsMatches = screen.getAllByText(/main\.ts/)
      expect(mainTsMatches.length).toBeGreaterThanOrEqual(1)
      // Compact mode does not show duration
      expect(screen.queryByTestId('tool-duration')).toBeNull()
      expect(screen.getByTestId('tool-success')).toBeTruthy()
    })

    test('tool card without output cannot expand', () => {
      render(
        <ToolCard
          toolUse={{
            id: 'test-1',
            name: 'Read',
            input: { file_path: 'test.ts' },
            status: 'success',
            startTime: Date.now()
          }}
        />
      )

      // Compact file tool button should be disabled (no output to expand)
      const compactTool = screen.getByTestId('compact-file-tool')
      const button = compactTool.querySelector('button') as HTMLButtonElement
      expect(button.disabled).toBe(true)
    })
  })
})
