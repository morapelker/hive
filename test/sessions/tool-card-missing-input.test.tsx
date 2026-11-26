import { describe, test, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ToolCard } from '@/components/sessions/ToolCard'
import type { ToolUseInfo } from '@/components/sessions/ToolCard'
import { upsertChildToolPart } from '@/lib/child-tool-stream'
import type { StreamingPart } from '@/lib/opencode-transcript'

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

  test('the same card gains its command, status and output as stream events arrive', () => {
    const tool = (parts: StreamingPart[]): ToolUseInfo => parts[0].toolUse as ToolUseInfo
    const event = (state: Record<string, unknown>) => ({ tool: 'Bash', callID: 'call-1', state })

    // Pending: no input yet
    let parts = upsertChildToolPart([], event({ status: 'pending' }))
    const { rerender } = render(<ToolCard toolUse={tool(parts)} compact />)
    expect(screen.getByTestId('tool-card')).toHaveAttribute('data-tool-status', 'running')
    expect(screen.queryByText('# List files')).not.toBeInTheDocument()

    // Running: the input arrives
    parts = upsertChildToolPart(
      parts,
      event({ status: 'running', input: { command: 'ls -la', description: 'List files' } })
    )
    rerender(<ToolCard toolUse={tool(parts)} compact />)
    expect(screen.getByTestId('bash-tool-view')).toHaveTextContent('# List files')
    expect(screen.getByTestId('bash-tool-view')).toHaveTextContent('ls -la')

    // Completed: status and output update on the same card
    parts = upsertChildToolPart(
      parts,
      event({ status: 'completed', output: 'README.md', time: { start: 0, end: 1500 } })
    )
    rerender(<ToolCard toolUse={tool(parts)} compact />)
    expect(screen.getAllByTestId('tool-card')).toHaveLength(1)
    expect(screen.getByTestId('tool-card')).toHaveAttribute('data-tool-status', 'success')
    expect(screen.getByTestId('bash-tool-view')).toHaveTextContent('README.md')
    expect(screen.getByTestId('bash-tool-view')).toHaveTextContent('# List files')
  })
})
