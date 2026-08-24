import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseService } from '../db/database'
import type { Session } from '../db/types'

vi.mock('./logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

vi.mock('../db', () => ({
  getDatabase: vi.fn(() => {
    throw new Error('tests must inject deps.db')
  })
}))

const publishDesktopBackendEvent = vi.fn()
vi.mock('../desktop/backend-event-publisher', () => ({
  publishDesktopBackendEvent: (...args: unknown[]) => publishDesktopBackendEvent(...args)
}))

import {
  handleClaudeCliModelChangeHook,
  mainChainAssistantModels,
  resetAllClaudeCliModelWatchers,
  resetClaudeCliModelWatcher
} from './claude-cli-model-watcher'

const SESSION_ID = 'hive-session-1'

function assistantLine(model: string, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    type: 'assistant',
    isSidechain: false,
    message: { role: 'assistant', model, content: [{ type: 'text', text: 'hi' }] },
    ...extra
  })}\n`
}

function userLine(): string {
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } })}\n`
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: SESSION_ID,
    agent_sdk: 'claude-code-cli',
    model_provider_id: 'anthropic',
    model_id: 'fable',
    model_variant: 'high',
    custom_provider_id: null,
    ...overrides
  } as Session
}

function makeDb(session: Session | null): DatabaseService & { updateSession: ReturnType<typeof vi.fn> } {
  return {
    getSession: vi.fn(() => session),
    updateSession: vi.fn(() => session)
  } as unknown as DatabaseService & { updateSession: ReturnType<typeof vi.fn> }
}

describe('mainChainAssistantModels', () => {
  it('collects assistant models in order, skipping other line types', () => {
    const text =
      userLine() +
      assistantLine('claude-fable-5') +
      userLine() +
      assistantLine('claude-sonnet-5-20250929')
    expect(mainChainAssistantModels(text)).toEqual(['claude-fable-5', 'claude-sonnet-5-20250929'])
  })

  it('ignores sidechain, synthetic and malformed lines', () => {
    const text =
      assistantLine('claude-fable-5') +
      assistantLine('claude-haiku-4-5-20251001', { isSidechain: true }) +
      assistantLine('<synthetic>', { isApiErrorMessage: true }) +
      'not json\n' +
      `${JSON.stringify({ type: 'assistant', message: null })}\n`
    expect(mainChainAssistantModels(text)).toEqual(['claude-fable-5'])
  })
})

describe('handleClaudeCliModelChangeHook', () => {
  let dir: string
  let transcriptPath: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'model-watcher-'))
    transcriptPath = path.join(dir, 'session.jsonl')
    resetAllClaudeCliModelWatchers()
    publishDesktopBackendEvent.mockClear()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const stopHook = (): { hook_event_name: string; transcript_path: string } => ({
    hook_event_name: 'Stop',
    transcript_path: transcriptPath
  })

  it('does nothing while the session stays on one model', () => {
    const db = makeDb(makeSession())
    writeFileSync(transcriptPath, assistantLine('claude-fable-5') + assistantLine('claude-fable-5'))
    handleClaudeCliModelChangeHook(SESSION_ID, stopHook(), { db })
    expect(db.updateSession).not.toHaveBeenCalled()
    expect(publishDesktopBackendEvent).not.toHaveBeenCalled()
  })

  it('applies a mid-session degrade and publishes the change', () => {
    const db = makeDb(makeSession())
    writeFileSync(transcriptPath, assistantLine('claude-fable-5'))
    handleClaudeCliModelChangeHook(SESSION_ID, stopHook(), { db })

    appendFileSync(transcriptPath, assistantLine('claude-sonnet-5-20250929'))
    handleClaudeCliModelChangeHook(SESSION_ID, stopHook(), { db })

    expect(db.updateSession).toHaveBeenCalledWith(SESSION_ID, { model_id: 'sonnet' })
    expect(publishDesktopBackendEvent).toHaveBeenCalledWith(
      'opencode:stream',
      expect.objectContaining({
        type: 'session.model_changed',
        sessionId: SESSION_ID,
        data: expect.objectContaining({
          modelId: 'sonnet',
          previousModelId: 'fable',
          rawModel: 'claude-sonnet-5-20250929'
        })
      })
    )
  })

  it('consumes the transcript at a StopFailure boundary (API-error turn end)', () => {
    const db = makeDb(makeSession())
    writeFileSync(transcriptPath, assistantLine('claude-fable-5'))
    handleClaudeCliModelChangeHook(SESSION_ID, stopHook(), { db })

    // A usage-limit degrade lands mid-turn, then the turn dies with an API
    // error — StopFailure is the only turn boundary that fires.
    appendFileSync(
      transcriptPath,
      assistantLine('claude-sonnet-5-20250929') +
        assistantLine('<synthetic>', { isApiErrorMessage: true })
    )
    handleClaudeCliModelChangeHook(
      SESSION_ID,
      { hook_event_name: 'StopFailure', transcript_path: transcriptPath },
      { db }
    )

    expect(db.updateSession).toHaveBeenCalledWith(SESSION_ID, { model_id: 'sonnet' })
  })

  it('detects an opening-turn safety fallback (empty transcript baseline, first line differs)', () => {
    // The ticket case: a session launched on fable whose very first prompt
    // triggers a safety degrade to opus 4.8. SessionStart baselines the still
    // model-less transcript, then the first committed assistant line is already
    // opus — with no prior fable line in the file, this must still register as
    // a fable→opus switch and update the row.
    const db = makeDb(makeSession())
    writeFileSync(transcriptPath, userLine())
    handleClaudeCliModelChangeHook(
      SESSION_ID,
      { hook_event_name: 'SessionStart', transcript_path: transcriptPath },
      { db }
    )
    expect(db.updateSession).not.toHaveBeenCalled()

    appendFileSync(transcriptPath, assistantLine('claude-opus-4-8'))
    handleClaudeCliModelChangeHook(SESSION_ID, stopHook(), { db })
    // Stored as the distinct fallback id, not the selectable `opus` (Opus 5).
    expect(db.updateSession).toHaveBeenCalledWith(SESSION_ID, { model_id: 'opus-4-8' })
    expect(publishDesktopBackendEvent).toHaveBeenCalledWith(
      'opencode:stream',
      expect.objectContaining({
        type: 'session.model_changed',
        data: expect.objectContaining({ modelId: 'opus-4-8', previousModelId: 'fable' })
      })
    )
  })

  it('fires on an opening-turn fallback even without a prior SessionStart hook', () => {
    // Same degrade observed for the first time on the Stop hook, before any
    // assistant line existed at attach: the launch model (row) seeds the
    // baseline so the opus line is a transition, not a silent baseline.
    const db = makeDb(makeSession())
    writeFileSync(transcriptPath, userLine())
    handleClaudeCliModelChangeHook(SESSION_ID, stopHook(), { db })
    expect(db.updateSession).not.toHaveBeenCalled()

    appendFileSync(transcriptPath, assistantLine('claude-opus-4-8'))
    handleClaudeCliModelChangeHook(SESSION_ID, stopHook(), { db })
    expect(db.updateSession).toHaveBeenCalledWith(SESSION_ID, { model_id: 'opus-4-8' })
  })

  it('keeps a safety fallback distinct from a selectable Opus 5 line', () => {
    // A real Opus 5 snapshot collapses to the selectable `opus`; only the
    // Opus 4.x fallback keeps its own non-selectable id.
    const db = makeDb(makeSession())
    writeFileSync(transcriptPath, assistantLine('claude-fable-5'))
    handleClaudeCliModelChangeHook(SESSION_ID, stopHook(), { db })

    appendFileSync(transcriptPath, assistantLine('claude-opus-5-20260101'))
    handleClaudeCliModelChangeHook(SESSION_ID, stopHook(), { db })
    expect(db.updateSession).toHaveBeenCalledWith(SESSION_ID, { model_id: 'opus' })
  })

  it('does not clamp effort for an opus 4.x fallback and no-ops once stored', () => {
    // Opus-tier fallback keeps extended efforts (unlike sonnet/haiku), and a
    // second opus-4-8 line must not rewrite the already-stored id.
    const db = makeDb(makeSession({ model_variant: 'max' }))
    writeFileSync(transcriptPath, assistantLine('claude-fable-5'))
    handleClaudeCliModelChangeHook(SESSION_ID, stopHook(), { db })

    appendFileSync(transcriptPath, assistantLine('claude-opus-4-8'))
    handleClaudeCliModelChangeHook(SESSION_ID, stopHook(), { db })
    expect(db.updateSession).toHaveBeenCalledWith(SESSION_ID, { model_id: 'opus-4-8' })

    // Row now reflects the fallback; a further opus-4-8 line canonicalizes to
    // the same id, so there is nothing new to write.
    db.getSession = vi.fn(() => makeSession({ model_id: 'opus-4-8', model_variant: 'max' }))
    ;(db.updateSession as ReturnType<typeof vi.fn>).mockClear()
    appendFileSync(transcriptPath, assistantLine('claude-opus-4-8'))
    handleClaudeCliModelChangeHook(SESSION_ID, stopHook(), { db })
    expect(db.updateSession).not.toHaveBeenCalled()
  })

  it('carries the running model across a /clear so a pending UI choice is not reverted', () => {
    // The CLI runs fable; the user picks sonnet in Hive (row=sonnet) without
    // respawning, so the CLI keeps answering fable. A /clear then yields a
    // fresh empty transcript. The baseline must seed the running fable (carried
    // from the prior tracker), not the ahead-of-CLI row, so the first fable
    // line is no transition and the pending sonnet choice survives.
    const db = makeDb(makeSession())
    writeFileSync(transcriptPath, assistantLine('claude-fable-5'))
    handleClaudeCliModelChangeHook(SESSION_ID, stopHook(), { db })

    db.getSession = vi.fn(() => makeSession({ model_id: 'sonnet' }))
    const clearedPath = path.join(dir, 'session-cleared.jsonl')
    writeFileSync(clearedPath, userLine())
    handleClaudeCliModelChangeHook(
      SESSION_ID,
      { hook_event_name: 'SessionStart', transcript_path: clearedPath },
      { db }
    )
    appendFileSync(clearedPath, assistantLine('claude-fable-5'))
    handleClaudeCliModelChangeHook(
      SESSION_ID,
      { hook_event_name: 'Stop', transcript_path: clearedPath },
      { db }
    )
    expect(db.updateSession).not.toHaveBeenCalled()
  })

  it('consumes pre-existing backlog silently — historical transitions never fire', () => {
    // The exact respawn scenario: a fable→sonnet degrade already sits in the
    // transcript from a previous run, but the user has since explicitly picked
    // opus (+max) in Hive. Attaching must not replay the stale transition and
    // revert that choice.
    const db = makeDb(makeSession({ model_id: 'opus', model_variant: 'max' }))
    writeFileSync(
      transcriptPath,
      assistantLine('claude-fable-5') + assistantLine('claude-sonnet-5-20250929')
    )
    handleClaudeCliModelChangeHook(SESSION_ID, stopHook(), { db })
    expect(db.updateSession).not.toHaveBeenCalled()

    // The respawned CLI answers on opus: a live sonnet→opus transition whose
    // alias equals the row — still nothing to write.
    appendFileSync(transcriptPath, assistantLine('claude-opus-5-20260101'))
    handleClaudeCliModelChangeHook(SESSION_ID, stopHook(), { db })
    expect(db.updateSession).not.toHaveBeenCalled()
  })

  it('does not fire on a row/transcript mismatch without an in-transcript switch', () => {
    // The user picked sonnet in Hive while the CLI keeps running fable until
    // respawn — the pending choice must not be reverted.
    const db = makeDb(makeSession({ model_id: 'sonnet' }))
    writeFileSync(transcriptPath, assistantLine('claude-fable-5'))
    handleClaudeCliModelChangeHook(SESSION_ID, stopHook(), { db })
    appendFileSync(transcriptPath, assistantLine('claude-fable-5'))
    handleClaudeCliModelChangeHook(SESSION_ID, stopHook(), { db })
    expect(db.updateSession).not.toHaveBeenCalled()
  })

  it('stays quiet when a live switch nets out to the session row model', () => {
    const db = makeDb(makeSession())
    writeFileSync(transcriptPath, assistantLine('claude-fable-5'))
    handleClaudeCliModelChangeHook(SESSION_ID, stopHook(), { db })

    appendFileSync(
      transcriptPath,
      assistantLine('claude-sonnet-5-20250929') + assistantLine('claude-fable-5')
    )
    handleClaudeCliModelChangeHook(SESSION_ID, stopHook(), { db })
    expect(db.updateSession).not.toHaveBeenCalled()
  })

  it('ignores raw-id churn within the same alias — not a switch Hive can express', () => {
    // DB says opus (pending user choice); a dated sonnet snapshot bump must
    // not count as a transition and revert it.
    const db = makeDb(makeSession({ model_id: 'opus' }))
    writeFileSync(transcriptPath, assistantLine('claude-sonnet-5-20250929'))
    handleClaudeCliModelChangeHook(SESSION_ID, stopHook(), { db })

    appendFileSync(transcriptPath, assistantLine('claude-sonnet-5-20260101'))
    handleClaudeCliModelChangeHook(SESSION_ID, stopHook(), { db })
    expect(db.updateSession).not.toHaveBeenCalled()
  })

  it('ignores sidechain and synthetic lines when tracking switches', () => {
    const db = makeDb(makeSession())
    writeFileSync(transcriptPath, assistantLine('claude-fable-5'))
    handleClaudeCliModelChangeHook(SESSION_ID, stopHook(), { db })

    appendFileSync(
      transcriptPath,
      assistantLine('claude-haiku-4-5-20251001', { isSidechain: true }) +
        assistantLine('<synthetic>', { isApiErrorMessage: true }) +
        assistantLine('claude-fable-5')
    )
    handleClaudeCliModelChangeHook(SESSION_ID, stopHook(), { db })
    expect(db.updateSession).not.toHaveBeenCalled()
  })

  it('clamps an extended effort variant when degrading to sonnet/haiku', () => {
    const db = makeDb(makeSession({ model_variant: 'max' }))
    writeFileSync(transcriptPath, assistantLine('claude-fable-5'))
    handleClaudeCliModelChangeHook(SESSION_ID, stopHook(), { db })

    appendFileSync(transcriptPath, assistantLine('claude-sonnet-5-20250929'))
    handleClaudeCliModelChangeHook(SESSION_ID, stopHook(), { db })
    expect(db.updateSession).toHaveBeenCalledWith(SESSION_ID, {
      model_id: 'sonnet',
      model_variant: 'high'
    })
    expect(publishDesktopBackendEvent).toHaveBeenCalledWith(
      'opencode:stream',
      expect.objectContaining({
        data: expect.objectContaining({ modelVariant: 'high' })
      })
    )
  })

  it('leaves the ultracode variant untouched on degrade', () => {
    const db = makeDb(makeSession({ model_variant: 'ultracode' }))
    writeFileSync(transcriptPath, assistantLine('claude-fable-5'))
    handleClaudeCliModelChangeHook(SESSION_ID, stopHook(), { db })

    appendFileSync(transcriptPath, assistantLine('claude-sonnet-5-20250929'))
    handleClaudeCliModelChangeHook(SESSION_ID, stopHook(), { db })
    expect(db.updateSession).toHaveBeenCalledWith(SESSION_ID, { model_id: 'sonnet' })
  })

  it('skips custom-provider sessions entirely', () => {
    const db = makeDb(makeSession({ model_provider_id: 'custom', model_id: 'kimi-sonnet' }))
    writeFileSync(transcriptPath, assistantLine('claude-fable-5'))
    handleClaudeCliModelChangeHook(SESSION_ID, stopHook(), { db })

    appendFileSync(transcriptPath, assistantLine('claude-sonnet-5-20250929'))
    handleClaudeCliModelChangeHook(SESSION_ID, stopHook(), { db })
    expect(db.updateSession).not.toHaveBeenCalled()
  })

  it('skips non claude-code-cli sessions and unknown sessions', () => {
    const sdkDb = makeDb(makeSession({ agent_sdk: 'claude-code' }))
    writeFileSync(transcriptPath, assistantLine('claude-fable-5'))
    handleClaudeCliModelChangeHook(SESSION_ID, stopHook(), { db: sdkDb })
    appendFileSync(transcriptPath, assistantLine('claude-sonnet-5-20250929'))
    handleClaudeCliModelChangeHook(SESSION_ID, stopHook(), { db: sdkDb })
    expect(sdkDb.updateSession).not.toHaveBeenCalled()

    const missingDb = makeDb(null)
    handleClaudeCliModelChangeHook(SESSION_ID, stopHook(), { db: missingDb })
    expect(missingDb.updateSession).not.toHaveBeenCalled()
  })

  it('ignores hooks without a usable event name or transcript path', () => {
    const db = makeDb(makeSession())
    writeFileSync(
      transcriptPath,
      assistantLine('claude-fable-5') + assistantLine('claude-sonnet-5-20250929')
    )
    handleClaudeCliModelChangeHook(
      SESSION_ID,
      { hook_event_name: 'PostToolUse', transcript_path: transcriptPath },
      { db }
    )
    handleClaudeCliModelChangeHook(SESSION_ID, { hook_event_name: 'Stop' }, { db })
    expect(db.updateSession).not.toHaveBeenCalled()
    expect(db.getSession).not.toHaveBeenCalled()
  })

  it('detects on UserPromptSubmit as well as Stop', () => {
    const db = makeDb(makeSession())
    writeFileSync(transcriptPath, assistantLine('claude-fable-5'))
    handleClaudeCliModelChangeHook(
      SESSION_ID,
      { hook_event_name: 'UserPromptSubmit', transcript_path: transcriptPath },
      { db }
    )
    appendFileSync(transcriptPath, assistantLine('claude-opus-5-20260101'))
    handleClaudeCliModelChangeHook(
      SESSION_ID,
      { hook_event_name: 'UserPromptSubmit', transcript_path: transcriptPath },
      { db }
    )
    expect(db.updateSession).toHaveBeenCalledWith(SESSION_ID, { model_id: 'opus' })
  })

  it('leaves a partial trailing line for the next read instead of parsing half a line', () => {
    const db = makeDb(makeSession())
    writeFileSync(transcriptPath, assistantLine('claude-fable-5'))
    handleClaudeCliModelChangeHook(SESSION_ID, stopHook(), { db })

    const switchLine = assistantLine('claude-sonnet-5-20250929')
    const splitAt = Math.floor(switchLine.length / 2)
    appendFileSync(transcriptPath, switchLine.slice(0, splitAt))
    handleClaudeCliModelChangeHook(SESSION_ID, stopHook(), { db })
    expect(db.updateSession).not.toHaveBeenCalled()

    appendFileSync(transcriptPath, switchLine.slice(splitAt))
    handleClaudeCliModelChangeHook(SESSION_ID, stopHook(), { db })
    expect(db.updateSession).toHaveBeenCalledWith(SESSION_ID, { model_id: 'sonnet' })
  })

  it('re-baselines when the transcript path changes (new CLI session)', () => {
    const db = makeDb(makeSession())
    writeFileSync(transcriptPath, assistantLine('claude-fable-5'))
    handleClaudeCliModelChangeHook(SESSION_ID, stopHook(), { db })

    // /clear → new session file, running on sonnet from its first turn: no
    // in-transcript switch, so nothing to apply.
    const newPath = path.join(dir, 'session-2.jsonl')
    writeFileSync(newPath, assistantLine('claude-sonnet-5-20250929'))
    handleClaudeCliModelChangeHook(
      SESSION_ID,
      { hook_event_name: 'Stop', transcript_path: newPath },
      { db }
    )
    expect(db.updateSession).not.toHaveBeenCalled()
  })

  it('re-baselines when the transcript shrinks (rewritten file)', () => {
    const db = makeDb(makeSession())
    writeFileSync(
      transcriptPath,
      assistantLine('claude-fable-5') + assistantLine('claude-fable-5')
    )
    handleClaudeCliModelChangeHook(SESSION_ID, stopHook(), { db })

    writeFileSync(transcriptPath, assistantLine('claude-sonnet-5-20250929'))
    handleClaudeCliModelChangeHook(SESSION_ID, stopHook(), { db })
    expect(db.updateSession).not.toHaveBeenCalled()

    appendFileSync(transcriptPath, assistantLine('claude-opus-5-20260101'))
    handleClaudeCliModelChangeHook(SESSION_ID, stopHook(), { db })
    expect(db.updateSession).toHaveBeenCalledWith(SESSION_ID, { model_id: 'opus' })
  })

  it('resetClaudeCliModelWatcher drops state; re-attach re-baselines silently', () => {
    const db = makeDb(makeSession())
    writeFileSync(transcriptPath, assistantLine('claude-fable-5'))
    handleClaudeCliModelChangeHook(SESSION_ID, stopHook(), { db })

    resetClaudeCliModelWatcher(SESSION_ID)

    // The whole file (including this appended switch) is backlog for the
    // fresh tracker — consumed silently, never replayed.
    appendFileSync(transcriptPath, assistantLine('claude-sonnet-5-20250929'))
    handleClaudeCliModelChangeHook(SESSION_ID, stopHook(), { db })
    expect(db.updateSession).not.toHaveBeenCalled()

    // A live transition after re-attach still fires.
    appendFileSync(transcriptPath, assistantLine('claude-haiku-4-5-20251001'))
    handleClaudeCliModelChangeHook(SESSION_ID, stopHook(), { db })
    expect(db.updateSession).toHaveBeenCalledWith(SESSION_ID, { model_id: 'haiku' })
  })

  it('baselines a large backlog from the file tail only', () => {
    const db = makeDb(makeSession())
    // >512KB of non-assistant noise, then the backlog's final model (sonnet).
    const noise = `${JSON.stringify({ type: 'user', message: { content: 'x'.repeat(4000) } })}\n`
    writeFileSync(transcriptPath, noise.repeat(140) + assistantLine('claude-sonnet-5-20250929'))
    handleClaudeCliModelChangeHook(SESSION_ID, stopHook(), { db })
    expect(db.updateSession).not.toHaveBeenCalled()

    // The tail-read baseline must have seeded sonnet: a live opus line is a
    // sonnet→opus transition, and opus ≠ the row's fable.
    appendFileSync(transcriptPath, assistantLine('claude-opus-5-20260101'))
    handleClaudeCliModelChangeHook(SESSION_ID, stopHook(), { db })
    expect(db.updateSession).toHaveBeenCalledWith(SESSION_ID, { model_id: 'opus' })
  })
})
