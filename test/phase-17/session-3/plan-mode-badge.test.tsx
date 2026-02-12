import { describe, test, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PLAN_MODE_PREFIX, stripPlanModePrefix } from '@/lib/constants'
import { UserBubble } from '@/components/sessions/UserBubble'
import { MessageRenderer } from '@/components/sessions/MessageRenderer'

// Mock sonner toast (used by CopyMessageButton)
vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn()
  }
}))

// Mock navigator.clipboard
Object.defineProperty(navigator, 'clipboard', {
  value: { writeText: vi.fn().mockResolvedValue(undefined) },
  writable: true
})

describe('Session 3: Plan Mode Badge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('PLAN_MODE_PREFIX constant', () => {
    test('is exported from constants', () => {
      expect(PLAN_MODE_PREFIX).toBeDefined()
      expect(PLAN_MODE_PREFIX).toContain('[Mode: Plan]')
    })

    test('starts with [Mode: Plan] marker', () => {
      expect(PLAN_MODE_PREFIX.startsWith('[Mode: Plan]')).toBe(true)
    })

    test('ends with double newline', () => {
      expect(PLAN_MODE_PREFIX.endsWith('\n\n')).toBe(true)
    })
  })

  describe('stripPlanModePrefix', () => {
    test('strips prefix from content that starts with it', () => {
      const content = PLAN_MODE_PREFIX + 'How do we implement this?'
      expect(stripPlanModePrefix(content)).toBe('How do we implement this?')
    })

    test('returns content unchanged when no prefix', () => {
      const content = 'Just a normal message'
      expect(stripPlanModePrefix(content)).toBe('Just a normal message')
    })

    test('returns empty string when content is only the prefix', () => {
      expect(stripPlanModePrefix(PLAN_MODE_PREFIX)).toBe('')
    })
  })

  describe('UserBubble', () => {
    test('renders PLAN badge when isPlanMode is true', () => {
      render(
        <UserBubble
          content="How do we implement this?"
          timestamp="2025-01-01T00:00:00.000Z"
          isPlanMode={true}
        />
      )
      const badge = screen.getByTestId('plan-mode-badge')
      expect(badge).toBeInTheDocument()
      expect(badge).toHaveTextContent('PLAN')
    })

    test('does not render badge when isPlanMode is false', () => {
      render(
        <UserBubble
          content="Normal message"
          timestamp="2025-01-01T00:00:00.000Z"
          isPlanMode={false}
        />
      )
      expect(screen.queryByTestId('plan-mode-badge')).not.toBeInTheDocument()
    })

    test('does not render badge when isPlanMode is undefined', () => {
      render(<UserBubble content="Normal message" timestamp="2025-01-01T00:00:00.000Z" />)
      expect(screen.queryByTestId('plan-mode-badge')).not.toBeInTheDocument()
    })

    test('renders content text regardless of isPlanMode', () => {
      render(
        <UserBubble
          content="How do we implement this?"
          timestamp="2025-01-01T00:00:00.000Z"
          isPlanMode={true}
        />
      )
      expect(screen.getByText('How do we implement this?')).toBeInTheDocument()
    })

    test('badge has correct purple styling classes', () => {
      render(<UserBubble content="Test" timestamp="2025-01-01T00:00:00.000Z" isPlanMode={true} />)
      const badge = screen.getByTestId('plan-mode-badge')
      expect(badge.className).toContain('bg-purple-500/15')
      expect(badge.className).toContain('text-purple-400')
      expect(badge.className).toContain('text-[10px]')
      expect(badge.className).toContain('font-semibold')
    })

    test('bubble has purple tint when isPlanMode is true', () => {
      render(<UserBubble content="Test" timestamp="2025-01-01T00:00:00.000Z" isPlanMode={true} />)
      const bubble = screen.getByTestId('message-user').firstElementChild!
      expect(bubble.className).toContain('bg-purple-500/10')
    })

    test('bubble has default tint when isPlanMode is false', () => {
      render(<UserBubble content="Test" timestamp="2025-01-01T00:00:00.000Z" isPlanMode={false} />)
      const bubble = screen.getByTestId('message-user').firstElementChild!
      expect(bubble.className).toContain('bg-primary/10')
    })
  })

  describe('MessageRenderer', () => {
    test('user message with prefix shows PLANNER badge and stripped content', () => {
      const content = PLAN_MODE_PREFIX + 'How do we implement this?'
      render(
        <MessageRenderer
          message={{
            id: 'msg-1',
            role: 'user',
            content,
            timestamp: '2025-01-01T00:00:00.000Z',
            parts: []
          }}
        />
      )
      expect(screen.getByTestId('plan-mode-badge')).toBeInTheDocument()
      expect(screen.getByText('How do we implement this?')).toBeInTheDocument()
      // Prefix text should NOT be visible
      expect(screen.queryByText(/\[Mode: Plan\]/)).not.toBeInTheDocument()
    })

    test('user message without prefix shows no badge', () => {
      render(
        <MessageRenderer
          message={{
            id: 'msg-2',
            role: 'user',
            content: 'Normal message',
            timestamp: '2025-01-01T00:00:00.000Z',
            parts: []
          }}
        />
      )
      expect(screen.queryByTestId('plan-mode-badge')).not.toBeInTheDocument()
      expect(screen.getByText('Normal message')).toBeInTheDocument()
    })

    test('only the prefix is stripped, user content preserved', () => {
      const userContent = 'How do we implement this feature?\nWith multiple lines'
      const content = PLAN_MODE_PREFIX + userContent
      render(
        <MessageRenderer
          message={{
            id: 'msg-3',
            role: 'user',
            content,
            timestamp: '2025-01-01T00:00:00.000Z',
            parts: []
          }}
        />
      )
      expect(screen.getByTestId('plan-mode-badge')).toBeInTheDocument()
      // Use a regex to match across the newline (getByText normalizes whitespace)
      expect(
        screen.getByText((_content, element) => {
          return element?.tagName === 'P' && element.textContent === userContent
        })
      ).toBeInTheDocument()
    })

    test('assistant messages are not affected by plan mode detection', () => {
      // Even if an assistant message somehow contained the prefix, it should
      // not be treated as plan mode (only user messages are checked)
      render(
        <MessageRenderer
          message={{
            id: 'msg-4',
            role: 'assistant',
            content: PLAN_MODE_PREFIX + 'Response text',
            timestamp: '2025-01-01T00:00:00.000Z',
            parts: []
          }}
        />
      )
      expect(screen.queryByTestId('plan-mode-badge')).not.toBeInTheDocument()
    })
  })
})
