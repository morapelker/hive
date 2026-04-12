import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

import { ToolCard, type ToolUseInfo } from '../../../src/renderer/src/components/sessions/ToolCard'

describe('Task tool nesting', () => {
  it('renders correlated subtasks inside the Task tool card', () => {
    const toolUse: ToolUseInfo = {
      id: 'task-call-1',
      name: 'Task',
      input: {
        prompt: 'Investigate the renderer',
        receiverThreadIds: ['child-1']
      },
      status: 'running',
      startTime: 1000,
      subtasks: [
        {
          id: 'child-1',
          sessionID: 'child-1',
          prompt: '',
          description: 'Investigating the renderer',
          agent: 'task',
          parts: [{ type: 'text', text: 'Child analysis' }],
          status: 'completed'
        }
      ]
    }

    render(<ToolCard toolUse={toolUse} />)

    fireEvent.click(screen.getByTestId('tool-card-header'))

    expect(screen.getByTestId('task-tool-view')).toBeTruthy()
    expect(screen.getByTestId('subtask-card')).toBeTruthy()
    expect(screen.getByText(/Investigating the renderer/)).toBeTruthy()
  })
})
