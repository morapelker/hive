import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLI_FOLLOW_UP_LEAD, buildQuestionModeNotice } from '@shared/document-flow/prompts'
import type { DocumentRunDetail, DocumentRunItem } from '@shared/types/document-flow'
import { makeDetail } from '@/components/document-flow/test-fixtures'
import { useDocumentFlowStore } from '@/stores/useDocumentFlowStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { applyQuestionMode, questionModeTargets, tellQuestionMode } from './question-mode'
import type { SessionSignal } from './session-signal'

const mocks = vi.hoisted(() => ({
  updateRun: vi.fn(),
  logEvent: vi.fn(),
  sendClaudeCliPrompt: vi.fn(),
  createClaudeCli: vi.fn(),
  prompt: vi.fn(),
  findSessionById: vi.fn(),
  sendFollowupToSession: vi.fn(),
  getSessionSignal: vi.fn(),
  setSessionQueuedState: vi.fn()
}))

vi.mock('@/api/document-flow-api', () => ({
  documentFlowApi: { updateRun: mocks.updateRun, logEvent: mocks.logEvent }
}))
vi.mock('@/api/terminal-api', () => ({
  terminalApi: {
    sendClaudeCliPrompt: mocks.sendClaudeCliPrompt,
    createClaudeCli: mocks.createClaudeCli
  }
}))
vi.mock('@/lib/session-followup', () => ({
  findSessionById: mocks.findSessionById,
  sendFollowupToSession: mocks.sendFollowupToSession
}))
vi.mock('./session-signal', () => ({ getSessionSignal: mocks.getSessionSignal }))

const initialFlowState = useDocumentFlowStore.getState()
const initialSessionState = useSessionStore.getState()

const WORKING: SessionSignal = { kind: 'working' }
const BLOCKED: SessionSignal = { kind: 'blocked', reason: 'question', detail: null }
const ENDED: SessionSignal = {
  kind: 'ended',
  at: 1,
  completion: undefined,
  apiError: null,
  reason: null,
  hookEvent: null,
  hasBackgroundWork: false
}

let sdks: Record<string, string> = {}
let signals: Record<string, SessionSignal> = {}

const seed = (items: Partial<DocumentRunItem>[]): DocumentRunDetail => {
  const detail = makeDetail({ status: 'running' }, items)
  useDocumentFlowStore.setState({ runsById: { [detail.run.id]: detail } })
  return detail
}

const queueOf = (sessionId: string): string[] =>
  useSessionStore.getState().pendingFollowUpMessages.get(sessionId) ?? []

const off = (sdk: string): string => buildQuestionModeNotice({ interactive: false, sdk })
const on = (sdk: string): string => buildQuestionModeNotice({ interactive: true, sdk })

beforeEach(() => {
  sdks = {}
  signals = {}
  mocks.updateRun.mockImplementation(async (runId: string, patch) => {
    const run = useDocumentFlowStore.getState().runsById[runId].run
    return { ...run, config: { ...run.config, ...patch.config } }
  })
  mocks.logEvent.mockResolvedValue(undefined)
  mocks.sendClaudeCliPrompt.mockResolvedValue({ success: true, value: { delivered: true } })
  mocks.findSessionById.mockImplementation(async (sessionId: string) =>
    sdks[sessionId] ? { session: { id: sessionId, agent_sdk: sdks[sessionId] } } : null
  )
  mocks.getSessionSignal.mockImplementation(
    (sessionId: string): SessionSignal => signals[sessionId] ?? { kind: 'unknown' }
  )
})

afterEach(() => {
  vi.resetAllMocks()
  useDocumentFlowStore.setState(initialFlowState, true)
  useSessionStore.setState(initialSessionState, true)
})

describe('questionModeTargets', () => {
  it('picks the session an agent may be working in, once each', () => {
    const { items } = makeDetail({}, [
      { key: 'A', status: 'running', session_id: 's-a' },
      { key: 'B', status: 'fixing', session_id: 's-b', fix_session_id: 's-b-fix' },
      { key: 'C', status: 'needs_input', session_id: 's-c' },
      { key: 'D', status: 'launching', session_id: null },
      { key: 'E', status: 'merged', session_id: 's-e' },
      { key: 'F', status: 'pending' },
      { key: 'G', status: 'ready', session_id: 's-g' },
      { key: 'H', status: 'running', session_id: 's-h', selected: false },
      { key: 'I', status: 'checking', session_id: 's-a' }
    ])

    expect(questionModeTargets(items).map((target) => [target.key, target.sessionId])).toEqual([
      ['A', 's-a'],
      ['B', 's-b-fix'],
      ['C', 's-c']
    ])
  })

  it('has no target for a fix that has not started its session', () => {
    const { items } = makeDetail({}, [
      { key: 'A', status: 'fixing', session_id: 's-a', fix_session_id: null }
    ])
    expect(questionModeTargets(items)).toEqual([])
  })
})

describe('applyQuestionMode', () => {
  it('saves the setting and queues the notice for working and blocked SDK sessions', async () => {
    seed([
      { key: 'A', status: 'running', session_id: 's-claude' },
      { key: 'B', status: 'running', session_id: 's-codex' },
      { key: 'C', status: 'needs_input', session_id: 's-opencode' }
    ])
    sdks = { 's-claude': 'claude-code', 's-codex': 'codex', 's-opencode': 'opencode' }
    signals = { 's-claude': WORKING, 's-codex': WORKING, 's-opencode': BLOCKED }

    const result = await applyQuestionMode('run-1', false)

    expect(mocks.updateRun).toHaveBeenCalledWith('run-1', { config: { interactive: false } })
    expect(useDocumentFlowStore.getState().runsById['run-1'].run.config.interactive).toBe(false)
    expect(queueOf('s-claude')).toEqual([off('claude-code')])
    expect(queueOf('s-codex')).toEqual([off('codex')])
    expect(queueOf('s-opencode')).toEqual([off('opencode')])
    expect(result).toEqual({ told: 2, waiting: 1, skipped: 0, failed: 0 })
    // Never a direct prompt: that would abort a claude-code turn, and codex would drop it.
    expect(mocks.sendFollowupToSession).not.toHaveBeenCalled()
    expect(mocks.sendClaudeCliPrompt).not.toHaveBeenCalled()
  })

  it('queues the ask-again notice when switching back on', async () => {
    seed([{ key: 'A', status: 'running', session_id: 's-a' }])
    sdks = { 's-a': 'codex' }
    signals = { 's-a': WORKING }

    await applyQuestionMode('run-1', true)

    expect(mocks.updateRun).toHaveBeenCalledWith('run-1', { config: { interactive: true } })
    expect(queueOf('s-a')).toEqual([on('codex')])
    expect(queueOf('s-a')[0]).toContain('use the request_user_input tool to ask me')
  })

  it('types the notice into a working CLI session and nowhere else', async () => {
    seed([
      { key: 'A', status: 'running', session_id: 's-working' },
      { key: 'B', status: 'needs_input', session_id: 's-asking' },
      { key: 'C', status: 'checking', session_id: 's-ended' }
    ])
    sdks = { 's-working': 'claude-code-cli', 's-asking': 'claude-code-cli', 's-ended': 'codex-cli' }
    signals = { 's-working': WORKING, 's-asking': BLOCKED, 's-ended': ENDED }

    const result = await applyQuestionMode('run-1', false)

    // An open dialog would take the text as its answer; an idle CLI would start a new turn.
    // Typed after a line of the user's own words: Claude Code reads a bare paste as text the
    // user may not have written.
    expect(mocks.sendClaudeCliPrompt.mock.calls).toEqual([
      ['s-working', off('claude-code-cli'), { lead: CLI_FOLLOW_UP_LEAD }]
    ])
    expect(queueOf('s-working')).toEqual([])
    expect(result).toEqual({ told: 1, waiting: 0, skipped: 2, failed: 0 })
  })

  it('pastes the notice into a working codex CLI without a typed lead', async () => {
    seed([{ key: 'A', status: 'running', session_id: 's-codex' }])
    sdks = { 's-codex': 'codex-cli' }
    signals = { 's-codex': WORKING }

    await applyQuestionMode('run-1', false)

    expect(mocks.sendClaudeCliPrompt.mock.calls).toEqual([['s-codex', off('codex-cli')]])
  })

  it('does not start a CLI that is no longer running', async () => {
    seed([{ key: 'A', status: 'running', session_id: 's-a' }])
    sdks = { 's-a': 'claude-code-cli' }
    signals = { 's-a': WORKING }
    mocks.sendClaudeCliPrompt.mockResolvedValue({ success: true, value: { delivered: false } })

    expect(await applyQuestionMode('run-1', false)).toEqual({
      told: 0,
      waiting: 0,
      skipped: 1,
      failed: 0
    })
    expect(mocks.createClaudeCli).not.toHaveBeenCalled()
  })

  it('leaves sessions at rest, unknown or missing alone', async () => {
    seed([
      { key: 'A', status: 'checking', session_id: 's-ended' },
      { key: 'B', status: 'running', session_id: 's-unknown' },
      { key: 'C', status: 'running', session_id: 's-gone' }
    ])
    sdks = { 's-ended': 'claude-code', 's-unknown': 'claude-code' }
    signals = { 's-ended': ENDED }

    const result = await applyQuestionMode('run-1', false)

    expect(queueOf('s-ended')).toEqual([])
    expect(queueOf('s-unknown')).toEqual([])
    expect(result).toEqual({ told: 0, waiting: 0, skipped: 3, failed: 0 })
  })

  it('replaces a notice that is still queued, and keeps what the user queued', async () => {
    seed([{ key: 'A', status: 'running', session_id: 's-a' }])
    sdks = { 's-a': 'claude-code' }
    signals = { 's-a': WORKING }
    useSessionStore.getState().enqueueFollowUpMessage('s-a', 'also add a test')

    await applyQuestionMode('run-1', false)
    await applyQuestionMode('run-1', true)

    expect(queueOf('s-a')).toEqual(['also add a test', on('claude-code')])
  })

  it('drops a queued notice of the old setting from a session that is now at rest', async () => {
    seed([{ key: 'A', status: 'running', session_id: 's-a' }])
    sdks = { 's-a': 'claude-code' }
    signals = { 's-a': WORKING }
    await applyQuestionMode('run-1', false)
    expect(queueOf('s-a')).toEqual([off('claude-code')])

    // Its turn ended and the drain could not send: the notice is still queued.
    signals = { 's-a': ENDED }
    const result = await applyQuestionMode('run-1', true)

    expect(queueOf('s-a')).toEqual([])
    expect(result).toEqual({ told: 0, waiting: 0, skipped: 1, failed: 0 })
  })

  it('queues for a session that was just launched, whatever its signal says yet', async () => {
    sdks = { 's-sdk': 'claude-code', 's-cli': 'claude-code-cli' }

    expect(await tellQuestionMode('s-sdk', false, { justLaunched: true })).toBe('queued')
    expect(queueOf('s-sdk')).toEqual([off('claude-code')])
    // A CLI that is still booting is not typed into.
    expect(await tellQuestionMode('s-cli', false, { justLaunched: true })).toBe('skipped')
    expect(mocks.sendClaudeCliPrompt).not.toHaveBeenCalled()
  })

  it('counts a session whose delivery throws as failed and still tells the others', async () => {
    seed([
      { key: 'A', status: 'running', session_id: 's-a' },
      { key: 'B', status: 'running', session_id: 's-b' }
    ])
    sdks = { 's-a': 'claude-code-cli', 's-b': 'claude-code' }
    signals = { 's-a': WORKING, 's-b': WORKING }
    mocks.sendClaudeCliPrompt.mockRejectedValue(new Error('rpc down'))

    const result = await applyQuestionMode('run-1', false)

    expect(result).toEqual({ told: 1, waiting: 0, skipped: 0, failed: 1 })
    expect(queueOf('s-b')).toEqual([off('claude-code')])
  })

  it('sends nothing when the setting could not be saved', async () => {
    seed([{ key: 'A', status: 'running', session_id: 's-a' }])
    sdks = { 's-a': 'claude-code' }
    signals = { 's-a': WORKING }
    mocks.updateRun.mockRejectedValue(new Error('offline'))

    await expect(applyQuestionMode('run-1', false)).rejects.toThrow('offline')

    expect(queueOf('s-a')).toEqual([])
    expect(mocks.logEvent).not.toHaveBeenCalled()
  })

  it('records the change in the activity log, and survives a failed write of it', async () => {
    seed([{ key: 'A', status: 'running', session_id: 's-a' }])
    sdks = { 's-a': 'claude-code' }
    signals = { 's-a': WORKING }
    mocks.logEvent.mockRejectedValue(new Error('offline'))

    await expect(applyQuestionMode('run-1', false)).resolves.toEqual({
      told: 1,
      waiting: 0,
      skipped: 0,
      failed: 0
    })
    expect(mocks.logEvent).toHaveBeenCalledWith({
      runId: 'run-1',
      type: 'questions_off',
      message: 'Agents told not to ask questions: 1 running session(s) told',
      data: { told: 1, waiting: 0, skipped: 0, failed: 0 }
    })
  })
})
