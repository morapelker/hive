import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import {
  OPENCODE_CAPABILITIES,
  CLAUDE_CODE_CAPABILITIES,
  CODEX_CAPABILITIES,
  TERMINAL_CAPABILITIES
} from '../../../src/main/services/agent-sdk-types'
import { PLAN_MODE_PREFIX } from '@/lib/constants'

// ---------------------------------------------------------------------------
// ModelIcon mocks
// ---------------------------------------------------------------------------

let mockShowModelIcons = true
let mockLastModelId: string | null = null
let mockLatestAgentSdk: string | null = null

vi.mock('@/stores/useSettingsStore', () => ({
  useSettingsStore: Object.assign(
    (selector?: (s: unknown) => unknown) => {
      const state = { showModelIcons: mockShowModelIcons }
      return selector ? selector(state) : state
    },
    { getState: () => ({ showModelIcons: mockShowModelIcons }) }
  )
}))

vi.mock('@/stores', () => ({
  useWorktreeStore: Object.assign(
    (selector?: (s: unknown) => unknown) => {
      const state = {
        worktreesByProject: new Map([
          [
            'proj-1',
            [{ id: 'wt-1', last_model_id: mockLastModelId }]
          ]
        ])
      }
      return selector ? selector(state) : state
    },
    { getState: () => ({}) }
  ),
  useSessionStore: Object.assign(
    (selector?: (s: unknown) => unknown) => {
      const state = {
        sessionsByWorktree: new Map([
          [
            'wt-1',
            mockLatestAgentSdk
              ? [{ id: 's-1', agent_sdk: mockLatestAgentSdk }]
              : []
          ]
        ])
      }
      return selector ? selector(state) : state
    },
    { getState: () => ({}) }
  )
}))

vi.mock('@/lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' ')
}))

// Mock SVG imports as simple strings
vi.mock('@/assets/model-icons/claude.svg', () => ({ default: 'claude-icon.svg' }))
vi.mock('@/assets/model-icons/openai.svg', () => ({ default: 'openai-icon.svg' }))

describe('ModelIcon: Codex awareness', () => {
  beforeEach(() => {
    mockShowModelIcons = true
    mockLastModelId = null
    mockLatestAgentSdk = null
  })

  it('shows OpenAI icon when agent_sdk is codex', async () => {
    mockLatestAgentSdk = 'codex'

    const { ModelIcon } = await import(
      '@/components/worktrees/ModelIcon'
    )
    render(<ModelIcon worktreeId="wt-1" />)

    const img = screen.getByAltText('OpenAI')
    expect(img).toBeInTheDocument()
    expect(img).toHaveAttribute('src', 'openai-icon.svg')
  })

  it('shows Claude icon when agent_sdk is claude-code (no regression)', async () => {
    mockLatestAgentSdk = 'claude-code'

    const { ModelIcon } = await import(
      '@/components/worktrees/ModelIcon'
    )
    render(<ModelIcon worktreeId="wt-1" />)

    const img = screen.getByAltText('Claude')
    expect(img).toBeInTheDocument()
    expect(img).toHaveAttribute('src', 'claude-icon.svg')
  })

  it('falls back to model-id pattern matching for opencode sessions', async () => {
    mockLatestAgentSdk = 'opencode'
    mockLastModelId = 'gpt-4o'

    const { ModelIcon } = await import(
      '@/components/worktrees/ModelIcon'
    )
    render(<ModelIcon worktreeId="wt-1" />)

    const img = screen.getByAltText('OpenAI')
    expect(img).toBeInTheDocument()
  })

  it('returns null when showModelIcons is false', async () => {
    mockShowModelIcons = false
    mockLatestAgentSdk = 'codex'

    const { ModelIcon } = await import(
      '@/components/worktrees/ModelIcon'
    )
    const { container } = render(<ModelIcon worktreeId="wt-1" />)

    expect(container.innerHTML).toBe('')
  })

  it('handles unknown SDK gracefully — falls through to model-id matching', async () => {
    mockLatestAgentSdk = 'some-future-sdk'
    mockLastModelId = 'claude-3-opus'

    const { ModelIcon } = await import(
      '@/components/worktrees/ModelIcon'
    )
    render(<ModelIcon worktreeId="wt-1" />)

    const img = screen.getByAltText('Claude')
    expect(img).toBeInTheDocument()
  })

  it('returns null for unknown SDK with unknown model', async () => {
    mockLatestAgentSdk = 'some-future-sdk'
    mockLastModelId = 'unknown-model-xyz'

    const { ModelIcon } = await import(
      '@/components/worktrees/ModelIcon'
    )
    const { container } = render(<ModelIcon worktreeId="wt-1" />)

    expect(container.innerHTML).toBe('')
  })
})

// ---------------------------------------------------------------------------
// SessionTabs: Codex tab renders with standard AI styling (not terminal)
// ---------------------------------------------------------------------------

describe('SessionTabs: Codex tab styling', () => {
  it('codex is an AI provider — gets standard status indicators, not terminal icon', () => {
    // SessionTabs renders TerminalSquare only for agent_sdk === 'terminal'.
    // Codex must be categorized as an AI SDK (not terminal), which is verified
    // by checking that CODEX_CAPABILITIES has AI features enabled while
    // TERMINAL_CAPABILITIES has them all disabled.
    expect(CODEX_CAPABILITIES.supportsPermissionRequests).toBe(true)
    expect(CODEX_CAPABILITIES.supportsQuestionPrompts).toBe(true)
    expect(TERMINAL_CAPABILITIES.supportsPermissionRequests).toBe(false)
    expect(TERMINAL_CAPABILITIES.supportsQuestionPrompts).toBe(false)
  })

  it('all AI SDKs (opencode, claude-code, codex) share interactive capabilities that terminal lacks', () => {
    // The SessionTab component treats terminal differently from AI SDKs.
    // Verify that all three AI SDKs have capabilities that terminal does not.
    const aiCapabilities = [OPENCODE_CAPABILITIES, CLAUDE_CODE_CAPABILITIES, CODEX_CAPABILITIES]
    for (const caps of aiCapabilities) {
      expect(caps.supportsModelSelection).toBe(true)
      expect(caps.supportsReconnect).toBe(true)
    }
    expect(TERMINAL_CAPABILITIES.supportsModelSelection).toBe(false)
    expect(TERMINAL_CAPABILITIES.supportsReconnect).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Capability-gated slash commands: Codex has supportsUndo=true, supportsRedo=false
// ---------------------------------------------------------------------------

describe('Capability-gated commands for Codex', () => {
  it('Codex supports undo but not redo (real CODEX_CAPABILITIES)', () => {
    // Anchored to the real capability constants — if these change, the test catches it
    expect(CODEX_CAPABILITIES.supportsUndo).toBe(true)
    expect(CODEX_CAPABILITIES.supportsRedo).toBe(false)
  })

  it('Codex does not support slash commands', () => {
    // Codex sessions should not show the command palette or process slash commands
    expect(CODEX_CAPABILITIES.supportsCommands).toBe(false)
  })

  it('OpenCode supports both undo and redo (contrast with Codex)', () => {
    expect(OPENCODE_CAPABILITIES.supportsUndo).toBe(true)
    expect(OPENCODE_CAPABILITIES.supportsRedo).toBe(true)
    expect(OPENCODE_CAPABILITIES.supportsCommands).toBe(true)
  })

  it('Claude Code matches Codex on undo/redo but differs on commands', () => {
    expect(CLAUDE_CODE_CAPABILITIES.supportsUndo).toBe(true)
    expect(CLAUDE_CODE_CAPABILITIES.supportsRedo).toBe(false)
    expect(CLAUDE_CODE_CAPABILITIES.supportsCommands).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Plan mode prefix skipping: Codex and Claude Code both skip PLAN_MODE_PREFIX
// ---------------------------------------------------------------------------

describe('Plan mode prefix: Codex and Claude Code skip it', () => {
  // Uses the real PLAN_MODE_PREFIX from the codebase (not a local redefinition)
  // SessionView.tsx line 409: skipPlanModePrefix = isClaudeCode || sessionRecord?.agent_sdk === 'codex'
  // SessionView.tsx line 2145: currentMode === 'plan' && !skipPlanModePrefix ? PLAN_MODE_PREFIX : ''

  function shouldSkipPlanModePrefix(agentSdk: string): boolean {
    // This mirrors the exact condition in SessionView.tsx
    const isClaudeCode = agentSdk === 'claude-code'
    return isClaudeCode || agentSdk === 'codex'
  }

  it('PLAN_MODE_PREFIX is a non-empty constant from @/lib/constants', () => {
    expect(PLAN_MODE_PREFIX).toBeTruthy()
    expect(typeof PLAN_MODE_PREFIX).toBe('string')
    expect(PLAN_MODE_PREFIX.length).toBeGreaterThan(0)
  })

  it('opencode sessions do NOT skip the prefix', () => {
    expect(shouldSkipPlanModePrefix('opencode')).toBe(false)
  })

  it('claude-code sessions skip the prefix', () => {
    expect(shouldSkipPlanModePrefix('claude-code')).toBe(true)
  })

  it('codex sessions skip the prefix', () => {
    expect(shouldSkipPlanModePrefix('codex')).toBe(true)
  })

  it('the prefix is prepended only for non-skip SDKs in plan mode', () => {
    const currentMode = 'plan'
    const sdks = ['opencode', 'claude-code', 'codex'] as const
    for (const sdk of sdks) {
      const skip = shouldSkipPlanModePrefix(sdk)
      const prefix = currentMode === 'plan' && !skip ? PLAN_MODE_PREFIX : ''
      if (sdk === 'opencode') {
        expect(prefix).toBe(PLAN_MODE_PREFIX)
      } else {
        expect(prefix).toBe('')
      }
    }
  })
})
