import { describe, test, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ToolCard } from '@/components/sessions/ToolCard'
import type { ToolUseInfo } from '@/components/sessions/ToolCard'

// A subagent's tool can stream in while still pending, before its input is
// known. Rendering it used to throw "Cannot read properties of undefined
// (reading 'description')" from BashToolView and blank the whole MainPane.
describe('ToolCard with a tool that has no input yet', () => {
  test.each(['Bash', 'Read', 'Edit', 'Grep', 'Write', 'Task', 'WebFetch'])(
    'renders %s without crashing',
    (name) => {
      const toolUse = {
        id: `call-${name}`,
        name,
        input: undefined,
        status: 'running',
        startTime: 0
      } as unknown as ToolUseInfo

      // File tools render a compact card, the rest a full one: only the crash matters here
      const { container } = render(<ToolCard toolUse={toolUse} compact />)

      expect(container.firstChild).not.toBeNull()
    }
  )

  test('shows the Bash command once the input arrives', () => {
    const toolUse: ToolUseInfo = {
      id: 'call-bash',
      name: 'Bash',
      input: { command: 'ls -la', description: 'List files' },
      status: 'running',
      startTime: 0
    }

    render(<ToolCard toolUse={toolUse} compact />)

    expect(screen.getByTestId('bash-tool-view')).toHaveTextContent('# List files')
  })
})
