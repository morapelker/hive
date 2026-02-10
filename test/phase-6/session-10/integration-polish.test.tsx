import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { useSessionStore } from '../../../src/renderer/src/stores/useSessionStore'
import { useContextStore } from '../../../src/renderer/src/stores/useContextStore'
import { QueuedIndicator } from '../../../src/renderer/src/components/sessions/QueuedIndicator'
import { CompactionPill } from '../../../src/renderer/src/components/sessions/CompactionPill'
import { ReasoningBlock } from '../../../src/renderer/src/components/sessions/ReasoningBlock'
import { SubtaskCard } from '../../../src/renderer/src/components/sessions/SubtaskCard'
import { AttachmentPreview } from '../../../src/renderer/src/components/sessions/AttachmentPreview'
import { AttachmentButton } from '../../../src/renderer/src/components/sessions/AttachmentButton'
import { SlashCommandPopover } from '../../../src/renderer/src/components/sessions/SlashCommandPopover'
import { ContextIndicator } from '../../../src/renderer/src/components/sessions/ContextIndicator'
import { AssistantCanvas } from '../../../src/renderer/src/components/sessions/AssistantCanvas'
import type { StreamingPart } from '../../../src/renderer/src/components/sessions/SessionView'

/**
 * Session 10: Integration & Polish
 *
 * End-to-end verification of all Phase 6 features working together.
 * Tests cross-feature interactions, edge cases, and overall consistency.
 */

describe('Session 10: Integration & Polish', () => {
  afterEach(() => {
    cleanup()
  })

  // ── Tab persistence & session store ──────────────────────────

  describe('Tab persistence end-to-end', () => {
    beforeEach(() => {
      // Reset store to initial state
      useSessionStore.setState({
        sessionsByWorktree: new Map(),
        tabOrderByWorktree: new Map(),
        modeBySession: new Map(),
        activeSessionId: null,
        activeWorktreeId: null,
        activeSessionByWorktree: {}
      })
    })

    test('activeSessionByWorktree persists per worktree', () => {
      const store = useSessionStore.getState()

      // Simulate having sessions loaded for worktree-A
      const sessionsA = [
        {
          id: 'session-1',
          worktree_id: 'wt-a',
          project_id: 'proj-1',
          name: 'Session 1',
          status: 'active' as const,
          opencode_session_id: null,
          mode: 'build' as const,
          created_at: '',
          updated_at: '',
          completed_at: null
        },
        {
          id: 'session-2',
          worktree_id: 'wt-a',
          project_id: 'proj-1',
          name: 'Session 2',
          status: 'active' as const,
          opencode_session_id: null,
          mode: 'build' as const,
          created_at: '',
          updated_at: '',
          completed_at: null
        }
      ]

      useSessionStore.setState({
        sessionsByWorktree: new Map([['wt-a', sessionsA]]),
        tabOrderByWorktree: new Map([['wt-a', ['session-1', 'session-2']]]),
        activeWorktreeId: 'wt-a'
      })

      // Set active session for worktree A
      store.setActiveSession('session-2')

      // Verify persisted mapping
      const state = useSessionStore.getState()
      expect(state.activeSessionByWorktree['wt-a']).toBe('session-2')
    })

    test('switching worktrees restores last active session', () => {
      const sessionsA = [
        {
          id: 'session-1',
          worktree_id: 'wt-a',
          project_id: 'proj-1',
          name: 'S1',
          status: 'active' as const,
          opencode_session_id: null,
          mode: 'build' as const,
          created_at: '',
          updated_at: '',
          completed_at: null
        }
      ]
      const sessionsB = [
        {
          id: 'session-3',
          worktree_id: 'wt-b',
          project_id: 'proj-1',
          name: 'S3',
          status: 'active' as const,
          opencode_session_id: null,
          mode: 'build' as const,
          created_at: '',
          updated_at: '',
          completed_at: null
        }
      ]

      useSessionStore.setState({
        sessionsByWorktree: new Map([
          ['wt-a', sessionsA],
          ['wt-b', sessionsB]
        ]),
        tabOrderByWorktree: new Map([
          ['wt-a', ['session-1']],
          ['wt-b', ['session-3']]
        ]),
        activeWorktreeId: 'wt-a',
        activeSessionId: 'session-1',
        activeSessionByWorktree: { 'wt-a': 'session-1', 'wt-b': 'session-3' }
      })

      // Switch to worktree B
      useSessionStore.getState().setActiveWorktree('wt-b')
      expect(useSessionStore.getState().activeSessionId).toBe('session-3')

      // Switch back to worktree A
      useSessionStore.getState().setActiveWorktree('wt-a')
      expect(useSessionStore.getState().activeSessionId).toBe('session-1')
    })

    test('stale session ID falls back to first tab', () => {
      const sessions = [
        {
          id: 'session-5',
          worktree_id: 'wt-x',
          project_id: 'proj-1',
          name: 'S5',
          status: 'active' as const,
          opencode_session_id: null,
          mode: 'build' as const,
          created_at: '',
          updated_at: '',
          completed_at: null
        }
      ]

      useSessionStore.setState({
        sessionsByWorktree: new Map([['wt-x', sessions]]),
        tabOrderByWorktree: new Map([['wt-x', ['session-5']]]),
        activeWorktreeId: null,
        activeSessionId: null,
        // Persisted session that no longer exists
        activeSessionByWorktree: { 'wt-x': 'deleted-session-id' }
      })

      // Switch to worktree with stale persisted session
      useSessionStore.getState().setActiveWorktree('wt-x')

      // Should fall back to first available session
      expect(useSessionStore.getState().activeSessionId).toBe('session-5')
    })

    test('session modes persist independently per session', () => {
      useSessionStore.setState({
        modeBySession: new Map([
          ['session-1', 'build'],
          ['session-2', 'plan']
        ])
      })

      expect(useSessionStore.getState().getSessionMode('session-1')).toBe('build')
      expect(useSessionStore.getState().getSessionMode('session-2')).toBe('plan')
    })
  })

  // ── Context indicator & token tracking ──────────────────────

  describe('Context indicator end-to-end', () => {
    beforeEach(() => {
      useContextStore.setState({
        tokensBySession: {},
        costBySession: {},
        modelLimits: {}
      })
    })

    test('snapshot token replacement across multiple sets', () => {
      const store = useContextStore.getState()

      // First snapshot
      store.setSessionTokens('sess-1', {
        input: 1000,
        output: 500,
        reasoning: 0,
        cacheRead: 100,
        cacheWrite: 50
      })

      // Second snapshot replaces the first
      store.setSessionTokens('sess-1', {
        input: 2000,
        output: 800,
        reasoning: 200,
        cacheRead: 300,
        cacheWrite: 100
      })

      const state = useContextStore.getState()
      const tokens = state.tokensBySession['sess-1']
      expect(tokens.input).toBe(2000)
      expect(tokens.output).toBe(800)
      expect(tokens.reasoning).toBe(200)
      expect(tokens.cacheRead).toBe(300)
      expect(tokens.cacheWrite).toBe(100)
    })

    test('context usage percentage calculated correctly', () => {
      const store = useContextStore.getState()
      store.setModelLimit('claude-3', 200000)
      store.setSessionTokens('sess-1', {
        input: 50000,
        output: 30000,
        reasoning: 5000,
        cacheRead: 20000,
        cacheWrite: 1000
      })

      const usage = useContextStore.getState().getContextUsage('sess-1', 'claude-3')
      // used = input + output + reasoning + cacheRead + cacheWrite = 50000 + 30000 + 5000 + 20000 + 1000 = 106000
      expect(usage.used).toBe(106000)
      expect(usage.limit).toBe(200000)
      expect(usage.percent).toBe(53)
    })

    test('reset clears session tokens', () => {
      const store = useContextStore.getState()
      store.setSessionTokens('sess-1', {
        input: 1000,
        output: 500,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0
      })

      store.resetSessionTokens('sess-1')

      const state = useContextStore.getState()
      expect(state.tokensBySession['sess-1']).toBeUndefined()
    })

    test('independent session token tracking', () => {
      const store = useContextStore.getState()
      store.setSessionTokens('sess-a', {
        input: 100,
        output: 50,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0
      })
      store.setSessionTokens('sess-b', {
        input: 200,
        output: 100,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0
      })

      const stateA = useContextStore.getState().tokensBySession['sess-a']
      const stateB = useContextStore.getState().tokensBySession['sess-b']

      expect(stateA.input).toBe(100)
      expect(stateB.input).toBe(200)
    })

    test('ContextIndicator renders progress bar with correct color', () => {
      // Set up store with high usage
      useContextStore.setState({
        tokensBySession: {
          'sess-high': { input: 180000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
        },
        modelLimits: { 'model-1': 200000 }
      })

      render(<ContextIndicator sessionId="sess-high" modelId="model-1" />)

      const bar = screen.getByTestId('context-bar')
      expect(bar).toBeTruthy()
      // 90% = red
      expect(bar.className).toContain('bg-red-500')
    })

    test('ContextIndicator hidden when no data', () => {
      useContextStore.setState({
        tokensBySession: {},
        modelLimits: {}
      })

      render(<ContextIndicator sessionId="no-data" modelId="no-model" />)

      expect(screen.queryByTestId('context-indicator')).toBeNull()
    })

    test('ContextIndicator shows green for low usage', () => {
      useContextStore.setState({
        tokensBySession: {
          'sess-low': { input: 10000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
        },
        modelLimits: { 'model-1': 200000 }
      })

      render(<ContextIndicator sessionId="sess-low" modelId="model-1" />)

      const bar = screen.getByTestId('context-bar')
      expect(bar.className).toContain('bg-green-500')
    })
  })

  // ── Queued messages ─────────────────────────────────────────

  describe('Queued messages end-to-end', () => {
    test('QueuedIndicator shows correct count', () => {
      render(<QueuedIndicator count={2} />)
      expect(screen.getByText('2 messages queued')).toBeTruthy()
    })

    test('QueuedIndicator singular form for 1 message', () => {
      render(<QueuedIndicator count={1} />)
      expect(screen.getByText('1 message queued')).toBeTruthy()
    })

    test('QueuedIndicator hidden when count is 0', () => {
      const { container } = render(<QueuedIndicator count={0} />)
      expect(container.innerHTML).toBe('')
    })

    test('QueuedIndicator updates reactively', () => {
      const { rerender } = render(<QueuedIndicator count={0} />)
      expect(screen.queryByText(/queued/)).toBeNull()

      rerender(<QueuedIndicator count={3} />)
      expect(screen.getByText('3 messages queued')).toBeTruthy()

      rerender(<QueuedIndicator count={0} />)
      expect(screen.queryByText(/queued/)).toBeNull()
    })
  })

  // ── Attachments ─────────────────────────────────────────────

  describe('Image attachments end-to-end', () => {
    test('AttachmentPreview renders image thumbnails', () => {
      const attachments = [
        {
          id: '1',
          name: 'screenshot.png',
          mime: 'image/png',
          dataUrl: 'data:image/png;base64,abc'
        },
        { id: '2', name: 'photo.jpg', mime: 'image/jpeg', dataUrl: 'data:image/jpeg;base64,xyz' }
      ]

      render(<AttachmentPreview attachments={attachments} onRemove={() => {}} />)

      const items = screen.getAllByTestId('attachment-item')
      expect(items.length).toBe(2)

      // Images should have img tags
      const images = screen.getAllByRole('img')
      expect(images.length).toBe(2)
    })

    test('AttachmentPreview renders PDF with file icon', () => {
      const attachments = [
        {
          id: '1',
          name: 'document.pdf',
          mime: 'application/pdf',
          dataUrl: 'data:application/pdf;base64,abc'
        }
      ]

      render(<AttachmentPreview attachments={attachments} onRemove={() => {}} />)

      const items = screen.getAllByTestId('attachment-item')
      expect(items.length).toBe(1)
      // No img tag for PDF
      expect(screen.queryByRole('img')).toBeNull()
      // Should show filename
      expect(screen.getByText('document.pdf')).toBeTruthy()
    })

    test('AttachmentPreview remove button calls onRemove', () => {
      const onRemove = vi.fn()
      const attachments = [
        { id: 'att-1', name: 'test.png', mime: 'image/png', dataUrl: 'data:image/png;base64,abc' }
      ]

      render(<AttachmentPreview attachments={attachments} onRemove={onRemove} />)

      fireEvent.click(screen.getByTestId('attachment-remove'))
      expect(onRemove).toHaveBeenCalledWith('att-1')
    })

    test('AttachmentPreview hidden when empty', () => {
      const { container } = render(<AttachmentPreview attachments={[]} onRemove={() => {}} />)
      expect(container.innerHTML).toBe('')
    })

    test('AttachmentButton renders with paperclip icon', () => {
      render(<AttachmentButton onAttach={() => {}} />)
      expect(screen.getByTestId('attachment-button')).toBeTruthy()
    })

    test('AttachmentButton respects disabled prop', () => {
      render(<AttachmentButton onAttach={() => {}} disabled={true} />)
      const btn = screen.getByTestId('attachment-button') as HTMLButtonElement
      expect(btn.disabled).toBe(true)
    })

    test('Multiple attachments displayed in row', () => {
      const attachments = [
        { id: '1', name: 'a.png', mime: 'image/png', dataUrl: 'data:image/png;base64,a' },
        { id: '2', name: 'b.png', mime: 'image/png', dataUrl: 'data:image/png;base64,b' },
        { id: '3', name: 'c.png', mime: 'image/png', dataUrl: 'data:image/png;base64,c' }
      ]

      render(<AttachmentPreview attachments={attachments} onRemove={() => {}} />)

      const preview = screen.getByTestId('attachment-preview')
      expect(preview.className).toContain('flex')
      expect(screen.getAllByTestId('attachment-item').length).toBe(3)
    })
  })

  // ── Slash commands ──────────────────────────────────────────

  describe('Slash commands end-to-end', () => {
    const commands = [
      { name: 'compact', description: 'Compact context', template: '/compact' },
      { name: 'commit', description: 'Create a commit', template: '/commit' },
      { name: 'using-superpowers', description: 'Superpowers', template: '/using-superpowers' }
    ]

    test('Full flow: type, filter, navigate, select', () => {
      const onSelect = vi.fn()
      const onClose = vi.fn()

      // Render with "/" filter (all commands visible)
      const { rerender } = render(
        <SlashCommandPopover
          commands={commands}
          filter="/"
          onSelect={onSelect}
          onClose={onClose}
          visible={true}
        />
      )

      // All 3 commands shown
      expect(screen.getByTestId('slash-item-compact')).toBeTruthy()
      expect(screen.getByTestId('slash-item-commit')).toBeTruthy()

      // Filter to "/com"
      rerender(
        <SlashCommandPopover
          commands={commands}
          filter="/com"
          onSelect={onSelect}
          onClose={onClose}
          visible={true}
        />
      )

      // Only compact and commit match
      expect(screen.getByTestId('slash-item-compact')).toBeTruthy()
      expect(screen.getByTestId('slash-item-commit')).toBeTruthy()
      expect(screen.queryByTestId('slash-item-using-superpowers')).toBeNull()

      // Navigate down and select
      fireEvent.keyDown(window, { key: 'ArrowDown' })
      fireEvent.keyDown(window, { key: 'Enter' })

      expect(onSelect).toHaveBeenCalledWith({ name: 'commit', template: '/commit' })
    })

    test('Escape closes without selection', () => {
      const onSelect = vi.fn()
      const onClose = vi.fn()

      render(
        <SlashCommandPopover
          commands={commands}
          filter="/"
          onSelect={onSelect}
          onClose={onClose}
          visible={true}
        />
      )

      fireEvent.keyDown(window, { key: 'Escape' })
      expect(onClose).toHaveBeenCalled()
      expect(onSelect).not.toHaveBeenCalled()
    })
  })

  // ── Rich tool rendering via AssistantCanvas ─────────────────

  describe('Rich tool rendering end-to-end', () => {
    test('AssistantCanvas renders text parts', () => {
      const parts: StreamingPart[] = [{ type: 'text', text: 'Hello world' }]

      render(<AssistantCanvas content="" timestamp="" parts={parts} />)
      expect(screen.getByTestId('message-assistant')).toBeTruthy()
    })

    test('AssistantCanvas renders tool use parts', () => {
      const parts: StreamingPart[] = [
        { type: 'text', text: 'Let me read the file.' },
        {
          type: 'tool_use',
          toolUse: {
            id: 'tool-1',
            name: 'Read',
            input: { file_path: 'src/main.ts' },
            status: 'success',
            output: 'import { app } from "electron"',
            startTime: 1000,
            endTime: 2000
          }
        },
        { type: 'text', text: 'The file contains an import.' }
      ]

      render(<AssistantCanvas content="" timestamp="" parts={parts} />)

      const assistant = screen.getByTestId('message-assistant')
      expect(assistant).toBeTruthy()

      // Tool card should be rendered
      const toolCards = assistant.querySelectorAll('[data-testid="tool-card-header"]')
      expect(toolCards.length).toBe(1)
    })

    test('AssistantCanvas renders subtask parts', () => {
      const parts: StreamingPart[] = [
        {
          type: 'subtask',
          subtask: {
            id: 'sub-1',
            sessionID: 'child-session',
            prompt: 'Search for auth patterns',
            description: 'Searching auth patterns',
            agent: 'Explore',
            parts: [],
            status: 'completed'
          }
        }
      ]

      render(<AssistantCanvas content="" timestamp="" parts={parts} />)

      expect(screen.getByTestId('subtask-card')).toBeTruthy()
      expect(screen.getByText('Explore')).toBeTruthy()
    })

    test('AssistantCanvas renders reasoning parts', () => {
      const parts: StreamingPart[] = [
        { type: 'reasoning', reasoning: 'Let me think about the architecture...' }
      ]

      render(<AssistantCanvas content="" timestamp="" parts={parts} />)

      expect(screen.getByTestId('reasoning-block')).toBeTruthy()
    })

    test('AssistantCanvas renders compaction parts', () => {
      const parts: StreamingPart[] = [{ type: 'compaction', compactionAuto: true }]

      render(<AssistantCanvas content="" timestamp="" parts={parts} />)

      expect(screen.getByTestId('compaction-pill')).toBeTruthy()
      expect(screen.getByText('Auto-compacted')).toBeTruthy()
    })

    test('AssistantCanvas handles step boundaries gracefully', () => {
      const parts: StreamingPart[] = [
        { type: 'step_start', stepStart: { snapshot: undefined } },
        { type: 'text', text: 'Hello' },
        {
          type: 'step_finish',
          stepFinish: {
            reason: 'done',
            cost: 0.01,
            tokens: { input: 100, output: 50, reasoning: 0 }
          }
        }
      ]

      render(<AssistantCanvas content="" timestamp="" parts={parts} />)
      // Should not crash, text should be visible
      expect(screen.getByTestId('message-assistant')).toBeTruthy()
    })

    test('AssistantCanvas renders mixed parts in order', () => {
      const parts: StreamingPart[] = [
        { type: 'text', text: 'Starting analysis.' },
        { type: 'reasoning', reasoning: 'Considering the architecture...' },
        {
          type: 'tool_use',
          toolUse: {
            id: 'tool-r1',
            name: 'Read',
            input: { file_path: 'test.ts' },
            status: 'success',
            output: 'content',
            startTime: 1000,
            endTime: 1500
          }
        },
        { type: 'text', text: 'Analysis complete.' },
        { type: 'compaction', compactionAuto: false }
      ]

      render(<AssistantCanvas content="" timestamp="" parts={parts} />)

      const assistant = screen.getByTestId('message-assistant')
      expect(assistant).toBeTruthy()
      expect(screen.getByTestId('reasoning-block')).toBeTruthy()
      expect(screen.getByTestId('compaction-pill')).toBeTruthy()
      expect(screen.getByText('Context compacted')).toBeTruthy()
    })

    test('Tool group collapses 3+ consecutive tools', () => {
      const makeTool = (id: string, name: string): StreamingPart => ({
        type: 'tool_use',
        toolUse: {
          id,
          name,
          input: {},
          status: 'success',
          output: 'ok',
          startTime: 1000,
          endTime: 2000
        }
      })

      const parts: StreamingPart[] = [
        makeTool('t1', 'Read'),
        makeTool('t2', 'Grep'),
        makeTool('t3', 'Read')
      ]

      render(<AssistantCanvas content="" timestamp="" parts={parts} />)

      // 3 tools should be grouped
      expect(screen.getByTestId('tool-call-group')).toBeTruthy()
      expect(screen.getByText('3 tool calls')).toBeTruthy()
    })
  })

  // ── Subagent rendering ──────────────────────────────────────

  describe('Subagent rendering end-to-end', () => {
    test('SubtaskCard shows agent name and description', () => {
      render(
        <SubtaskCard
          subtask={{
            id: 'sub-1',
            sessionID: 'child-1',
            prompt: 'Search for auth patterns in codebase',
            description: 'Searching auth patterns',
            agent: 'Explore',
            parts: [],
            status: 'running'
          }}
        />
      )

      expect(screen.getByText('Explore')).toBeTruthy()
      expect(screen.getByText(/Searching auth/)).toBeTruthy()
      expect(screen.getByTestId('subtask-spinner')).toBeTruthy()
    })

    test('SubtaskCard shows completed status', () => {
      render(
        <SubtaskCard
          subtask={{
            id: 'sub-1',
            sessionID: 'child-1',
            prompt: 'Done',
            description: 'Finished analysis',
            agent: 'Bash',
            parts: [],
            status: 'completed'
          }}
        />
      )

      expect(screen.getByTestId('subtask-check')).toBeTruthy()
    })

    test('SubtaskCard shows error status', () => {
      render(
        <SubtaskCard
          subtask={{
            id: 'sub-1',
            sessionID: 'child-1',
            prompt: 'Failed',
            description: 'Error occurred',
            agent: 'Bash',
            parts: [],
            status: 'error'
          }}
        />
      )

      expect(screen.getByTestId('subtask-error')).toBeTruthy()
    })

    test('SubtaskCard expand/collapse reveals nested content', () => {
      render(
        <SubtaskCard
          subtask={{
            id: 'sub-1',
            sessionID: 'child-1',
            prompt: 'Search',
            description: 'Searching',
            agent: 'Explore',
            parts: [{ type: 'text', text: 'Found 3 matching files.' }],
            status: 'completed'
          }}
        />
      )

      // Initially collapsed — content not visible
      expect(screen.queryByTestId('subtask-content')).toBeNull()

      // Click to expand
      fireEvent.click(screen.getByTestId('subtask-card-header'))
      expect(screen.getByTestId('subtask-content')).toBeTruthy()

      // Click again to collapse
      fireEvent.click(screen.getByTestId('subtask-card-header'))
      expect(screen.queryByTestId('subtask-content')).toBeNull()
    })

    test('SubtaskCard shows "Processing..." when running with no parts', () => {
      render(
        <SubtaskCard
          subtask={{
            id: 'sub-1',
            sessionID: 'child-1',
            prompt: 'Working',
            description: 'Working...',
            agent: 'general',
            parts: [],
            status: 'running'
          }}
        />
      )

      // Expand to see empty content
      fireEvent.click(screen.getByTestId('subtask-card-header'))
      expect(screen.getByText('Processing...')).toBeTruthy()
    })
  })

  // ── Reasoning blocks ────────────────────────────────────────

  describe('Reasoning blocks end-to-end', () => {
    test('ReasoningBlock collapsed by default shows preview', () => {
      render(<ReasoningBlock text="Let me think about the best approach to solve this problem." />)

      expect(screen.getByTestId('reasoning-block')).toBeTruthy()
      // Collapsed shows preview text
      expect(screen.getByText(/Let me think/)).toBeTruthy()
      // Full content NOT visible
      expect(screen.queryByTestId('reasoning-block-content')).toBeNull()
    })

    test('ReasoningBlock expands to show full text', () => {
      render(<ReasoningBlock text="Full reasoning content here with details about the approach." />)

      // Click to expand
      fireEvent.click(screen.getByTestId('reasoning-block-header'))
      expect(screen.getByTestId('reasoning-block-content')).toBeTruthy()
      expect(screen.getByText(/Full reasoning content/)).toBeTruthy()
    })

    test('ReasoningBlock truncates long preview', () => {
      const longText = 'x'.repeat(200)
      render(<ReasoningBlock text={longText} />)

      // Preview should be truncated (first 100 chars + "...")
      const header = screen.getByTestId('reasoning-block-header')
      const previewText = header.textContent || ''
      expect(previewText.length).toBeLessThan(longText.length)
    })
  })

  // ── Compaction pills ────────────────────────────────────────

  describe('Compaction pills end-to-end', () => {
    test('Auto compaction shows "Auto-compacted"', () => {
      render(<CompactionPill auto={true} />)
      expect(screen.getByText('Auto-compacted')).toBeTruthy()
    })

    test('Manual compaction shows "Context compacted"', () => {
      render(<CompactionPill auto={false} />)
      expect(screen.getByText('Context compacted')).toBeTruthy()
    })
  })

  // ── Cross-feature interactions ──────────────────────────────

  describe('Cross-feature interactions', () => {
    test('Context tracking works with multiple model limits', () => {
      const store = useContextStore.getState()

      store.setModelLimit('claude-3-opus', 200000)
      store.setModelLimit('claude-3-sonnet', 180000)
      store.setSessionTokens('sess-1', {
        input: 90000,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0
      })

      const opusUsage = useContextStore.getState().getContextUsage('sess-1', 'claude-3-opus')
      const sonnetUsage = useContextStore.getState().getContextUsage('sess-1', 'claude-3-sonnet')

      expect(opusUsage.percent).toBe(45)
      expect(sonnetUsage.percent).toBe(50)
    })

    test('Session mode unaffected by context tracking', () => {
      // Reset context store to avoid state from previous tests
      useContextStore.setState({ tokensBySession: {}, costBySession: {}, modelLimits: {} })

      useSessionStore.setState({
        modeBySession: new Map([['sess-1', 'plan']])
      })
      useContextStore.getState().setSessionTokens('sess-1', {
        input: 1000,
        output: 500,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0
      })

      // Session mode should remain unchanged
      expect(useSessionStore.getState().getSessionMode('sess-1')).toBe('plan')
      // Token tracking should still work
      expect(useContextStore.getState().tokensBySession['sess-1'].input).toBe(1000)
    })

    test('AssistantCanvas renders all part types together without errors', () => {
      const parts: StreamingPart[] = [
        { type: 'reasoning', reasoning: 'Thinking about the approach...' },
        { type: 'text', text: 'I will analyze the codebase.' },
        {
          type: 'subtask',
          subtask: {
            id: 'sub-1',
            sessionID: 'child-1',
            prompt: 'Search for patterns',
            description: 'Searching patterns',
            agent: 'Explore',
            parts: [{ type: 'text', text: 'Found 5 files.' }],
            status: 'completed'
          }
        },
        {
          type: 'tool_use',
          toolUse: {
            id: 'tool-1',
            name: 'Read',
            input: { file_path: 'src/main.ts' },
            status: 'success',
            output: 'content',
            startTime: 1000,
            endTime: 1500
          }
        },
        { type: 'compaction', compactionAuto: true },
        { type: 'text', text: 'Analysis is complete.' }
      ]

      // Should not crash rendering all part types together
      render(<AssistantCanvas content="" timestamp="" parts={parts} />)

      expect(screen.getByTestId('message-assistant')).toBeTruthy()
      expect(screen.getByTestId('reasoning-block')).toBeTruthy()
      expect(screen.getByTestId('subtask-card')).toBeTruthy()
      expect(screen.getByTestId('compaction-pill')).toBeTruthy()
    })

    test('Unknown part types are gracefully ignored', () => {
      const parts: StreamingPart[] = [
        { type: 'text', text: 'Hello' },
        // @ts-expect-error — Intentionally testing unknown type
        { type: 'some_future_type', data: {} },
        { type: 'text', text: 'World' }
      ]

      // Should not crash
      render(<AssistantCanvas content="" timestamp="" parts={parts} />)
      expect(screen.getByTestId('message-assistant')).toBeTruthy()
    })
  })

  // ── Edge cases ──────────────────────────────────────────────

  describe('Edge cases', () => {
    test('Empty parts array renders fallback content', () => {
      render(<AssistantCanvas content="Fallback content" timestamp="" parts={[]} />)
      expect(screen.getByTestId('message-assistant').textContent).toContain('Fallback content')
    })

    test('Null parts renders content string', () => {
      render(<AssistantCanvas content="Plain text response" timestamp="" />)
      expect(screen.getByTestId('message-assistant').textContent).toContain('Plain text response')
    })

    test('Context usage with zero limit returns 0 percent', () => {
      useContextStore.setState({
        tokensBySession: {
          s1: { input: 1000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
        },
        modelLimits: {}
      })

      const usage = useContextStore.getState().getContextUsage('s1', 'unknown-model')
      expect(usage.percent).toBe(0)
      expect(usage.limit).toBe(0)
    })

    test('Context usage caps at 100 percent', () => {
      useContextStore.setState({
        tokensBySession: {
          s1: { input: 300000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
        },
        modelLimits: { m1: 200000 }
      })

      const usage = useContextStore.getState().getContextUsage('s1', 'm1')
      expect(usage.percent).toBe(100)
    })

    test('Subtask with nested tool calls renders correctly', () => {
      render(
        <SubtaskCard
          subtask={{
            id: 'sub-1',
            sessionID: 'child-1',
            prompt: 'Search',
            description: 'Searching',
            agent: 'Explore',
            parts: [
              { type: 'text', text: 'Found files.' },
              {
                type: 'tool_use',
                toolUse: {
                  id: 'nested-tool-1',
                  name: 'Grep',
                  input: { pattern: 'auth' },
                  status: 'success',
                  output: 'src/auth.ts:1:auth',
                  startTime: 1000,
                  endTime: 1200
                }
              }
            ],
            status: 'completed'
          }}
        />
      )

      // Expand to see nested content
      fireEvent.click(screen.getByTestId('subtask-card-header'))

      // Should show nested tool card
      const content = screen.getByTestId('subtask-content')
      expect(content.querySelectorAll('[data-testid="tool-card-header"]').length).toBe(1)
    })

    test('ReasoningBlock with empty string', () => {
      render(<ReasoningBlock text="" />)
      // Should render with "Thinking..." fallback
      expect(screen.getByTestId('reasoning-block')).toBeTruthy()
      expect(screen.getByText('Thinking...')).toBeTruthy()
    })

    test('SlashCommandPopover with empty commands array shows loading', () => {
      render(
        <SlashCommandPopover
          commands={[]}
          filter="/"
          onSelect={() => {}}
          onClose={() => {}}
          visible={true}
        />
      )

      expect(screen.getByText('Loading commands...')).toBeTruthy()
    })
  })
})
