import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockAgentPublish } = vi.hoisted(() => ({
  mockAgentPublish: vi.fn()
}))

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

vi.mock('../agent-event-bus', () => ({
  agentEventBus: { publish: mockAgentPublish }
}))

vi.mock('../codex-app-server-manager', () => ({
  CodexAppServerManager: class {
    on = vi.fn()
  }
}))

vi.mock('../notification-service', () => ({
  notificationService: { shouldNotifyWhenWindowUnfocused: vi.fn(() => false) }
}))

vi.mock('../codex-session-title', () => ({
  generateCodexSessionTitle: vi.fn()
}))

vi.mock('../git-service', () => ({
  autoRenameWorktreeBranch: vi.fn()
}))

vi.mock('../worktree-events', () => ({
  emitWorktreeBranchRenamed: vi.fn()
}))

import { CodexImplementer } from '../codex-implementer'
import type { OpenCodeStreamEvent } from '@shared/types/opencode'

function sendToRenderer(impl: CodexImplementer, channel: string, data: unknown): void {
  ;(
    impl as unknown as {
      sendToRenderer: (channel: string, data: unknown) => void
    }
  ).sendToRenderer(channel, data)
}

describe('CodexImplementer.sendToRenderer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('publishes stream events through the backend event bus', () => {
    const impl = new CodexImplementer()
    const event = {
      type: 'session.status',
      sessionId: 'hive-session-1',
      statusPayload: { type: 'idle' }
    } as OpenCodeStreamEvent

    sendToRenderer(impl, 'opencode:stream', event)

    expect(mockAgentPublish).toHaveBeenCalledWith(event)
  })

  it('does not send unknown channels through renderer IPC', () => {
    const impl = new CodexImplementer()

    sendToRenderer(impl, 'test:channel', { ok: true })

    expect(mockAgentPublish).not.toHaveBeenCalled()
  })
})
