import { describe, test, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PlanReadyImplementFab } from '../../../src/renderer/src/components/sessions/PlanReadyImplementFab'

describe('Session 12: Plan-ready implement FAB', () => {
  describe('PlanReadyImplementFab component', () => {
    test('renders Implement label and aria label', () => {
      const onClick = vi.fn()
      render(<PlanReadyImplementFab onClick={onClick} visible={true} />)

      const button = screen.getByTestId('plan-ready-implement-fab')
      expect(button).toBeTruthy()
      expect(button.textContent).toBe('Implement')
      expect(button.getAttribute('aria-label')).toBe('Implement plan')
    })

    test('is visible when visible=true', () => {
      const onClick = vi.fn()
      render(<PlanReadyImplementFab onClick={onClick} visible={true} />)

      const button = screen.getByTestId('plan-ready-implement-fab')
      expect(button.className).toContain('opacity-100')
      expect(button.className).not.toContain('pointer-events-none')
    })

    test('is hidden when visible=false', () => {
      const onClick = vi.fn()
      render(<PlanReadyImplementFab onClick={onClick} visible={false} />)

      const button = screen.getByTestId('plan-ready-implement-fab')
      expect(button.className).toContain('opacity-0')
      expect(button.className).toContain('pointer-events-none')
    })

    test('calls onClick when pressed', () => {
      const onClick = vi.fn()
      render(<PlanReadyImplementFab onClick={onClick} visible={true} />)

      fireEvent.click(screen.getByTestId('plan-ready-implement-fab'))
      expect(onClick).toHaveBeenCalledTimes(1)
    })
  })

  describe('SessionView integration (source verification)', () => {
    test('SessionView imports and renders PlanReadyImplementFab', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const source = fs.readFileSync(
        path.resolve(__dirname, '../../../src/renderer/src/components/sessions/SessionView.tsx'),
        'utf-8'
      )

      expect(source).toContain("import { PlanReadyImplementFab } from './PlanReadyImplementFab'")
      expect(source).toContain('<PlanReadyImplementFab')
      expect(source).toContain('onClick={handlePlanReadyImplement}')
      expect(source).toContain('visible={showPlanReadyImplementFab}')
    })

    test('visibility is based only on lastSendMode=plan and idle', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const source = fs.readFileSync(
        path.resolve(__dirname, '../../../src/renderer/src/components/sessions/SessionView.tsx'),
        'utf-8'
      )

      expect(source).toContain(
        "lastSendMode.get(sessionId) === 'plan' && !isSending && !isStreaming"
      )
    })

    test('FAB action switches to build mode and sends plain Implement text', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const source = fs.readFileSync(
        path.resolve(__dirname, '../../../src/renderer/src/components/sessions/SessionView.tsx'),
        'utf-8'
      )

      expect(source).toContain("setSessionMode(sessionId, 'build')")
      expect(source).toContain("handleSend('Implement')")
    })

    test('scroll FAB offsets upward when implement FAB is visible', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const source = fs.readFileSync(
        path.resolve(__dirname, '../../../src/renderer/src/components/sessions/SessionView.tsx'),
        'utf-8'
      )

      expect(source).toContain("bottomClass={showPlanReadyImplementFab ? 'bottom-16' : 'bottom-4'}")
    })
  })
})
