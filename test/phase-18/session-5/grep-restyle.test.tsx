import { describe, test, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { isSearchOperation, isFileOperation, ToolCard } from '@/components/sessions/ToolCard'
import type { ToolUseInfo } from '@/components/sessions/ToolCard'

describe('Session 5: Grep UI Restyle', () => {
  describe('isSearchOperation', () => {
    test('matches grep variants', () => {
      expect(isSearchOperation('Grep')).toBe(true)
      expect(isSearchOperation('grep')).toBe(true)
      expect(isSearchOperation('mcp_grep')).toBe(true)
    })

    test('matches glob variants', () => {
      expect(isSearchOperation('Glob')).toBe(true)
      expect(isSearchOperation('glob')).toBe(true)
      expect(isSearchOperation('mcp_glob')).toBe(true)
    })

    test('does not match file operations', () => {
      expect(isSearchOperation('Read')).toBe(false)
      expect(isSearchOperation('Write')).toBe(false)
      expect(isSearchOperation('Edit')).toBe(false)
      expect(isSearchOperation('Bash')).toBe(false)
    })

    test('isFileOperation does not match search tools', () => {
      expect(isFileOperation('Grep')).toBe(false)
      expect(isFileOperation('Glob')).toBe(false)
      expect(isFileOperation('mcp_grep')).toBe(false)
      expect(isFileOperation('mcp_glob')).toBe(false)
    })
  })

  describe('Grep tools use CompactFileToolCard layout', () => {
    test('Grep renders with compact layout', () => {
      const toolUse: ToolUseInfo = {
        id: 'tool-1',
        name: 'Grep',
        input: { pattern: 'console\\.log' },
        status: 'success',
        output: 'src/main.ts:10\nsrc/utils.ts:25\n',
        startTime: Date.now() - 1000,
        endTime: Date.now()
      }
      render(<ToolCard toolUse={toolUse} cwd="/project" />)
      expect(screen.getByTestId('compact-file-tool')).toBeInTheDocument()
    })

    test('mcp_grep renders with compact layout', () => {
      const toolUse: ToolUseInfo = {
        id: 'tool-2',
        name: 'mcp_grep',
        input: { pattern: 'TODO' },
        status: 'success',
        output: 'file.ts:5\n',
        startTime: Date.now() - 500,
        endTime: Date.now()
      }
      render(<ToolCard toolUse={toolUse} cwd="/project" />)
      expect(screen.getByTestId('compact-file-tool')).toBeInTheDocument()
    })

    test('Glob renders with compact layout', () => {
      const toolUse: ToolUseInfo = {
        id: 'tool-3',
        name: 'Glob',
        input: { pattern: '**/*.ts' },
        status: 'success',
        output: 'src/main.ts\nsrc/utils.ts\n',
        startTime: Date.now() - 200,
        endTime: Date.now()
      }
      render(<ToolCard toolUse={toolUse} cwd="/project" />)
      expect(screen.getByTestId('compact-file-tool')).toBeInTheDocument()
    })

    test('mcp_glob renders with compact layout', () => {
      const toolUse: ToolUseInfo = {
        id: 'tool-4',
        name: 'mcp_glob',
        input: { pattern: 'src/**/*.tsx' },
        status: 'success',
        output: 'src/App.tsx\n',
        startTime: Date.now() - 200,
        endTime: Date.now()
      }
      render(<ToolCard toolUse={toolUse} cwd="/project" />)
      expect(screen.getByTestId('compact-file-tool')).toBeInTheDocument()
    })
  })

  describe('Collapsed content shows correct labels', () => {
    test('grep shows "Search" label', () => {
      const toolUse: ToolUseInfo = {
        id: 'tool-5',
        name: 'Grep',
        input: { pattern: 'handleClick' },
        status: 'success',
        output: 'src/App.tsx:42\nsrc/Button.tsx:15\n',
        startTime: Date.now() - 1000,
        endTime: Date.now()
      }
      render(<ToolCard toolUse={toolUse} cwd="/project" />)
      expect(screen.getByText('Search')).toBeInTheDocument()
      // Should NOT have "Grep" label
      expect(screen.queryByText('Grep')).not.toBeInTheDocument()
    })

    test('grep shows pattern in quotes', () => {
      const toolUse: ToolUseInfo = {
        id: 'tool-6',
        name: 'mcp_grep',
        input: { pattern: 'useEffect' },
        status: 'success',
        output: 'src/hooks.ts:10\n',
        startTime: Date.now() - 500,
        endTime: Date.now()
      }
      render(<ToolCard toolUse={toolUse} cwd="/project" />)
      expect(screen.getByText(/"useEffect"/)).toBeInTheDocument()
    })

    test('grep shows search path when provided', () => {
      const toolUse: ToolUseInfo = {
        id: 'tool-7',
        name: 'Grep',
        input: { pattern: 'TODO', path: 'src/components' },
        status: 'success',
        output: 'src/components/App.tsx:5\n',
        startTime: Date.now() - 300,
        endTime: Date.now()
      }
      render(<ToolCard toolUse={toolUse} cwd="/project" />)
      expect(screen.getByText('in src/components')).toBeInTheDocument()
    })

    test('grep shows match count', () => {
      const toolUse: ToolUseInfo = {
        id: 'tool-8',
        name: 'Grep',
        input: { pattern: 'import' },
        status: 'success',
        output: 'a.ts:1\nb.ts:2\nc.ts:3\n',
        startTime: Date.now() - 500,
        endTime: Date.now()
      }
      render(<ToolCard toolUse={toolUse} cwd="/project" />)
      expect(screen.getByText('(3)')).toBeInTheDocument()
    })

    test('glob shows "Find files" label', () => {
      const toolUse: ToolUseInfo = {
        id: 'tool-9',
        name: 'Glob',
        input: { pattern: '**/*.test.ts' },
        status: 'success',
        output: 'test/a.test.ts\ntest/b.test.ts\n',
        startTime: Date.now() - 200,
        endTime: Date.now()
      }
      render(<ToolCard toolUse={toolUse} cwd="/project" />)
      expect(screen.getByText('Find files')).toBeInTheDocument()
      // Should NOT have "Glob" label
      expect(screen.queryByText('Glob')).not.toBeInTheDocument()
    })

    test('glob shows file count', () => {
      const toolUse: ToolUseInfo = {
        id: 'tool-10',
        name: 'mcp_glob',
        input: { pattern: 'src/**/*.tsx' },
        status: 'success',
        output: 'src/App.tsx\nsrc/Button.tsx\nsrc/Card.tsx\nsrc/Dialog.tsx\n',
        startTime: Date.now() - 200,
        endTime: Date.now()
      }
      render(<ToolCard toolUse={toolUse} cwd="/project" />)
      expect(screen.getByText('(4)')).toBeInTheDocument()
    })
  })

  describe('Expand/collapse toggle', () => {
    test('+/- toggle works for grep tools', async () => {
      const user = userEvent.setup()
      const toolUse: ToolUseInfo = {
        id: 'tool-11',
        name: 'Grep',
        input: { pattern: 'test' },
        status: 'success',
        output: 'file.ts:1:test content\n',
        startTime: Date.now() - 500,
        endTime: Date.now()
      }
      render(<ToolCard toolUse={toolUse} cwd="/project" />)

      // Initially collapsed — tool-output not present
      expect(screen.queryByTestId('tool-output')).not.toBeInTheDocument()

      // Click to expand
      const button = screen.getByRole('button')
      await user.click(button)
      expect(screen.getByTestId('tool-output')).toBeInTheDocument()

      // Click to collapse
      await user.click(button)
      expect(screen.queryByTestId('tool-output')).not.toBeInTheDocument()
    })
  })

  describe('Loader spinner shows while running', () => {
    test('grep shows spinner when running', () => {
      const toolUse: ToolUseInfo = {
        id: 'tool-12',
        name: 'Grep',
        input: { pattern: 'loading' },
        status: 'running',
        startTime: Date.now()
      }
      render(<ToolCard toolUse={toolUse} cwd="/project" />)
      expect(screen.getByTestId('tool-spinner')).toBeInTheDocument()
    })

    test('glob shows spinner when pending', () => {
      const toolUse: ToolUseInfo = {
        id: 'tool-13',
        name: 'mcp_glob',
        input: { pattern: '**/*.md' },
        status: 'pending',
        startTime: Date.now()
      }
      render(<ToolCard toolUse={toolUse} cwd="/project" />)
      expect(screen.getByTestId('tool-spinner')).toBeInTheDocument()
    })
  })
})
