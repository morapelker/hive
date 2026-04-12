import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ToolCard, type ToolUseInfo } from '../../../src/renderer/src/components/sessions/ToolCard'

function makeToolUse(): ToolUseInfo {
  return {
    id: 'update-plan:thread-1:turn-1',
    name: 'update_plan',
    input: {
      todos: [
        {
          id: 'todo-1',
          content: 'Inspect adapter',
          status: 'completed',
          priority: 'medium'
        },
        {
          id: 'todo-2',
          content: 'Map plan updates',
          status: 'in_progress',
          priority: 'medium'
        }
      ]
    },
    status: 'success',
    startTime: 1000,
    endTime: 2000
  }
}

describe('update_plan tool rendering', () => {
  it('reuses the TodoWrite checklist renderer for update_plan', () => {
    render(<ToolCard toolUse={makeToolUse()} />)

    expect(screen.getByTestId('todowrite-tool-view')).toBeTruthy()
    expect(screen.getByText('Tasks')).toBeTruthy()
    expect(screen.getByText('1/2 completed')).toBeTruthy()
    expect(screen.getByText('Inspect adapter')).toBeTruthy()
    expect(screen.getByText('Map plan updates')).toBeTruthy()
  })
})
