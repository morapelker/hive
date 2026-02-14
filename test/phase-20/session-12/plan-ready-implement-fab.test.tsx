import { describe, test, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PlanReadyImplementFab } from '../../../src/renderer/src/components/sessions/PlanReadyImplementFab'

describe('Session 12: Plan-ready implement FAB', () => {
  describe('PlanReadyImplementFab component', () => {
    test('renders Implement and Handoff labels with aria labels', () => {
      const onImplement = vi.fn()
      const onHandoff = vi.fn()
      render(
        <PlanReadyImplementFab onImplement={onImplement} onHandoff={onHandoff} visible={true} />
      )

      const implementButton = screen.getByTestId('plan-ready-implement-fab')
      const handoffButton = screen.getByTestId('plan-ready-handoff-fab')
      expect(implementButton).toBeTruthy()
      expect(implementButton.textContent).toBe('Implement')
      expect(implementButton.getAttribute('aria-label')).toBe('Implement plan')
      expect(handoffButton).toBeTruthy()
      expect(handoffButton.textContent).toBe('Handoff')
      expect(handoffButton.getAttribute('aria-label')).toBe('Handoff plan')
    })

    test('is visible when visible=true', () => {
      const onImplement = vi.fn()
      const onHandoff = vi.fn()
      render(
        <PlanReadyImplementFab onImplement={onImplement} onHandoff={onHandoff} visible={true} />
      )

      const implementButton = screen.getByTestId('plan-ready-implement-fab')
      expect(implementButton.className).toContain('opacity-100')
      expect(implementButton.className).not.toContain('pointer-events-none')
    })

    test('is hidden when visible=false', () => {
      const onImplement = vi.fn()
      const onHandoff = vi.fn()
      render(
        <PlanReadyImplementFab onImplement={onImplement} onHandoff={onHandoff} visible={false} />
      )

      const implementButton = screen.getByTestId('plan-ready-implement-fab')
      expect(implementButton.className).toContain('opacity-0')
      expect(implementButton.className).toContain('pointer-events-none')
    })

    test('calls onImplement when Implement is pressed', () => {
      const onImplement = vi.fn()
      const onHandoff = vi.fn()
      render(
        <PlanReadyImplementFab onImplement={onImplement} onHandoff={onHandoff} visible={true} />
      )

      fireEvent.click(screen.getByTestId('plan-ready-implement-fab'))
      expect(onImplement).toHaveBeenCalledTimes(1)
      expect(onHandoff).not.toHaveBeenCalled()
    })

    test('calls onHandoff when Handoff is pressed', () => {
      const onImplement = vi.fn()
      const onHandoff = vi.fn()
      render(
        <PlanReadyImplementFab onImplement={onImplement} onHandoff={onHandoff} visible={true} />
      )

      fireEvent.click(screen.getByTestId('plan-ready-handoff-fab'))
      expect(onHandoff).toHaveBeenCalledTimes(1)
      expect(onImplement).not.toHaveBeenCalled()
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
      expect(source).toContain('onImplement={handlePlanReadyImplement}')
      expect(source).toContain('onHandoff={handlePlanReadyHandoff}')
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

    test('Handoff action opens a new build-mode session and sends handoff prompt', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const source = fs.readFileSync(
        path.resolve(__dirname, '../../../src/renderer/src/components/sessions/SessionView.tsx'),
        'utf-8'
      )

      expect(source).toContain('Implement the following plan\\n')
      expect(source).toContain('createSession(currentWorktreeId, currentProjectId)')
      expect(source).toContain("setSessionMode(result.session.id, 'build')")
      expect(source).toContain('setPendingMessage(result.session.id, handoffPrompt)')
      expect(source).toContain('setActiveSession(result.session.id)')
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
