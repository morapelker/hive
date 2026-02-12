import { render, screen } from '@testing-library/react'
import { TodoWriteToolView } from '@/components/sessions/tools/TodoWriteToolView'
import { describe, test, expect } from 'vitest'

function renderTodos(
  todos: Array<{ id: string; content: string; status: string; priority: string }>
) {
  return render(<TodoWriteToolView input={{ todos }} output="" error="" />)
}

describe('Session 1: Todo Chevron Priority Icons', () => {
  test('high priority renders ChevronsUp icon in red', () => {
    const { container } = renderTodos([
      { id: '1', content: 'Critical fix', status: 'pending', priority: 'high' }
    ])

    // ChevronsUp renders as an SVG — lucide uses data-testid or we check the class
    const svgs = container.querySelectorAll('svg.text-red-500')
    expect(svgs.length).toBeGreaterThanOrEqual(1)

    // Verify no text "high" rendered as priority label
    const todoView = screen.getByTestId('todowrite-tool-view')
    expect(todoView.textContent).not.toMatch(/\bhigh\b/)
  })

  test('medium priority renders ChevronUp icon in amber', () => {
    const { container } = renderTodos([
      { id: '1', content: 'Some task', status: 'pending', priority: 'medium' }
    ])

    const svgs = container.querySelectorAll('svg.text-amber-500')
    expect(svgs.length).toBeGreaterThanOrEqual(1)

    const todoView = screen.getByTestId('todowrite-tool-view')
    expect(todoView.textContent).not.toMatch(/\bmedium\b/)
  })

  test('low priority renders ChevronDown icon in blue', () => {
    const { container } = renderTodos([
      { id: '1', content: 'Nice to have', status: 'pending', priority: 'low' }
    ])

    // Blue SVG for low priority (note: blue-500 is also used by StatusIcon for in_progress,
    // but this todo is 'pending' so the only blue SVG should be the priority icon)
    const svgs = container.querySelectorAll('svg.text-blue-500')
    expect(svgs.length).toBeGreaterThanOrEqual(1)

    const todoView = screen.getByTestId('todowrite-tool-view')
    expect(todoView.textContent).not.toMatch(/\blow\b/)
  })

  test('all three priorities render correctly in a mixed list', () => {
    const { container } = renderTodos([
      { id: '1', content: 'High task', status: 'pending', priority: 'high' },
      { id: '2', content: 'Med task', status: 'in_progress', priority: 'medium' },
      { id: '3', content: 'Low task', status: 'completed', priority: 'low' }
    ])

    // Each priority icon should be present
    const redIcons = container.querySelectorAll('svg.text-red-500')
    const amberIcons = container.querySelectorAll('svg.text-amber-500')
    const blueIcons = container.querySelectorAll('svg.text-blue-500')

    expect(redIcons.length).toBeGreaterThanOrEqual(1)
    expect(amberIcons.length).toBeGreaterThanOrEqual(1)
    expect(blueIcons.length).toBeGreaterThanOrEqual(1)

    // No text priority labels
    const todoView = screen.getByTestId('todowrite-tool-view')
    expect(todoView.textContent).not.toMatch(/\bhigh\b/)
    expect(todoView.textContent).not.toMatch(/\bmedium\b/)
    expect(todoView.textContent).not.toMatch(/\blow\b/)
  })

  test('no background pill/badge styling remains', () => {
    const { container } = renderTodos([
      { id: '1', content: 'Task', status: 'pending', priority: 'high' }
    ])

    // Ensure no elements with the old pill classes
    const pills = container.querySelectorAll('.bg-red-500\\/15, .bg-amber-500\\/15, .bg-muted')
    // Filter to only elements that are priority badges (span with px-1.5)
    const badgePills = container.querySelectorAll('span.rounded.px-1\\.5')
    expect(badgePills.length).toBe(0)
    expect(pills.length).toBe(0)
  })
})
