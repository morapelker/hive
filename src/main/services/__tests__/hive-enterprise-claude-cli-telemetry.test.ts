import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { APP_SETTINGS_DB_KEY } from '@shared/types/settings'
import type { DatabaseService } from '../../db/database'
import type { Session, Worktree, Project } from '../../db/types'
import {
  __resetClaudeCliHiveTelemetryForTests,
  handleClaudeCliHiveTelemetryHook
} from '../hive-enterprise-claude-cli-telemetry'

const gitServiceMocks = vi.hoisted(() => ({
  getRemoteUrl: vi.fn()
}))

vi.mock('../git-service', () => ({
  GitService: vi.fn().mockImplementation(() => ({
    getRemoteUrl: gitServiceMocks.getRemoteUrl
  }))
}))

// The server now generates the prompt id and returns it from recordPromptStart.
const SERVER_PROMPT_ID = 'ServerGenerated123_prompt'

function assistantLine(usage: {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
}): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      usage: {
        input_tokens: usage.input ?? 0,
        output_tokens: usage.output ?? 0,
        cache_read_input_tokens: usage.cacheRead ?? 0,
        cache_creation_input_tokens: usage.cacheWrite ?? 0
      }
    }
  })
}

const session: Session = {
  id: 'hive-session-1',
  worktree_id: 'worktree-1',
  project_id: 'project-1',
  connection_id: 'connection-1',
  name: 'Session 1',
  status: 'active',
  opencode_session_id: null,
  claude_session_id: 'claude-session-1',
  agent_sdk: 'claude-code-cli',
  mode: 'plan',
  session_type: 'default',
  model_provider_id: 'anthropic',
  model_id: 'sonnet',
  model_variant: 'high',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  completed_at: null,
  pinned_to_board: false
}

const worktree: Worktree = {
  id: 'worktree-1',
  project_id: 'project-1',
  name: 'feature',
  branch_name: 'feature/claude-cli',
  path: '/repo/worktree',
  status: 'active',
  is_default: false,
  branch_renamed: 0,
  last_message_at: null,
  session_titles: '[]',
  last_model_provider_id: null,
  last_model_id: null,
  last_model_variant: null,
  attachments: '[]',
  pinned: 0,
  context: null,
  github_pr_number: null,
  github_pr_url: null,
  base_branch: 'main',
  created_at: '2026-01-01T00:00:00.000Z',
  last_accessed_at: '2026-01-01T00:00:00.000Z'
}

const project: Project = {
  id: 'project-1',
  name: 'Hive Electron',
  path: '/repo',
  description: null,
  tags: null,
  language: null,
  custom_icon: null,
  detected_icon: null,
  setup_script: null,
  run_script: null,
  archive_script: null,
  worktree_create_script: null,
  custom_commands: null,
  auto_assign_port: false,
  sort_order: 0,
  created_at: '2026-01-01T00:00:00.000Z',
  last_accessed_at: '2026-01-01T00:00:00.000Z'
}

function makeDb(settings: Record<string, unknown>): DatabaseService {
  let currentSettings = { ...settings }
  return {
    getSetting: vi.fn((key: string) =>
      key === APP_SETTINGS_DB_KEY ? JSON.stringify(currentSettings) : null
    ),
    setSetting: vi.fn((key: string, value: string) => {
      if (key === APP_SETTINGS_DB_KEY) {
        currentSettings = JSON.parse(value) as Record<string, unknown>
      }
    }),
    getSession: vi.fn(() => session),
    getWorktree: vi.fn(() => worktree),
    getProject: vi.fn(() => project),
    getConnection: vi.fn(() => ({
      id: 'connection-1',
      name: 'Stack',
      custom_name: null,
      path: '/repo',
      color: null,
      status: 'active',
      pinned: 0,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      members: [
        {
          id: 'member-1',
          connection_id: 'connection-1',
          worktree_id: 'worktree-1',
          project_id: 'project-1',
          symlink_name: 'enterprise',
          added_at: '2026-01-01T00:00:00.000Z',
          worktree_name: 'feature',
          worktree_branch: 'feature/claude-cli',
          worktree_path: '/repo/worktree',
          project_name: 'Hive Electron'
        }
      ]
    }))
  } as unknown as DatabaseService
}

function makeTranscript(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'hive-claude-cli-telemetry-'))
  const file = join(dir, 'transcript.jsonl')
  writeFileSync(file, text)
  return file
}

/**
 * Write a subagent transcript next to the main transcript, mirroring Claude's
 * on-disk layout: `<dir>/<sessionId>/subagents/agent-<id>.jsonl` for a main
 * transcript at `<dir>/<sessionId>.jsonl`.
 */
function writeSubagentTranscript(transcriptPath: string, agentId: string, text: string): void {
  const subagentsDir = join(transcriptPath.replace(/\.jsonl$/, ''), 'subagents')
  mkdirSync(subagentsDir, { recursive: true })
  writeFileSync(join(subagentsDir, `agent-${agentId}.jsonl`), text)
}

describe('Claude CLI Hive Enterprise telemetry', () => {
  const requestGraphql = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    __resetClaudeCliHiveTelemetryForTests()
    gitServiceMocks.getRemoteUrl.mockResolvedValue({
      success: true,
      url: 'git@github.com:example/hive.git',
      remote: 'origin'
    })
    requestGraphql.mockResolvedValue({
      recordPromptStart: { recorded: true, promptId: SERVER_PROMPT_ID }
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    __resetClaudeCliHiveTelemetryForTests()
  })

  it('records a prompt start from UserPromptSubmit with transcript context length', async () => {
    const transcriptPath = makeTranscript(
      `${assistantLine({ input: 100, output: 5, cacheRead: 20, cacheWrite: 7 })}\n`
    )
    const db = makeDb({
      hiveEnterpriseServerUrl: 'https://enterprise.example.com/',
      hiveAuthToken: 'token-1',
      hiveOrganizationId: 'org-1'
    })

    await handleClaudeCliHiveTelemetryHook(
      'hive-session-1',
      {
        hook_event_name: 'UserPromptSubmit',
        prompt: 'Implement the Claude CLI hook',
        transcript_path: transcriptPath
      },
      { db, requestGraphql, now: () => new Date('2026-06-07T10:00:00.000Z') }
    )

    expect(requestGraphql).toHaveBeenCalledTimes(1)
    expect(requestGraphql).toHaveBeenCalledWith(
      'https://enterprise.example.com/api/graphql',
      'token-1',
      expect.stringContaining('recordPromptStart'),
      {
        input: expect.objectContaining({
          prompt: 'Implement the Claude CLI hook',
          sessionId: 'hive-session-1',
          worktreeId: 'worktree-1',
          worktreeBranch: 'feature/claude-cli',
          worktreePath: '/repo/worktree',
          projectName: 'Hive Electron',
          projectPath: '/repo',
          gitRemoteUrl: 'git@github.com:example/hive.git',
          providerId: 'claude-code-cli',
          modelProviderId: 'anthropic',
          modelId: 'sonnet',
          modelVariant: 'high',
          mode: 'plan',
          isGoalPrompt: false,
          contextLength: 127,
          loggedAt: '2026-06-07T10:00:00.000Z',
          connectionProjects: JSON.stringify([{ name: 'Hive Electron', path: '/repo' }])
        })
      }
    )
    expect(requestGraphql.mock.calls[0][3].input).not.toHaveProperty('promptId')
  })

  it('sends zero context length when the Claude CLI transcript has no prior assistant context', async () => {
    const transcriptPath = makeTranscript('')
    const db = makeDb({
      hiveEnterpriseServerUrl: 'https://enterprise.example.com/',
      hiveAuthToken: 'token-1',
      hiveOrganizationId: 'org-1'
    })

    await handleClaudeCliHiveTelemetryHook(
      'hive-session-1',
      {
        hook_event_name: 'UserPromptSubmit',
        prompt: 'Start from an empty context',
        transcript_path: transcriptPath
      },
      { db, requestGraphql }
    )

    expect(requestGraphql.mock.calls[0][3].input).toMatchObject({
      prompt: 'Start from an empty context',
      contextLength: 0
    })
  })

  it('blanks prompt text when the organization disables prompt storage', async () => {
    const transcriptPath = makeTranscript('')
    const db = makeDb({
      hiveEnterpriseServerUrl: 'https://enterprise.example.com/',
      hiveAuthToken: 'token-1',
      hiveOrganizationId: 'org-1',
      hiveOrganizationStorePrompts: false
    })

    await handleClaudeCliHiveTelemetryHook(
      'hive-session-1',
      {
        hook_event_name: 'UserPromptSubmit',
        prompt: '/goal keep private prompt text local',
        transcript_path: transcriptPath
      },
      { db, requestGraphql }
    )

    expect(requestGraphql).toHaveBeenCalledTimes(1)
    expect(requestGraphql.mock.calls[0][3].input).toMatchObject({
      prompt: '',
      sessionId: 'hive-session-1',
      providerId: 'claude-code-cli',
      modelProviderId: 'anthropic',
      modelId: 'sonnet',
      modelVariant: 'high',
      mode: 'plan',
      isGoalPrompt: true
    })
  })

  it('reconciles storePrompts changes from start and idle mutation responses', async () => {
    const transcriptPath = makeTranscript('')
    const db = makeDb({
      hiveEnterpriseServerUrl: 'https://enterprise.example.com/',
      hiveAuthToken: 'token-1',
      hiveOrganizationId: 'org-1',
      hiveOrganizationStorePrompts: true
    })
    requestGraphql
      .mockResolvedValueOnce({
        recordPromptStart: { recorded: true, promptId: SERVER_PROMPT_ID, storePrompts: false }
      })
      .mockResolvedValueOnce({
        recordPromptIdle: { recorded: true, storePrompts: true }
      })

    await handleClaudeCliHiveTelemetryHook(
      'hive-session-1',
      {
        hook_event_name: 'UserPromptSubmit',
        prompt: 'Start private mode',
        transcript_path: transcriptPath
      },
      { db, requestGraphql }
    )

    expect(db.setSetting).toHaveBeenLastCalledWith(
      APP_SETTINGS_DB_KEY,
      expect.stringContaining('"hiveOrganizationStorePrompts":false')
    )

    writeFileSync(transcriptPath, `${assistantLine({ input: 5, output: 7 })}\n`)

    await handleClaudeCliHiveTelemetryHook(
      'hive-session-1',
      { hook_event_name: 'Stop', transcript_path: transcriptPath },
      { db, requestGraphql }
    )

    expect(db.setSetting).toHaveBeenLastCalledWith(
      APP_SETTINGS_DB_KEY,
      expect.stringContaining('"hiveOrganizationStorePrompts":true')
    )
  })

  it('uses the default Hive Enterprise server when settings omit the server URL', async () => {
    const transcriptPath = makeTranscript('')
    const db = makeDb({
      hiveAuthToken: 'token-1',
      hiveOrganizationId: 'org-1'
    })

    await handleClaudeCliHiveTelemetryHook(
      'hive-session-1',
      {
        hook_event_name: 'UserPromptSubmit',
        prompt: 'Use default endpoint',
        transcript_path: transcriptPath
      },
      { db, requestGraphql }
    )

    expect(requestGraphql.mock.calls[0][0]).toBe('https://hive.tedooo.com/api/graphql')
  })

  it('records idle token deltas on Stop for the active Claude CLI prompt', async () => {
    const transcriptPath = makeTranscript(
      `${assistantLine({ input: 100, output: 5, cacheRead: 20, cacheWrite: 7 })}\n`
    )
    const db = makeDb({
      hiveEnterpriseServerUrl: 'https://enterprise.example.com',
      hiveAuthToken: 'token-1',
      hiveOrganizationId: 'org-1'
    })

    await handleClaudeCliHiveTelemetryHook(
      'hive-session-1',
      {
        hook_event_name: 'UserPromptSubmit',
        prompt: 'Continue',
        transcript_path: transcriptPath
      },
      { db, requestGraphql }
    )
    const promptId = SERVER_PROMPT_ID

    writeFileSync(
      transcriptPath,
      [
        assistantLine({ input: 100, output: 5, cacheRead: 20, cacheWrite: 7 }),
        assistantLine({ input: 140, output: 30, cacheRead: 25, cacheWrite: 9 })
      ].join('\n') + '\n'
    )

    await handleClaudeCliHiveTelemetryHook(
      'hive-session-1',
      { hook_event_name: 'Stop', transcript_path: transcriptPath },
      { db, requestGraphql }
    )

    expect(requestGraphql).toHaveBeenCalledTimes(2)
    expect(requestGraphql.mock.calls[1]).toEqual([
      'https://enterprise.example.com/api/graphql',
      'token-1',
      expect.stringContaining('recordPromptIdle'),
      {
        input: {
          promptId,
          inputTokens: 140,
          outputTokens: 30,
          cacheReadTokens: 25,
          cacheWriteTokens: 9
        }
      }
    ])
  })

  it('includes subagent transcript usage in idle token deltas', async () => {
    const transcriptPath = makeTranscript(
      `${assistantLine({ input: 100, output: 5, cacheRead: 20, cacheWrite: 7 })}\n`
    )
    const db = makeDb({
      hiveEnterpriseServerUrl: 'https://enterprise.example.com',
      hiveAuthToken: 'token-1',
      hiveOrganizationId: 'org-1'
    })

    await handleClaudeCliHiveTelemetryHook(
      'hive-session-1',
      {
        hook_event_name: 'UserPromptSubmit',
        prompt: 'Fan out subagents',
        transcript_path: transcriptPath
      },
      { db, requestGraphql }
    )

    // The turn spawns two Task subagents; their usage is written to separate
    // transcripts under <sessionDir>/subagents/, never to the main transcript.
    writeSubagentTranscript(
      transcriptPath,
      'a1',
      [
        assistantLine({ input: 50, output: 40, cacheRead: 1000, cacheWrite: 60 }),
        assistantLine({ input: 10, output: 20, cacheRead: 2000, cacheWrite: 30 })
      ].join('\n') + '\n'
    )
    writeSubagentTranscript(
      transcriptPath,
      'a2',
      `${assistantLine({ input: 5, output: 15, cacheRead: 500, cacheWrite: 25 })}\n`
    )
    writeFileSync(
      transcriptPath,
      [
        assistantLine({ input: 100, output: 5, cacheRead: 20, cacheWrite: 7 }),
        assistantLine({ input: 140, output: 30, cacheRead: 25, cacheWrite: 9 })
      ].join('\n') + '\n'
    )

    await handleClaudeCliHiveTelemetryHook(
      'hive-session-1',
      { hook_event_name: 'Stop', transcript_path: transcriptPath },
      { db, requestGraphql }
    )

    expect(requestGraphql.mock.calls[1]).toEqual([
      'https://enterprise.example.com/api/graphql',
      'token-1',
      expect.stringContaining('recordPromptIdle'),
      {
        input: {
          promptId: SERVER_PROMPT_ID,
          inputTokens: 140 + 50 + 10 + 5,
          outputTokens: 30 + 40 + 20 + 15,
          cacheReadTokens: 25 + 1000 + 2000 + 500,
          cacheWriteTokens: 9 + 60 + 30 + 25
        }
      }
    ])
  })

  it('excludes subagent usage from before the prompt via the start baseline', async () => {
    const transcriptPath = makeTranscript(
      `${assistantLine({ input: 100, output: 5, cacheRead: 20, cacheWrite: 7 })}\n`
    )
    // A subagent from a PREVIOUS prompt already exists at prompt start.
    writeSubagentTranscript(
      transcriptPath,
      'old',
      `${assistantLine({ input: 500, output: 400, cacheRead: 9000, cacheWrite: 300 })}\n`
    )
    const db = makeDb({
      hiveEnterpriseServerUrl: 'https://enterprise.example.com',
      hiveAuthToken: 'token-1',
      hiveOrganizationId: 'org-1'
    })

    await handleClaudeCliHiveTelemetryHook(
      'hive-session-1',
      {
        hook_event_name: 'UserPromptSubmit',
        prompt: 'Continue',
        transcript_path: transcriptPath
      },
      { db, requestGraphql }
    )

    writeFileSync(
      transcriptPath,
      [
        assistantLine({ input: 100, output: 5, cacheRead: 20, cacheWrite: 7 }),
        assistantLine({ input: 140, output: 30, cacheRead: 25, cacheWrite: 9 })
      ].join('\n') + '\n'
    )

    await handleClaudeCliHiveTelemetryHook(
      'hive-session-1',
      { hook_event_name: 'Stop', transcript_path: transcriptPath },
      { db, requestGraphql }
    )

    // Only this turn's main-transcript delta — the old subagent's usage was
    // captured in the baseline and must not leak into this prompt's totals.
    expect(requestGraphql.mock.calls[1]).toEqual([
      'https://enterprise.example.com/api/graphql',
      'token-1',
      expect.stringContaining('recordPromptIdle'),
      {
        input: {
          promptId: SERVER_PROMPT_ID,
          inputTokens: 140,
          outputTokens: 30,
          cacheReadTokens: 25,
          cacheWriteTokens: 9
        }
      }
    ])
  })

  it('waits briefly for Claude to flush transcript usage before recording idle', async () => {
    vi.useFakeTimers()
    const transcriptPath = makeTranscript(
      `${assistantLine({ input: 100, output: 5, cacheRead: 20, cacheWrite: 7 })}\n`
    )
    const db = makeDb({
      hiveEnterpriseServerUrl: 'https://enterprise.example.com',
      hiveAuthToken: 'token-1',
      hiveOrganizationId: 'org-1'
    })

    await handleClaudeCliHiveTelemetryHook(
      'hive-session-1',
      {
        hook_event_name: 'UserPromptSubmit',
        prompt: 'Continue',
        transcript_path: transcriptPath
      },
      { db, requestGraphql }
    )
    const promptId = SERVER_PROMPT_ID

    setTimeout(() => {
      writeFileSync(
        transcriptPath,
        [
          assistantLine({ input: 100, output: 5, cacheRead: 20, cacheWrite: 7 }),
          assistantLine({ input: 80, output: 22, cacheRead: 10, cacheWrite: 3 })
        ].join('\n') + '\n'
      )
    }, 50)

    const stopPromise = handleClaudeCliHiveTelemetryHook(
      'hive-session-1',
      { hook_event_name: 'Stop', transcript_path: transcriptPath },
      { db, requestGraphql }
    )

    await vi.advanceTimersByTimeAsync(50)
    await stopPromise

    expect(requestGraphql.mock.calls[1]).toEqual([
      'https://enterprise.example.com/api/graphql',
      'token-1',
      expect.stringContaining('recordPromptIdle'),
      {
        input: {
          promptId,
          inputTokens: 80,
          outputTokens: 22,
          cacheReadTokens: 10,
          cacheWriteTokens: 3
        }
      }
    ])
  })

  it('ignores a task-notification UserPromptSubmit, recording no active prompt', async () => {
    const db = makeDb({
      hiveEnterpriseServerUrl: 'https://enterprise.example.com',
      hiveAuthToken: 'token-1',
      hiveOrganizationId: 'org-1'
    })

    await handleClaudeCliHiveTelemetryHook(
      'hive-session-1',
      {
        hook_event_name: 'UserPromptSubmit',
        prompt: '<task-notification>\n<task-id>a</task-id>\n</task-notification>'
      },
      { db, requestGraphql }
    )

    expect(requestGraphql).not.toHaveBeenCalled()

    // With no active prompt recorded, the eventual Stop is a no-op too.
    await handleClaudeCliHiveTelemetryHook(
      'hive-session-1',
      { hook_event_name: 'Stop' },
      { db, requestGraphql }
    )
    expect(requestGraphql).not.toHaveBeenCalled()
  })

  it('keeps a real prompt active through a task-notification resume so the final Stop attributes usage to it', async () => {
    const transcriptPath = makeTranscript(
      `${assistantLine({ input: 100, output: 5, cacheRead: 20, cacheWrite: 7 })}\n`
    )
    const db = makeDb({
      hiveEnterpriseServerUrl: 'https://enterprise.example.com',
      hiveAuthToken: 'token-1',
      hiveOrganizationId: 'org-1'
    })

    // The real, user-authored prompt.
    await handleClaudeCliHiveTelemetryHook(
      'hive-session-1',
      {
        hook_event_name: 'UserPromptSubmit',
        prompt: 'Do the real work',
        transcript_path: transcriptPath
      },
      { db, requestGraphql }
    )
    expect(requestGraphql).toHaveBeenCalledTimes(1)

    // A deferred Stop (background subagent still running) is skipped upstream
    // by claude-hook-server and never reaches this module. The subagent's
    // completion then resumes the session via a task-notification prompt,
    // which must NOT clobber the real prompt's still-active record.
    await handleClaudeCliHiveTelemetryHook(
      'hive-session-1',
      {
        hook_event_name: 'UserPromptSubmit',
        prompt: '<task-notification>\n<task-id>a</task-id>\n</task-notification>',
        transcript_path: transcriptPath
      },
      { db, requestGraphql }
    )
    // No new recordPromptStart — the notification did not start a new prompt.
    expect(requestGraphql).toHaveBeenCalledTimes(1)

    writeFileSync(
      transcriptPath,
      [
        assistantLine({ input: 100, output: 5, cacheRead: 20, cacheWrite: 7 }),
        assistantLine({ input: 140, output: 30, cacheRead: 25, cacheWrite: 9 })
      ].join('\n') + '\n'
    )

    // The final, passing Stop attributes the entire multi-turn usage delta to
    // the real prompt's id and baseline.
    await handleClaudeCliHiveTelemetryHook(
      'hive-session-1',
      { hook_event_name: 'Stop', transcript_path: transcriptPath },
      { db, requestGraphql }
    )

    expect(requestGraphql).toHaveBeenCalledTimes(2)
    expect(requestGraphql.mock.calls[1]).toEqual([
      'https://enterprise.example.com/api/graphql',
      'token-1',
      expect.stringContaining('recordPromptIdle'),
      {
        input: {
          promptId: SERVER_PROMPT_ID,
          inputTokens: 140,
          outputTokens: 30,
          cacheReadTokens: 25,
          cacheWriteTokens: 9
        }
      }
    ])
  })

  it('does not record hooks when Hive Enterprise organization settings are missing', async () => {
    const db = makeDb({
      hiveEnterpriseServerUrl: 'https://enterprise.example.com',
      hiveAuthToken: 'token-1',
      hiveOrganizationId: null
    })

    await handleClaudeCliHiveTelemetryHook(
      'hive-session-1',
      {
        hook_event_name: 'UserPromptSubmit',
        prompt: 'Skip this'
      },
      { db, requestGraphql }
    )

    expect(requestGraphql).not.toHaveBeenCalled()
  })
})
