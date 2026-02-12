import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ReasoningBlock } from '../../../src/renderer/src/components/sessions/ReasoningBlock'

describe('Session 4: Streaming Thinking Blocks', () => {
  test('auto-expands when isStreaming is true', () => {
    const { rerender } = render(<ReasoningBlock text="thinking..." isStreaming={false} />)
    expect(screen.queryByTestId('reasoning-block-content')).not.toBeInTheDocument()

    rerender(<ReasoningBlock text="thinking..." isStreaming={true} />)
    expect(screen.getByTestId('reasoning-block-content')).toBeInTheDocument()
  })

  test('auto-collapses when isStreaming becomes false', () => {
    const { rerender } = render(<ReasoningBlock text="thinking..." isStreaming={true} />)
    expect(screen.getByTestId('reasoning-block-content')).toBeInTheDocument()

    rerender(<ReasoningBlock text="done thinking" isStreaming={false} />)
    expect(screen.queryByTestId('reasoning-block-content')).not.toBeInTheDocument()
  })

  test('user manual collapse is respected after streaming ends', async () => {
    const { rerender } = render(<ReasoningBlock text="thinking..." isStreaming={true} />)
    // Auto-expanded
    expect(screen.getByTestId('reasoning-block-content')).toBeInTheDocument()

    // User manually collapses
    await userEvent.click(screen.getByTestId('reasoning-block-header'))
    expect(screen.queryByTestId('reasoning-block-content')).not.toBeInTheDocument()

    // Streaming ends — should stay collapsed (user override)
    rerender(<ReasoningBlock text="done thinking" isStreaming={false} />)
    expect(screen.queryByTestId('reasoning-block-content')).not.toBeInTheDocument()
  })

  test('defaults to collapsed when isStreaming is not provided', () => {
    render(<ReasoningBlock text="some reasoning" />)
    expect(screen.queryByTestId('reasoning-block-content')).not.toBeInTheDocument()
  })

  test('manual toggle still works on non-streaming blocks', async () => {
    render(<ReasoningBlock text="some reasoning" />)
    await userEvent.click(screen.getByTestId('reasoning-block-header'))
    expect(screen.getByTestId('reasoning-block-content')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('reasoning-block-header'))
    expect(screen.queryByTestId('reasoning-block-content')).not.toBeInTheDocument()
  })
})
