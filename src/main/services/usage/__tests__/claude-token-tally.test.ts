import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { DatabaseService } from '../../../db/database'
import { encodePath } from '../../claude-transcript-reader'
import { getClaudeTokenTally, __resetClaudeTokenTallyForTests } from '../claude-token-tally'

let root: string
let prevConfigDir: string | undefined

function entry(
  id: string,
  input: number,
  output: number,
  opts: { cacheRead?: number; cacheWrite?: number; ts?: string } = {}
): string {
  return (
    JSON.stringify({
      type: 'assistant',
      timestamp: opts.ts ?? '2026-08-24T10:05:00Z',
      requestId: `req-${id}`,
      message: {
        id,
        model: 'claude-fable-5',
        usage: {
          input_tokens: input,
          output_tokens: output,
          cache_read_input_tokens: opts.cacheRead ?? 0,
          cache_creation_input_tokens: opts.cacheWrite ?? 0
        }
      }
    }) + '\n'
  )
}

interface SessionRowSpec {
  id: string
  agentSdk: string
  claudeSessionId: string | null
  remoteLaunch?: number | null
  customProviderId?: string | null
  createdAt?: string
}

function makeDb(
  worktreePath: string,
  sessions: SessionRowSpec[],
  settingsJson: string | null = null
): DatabaseService {
  return {
    listRecentUsageSessionIds: vi.fn(() => sessions.map((s) => s.id)),
    getSetting: vi.fn(() => settingsJson),
    getSession: vi.fn((id: string) => {
      const spec = sessions.find((s) => s.id === id)
      if (!spec) return null
      return {
        id: spec.id,
        worktree_id: 'wt-1',
        project_id: 'proj-1',
        connection_id: null,
        agent_sdk: spec.agentSdk,
        claude_session_id: spec.claudeSessionId,
        opencode_session_id: null,
        custom_provider_id: spec.customProviderId ?? null,
        created_at: spec.createdAt ?? new Date().toISOString(),
        remote_launch: spec.remoteLaunch ?? null
      }
    }),
    getWorktree: vi.fn(() => ({
      id: 'wt-1',
      path: worktreePath,
      branch_name: 'feat/x',
      project_id: 'proj-1'
    })),
    getProject: vi.fn(() => ({ id: 'proj-1', name: 'Proj', path: worktreePath })),
    getConnection: vi.fn(() => null)
  } as unknown as DatabaseService
}

function transcriptPath(worktreePath: string, claudeSessionId: string): string {
  const dir = join(root, 'claude-config', 'projects', encodePath(worktreePath))
  mkdirSync(dir, { recursive: true })
  return join(dir, `${claudeSessionId}.jsonl`)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'token-tally-'))
  prevConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = join(root, 'claude-config')
  __resetClaudeTokenTallyForTests()
})

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = prevConfigDir
  rmSync(root, { recursive: true, force: true })
  __resetClaudeTokenTallyForTests()
})

describe('getClaudeTokenTally', () => {
  it('sums main-transcript and subagent tokens across recent Claude sessions', async () => {
    const worktreePath = join(root, 'wt')
    mkdirSync(worktreePath, { recursive: true })
    const main = transcriptPath(worktreePath, 'claude-sess-1')
    writeFileSync(main, entry('m1', 100, 10, { cacheRead: 1_000, cacheWrite: 50 }))
    const subagentsDir = join(main.slice(0, -'.jsonl'.length), 'subagents')
    mkdirSync(subagentsDir, { recursive: true })
    writeFileSync(join(subagentsDir, 'agent-1.jsonl'), entry('s1', 200, 20))

    const db = makeDb(worktreePath, [
      { id: 'hive-1', agentSdk: 'claude-code-cli', claudeSessionId: 'claude-sess-1' }
    ])

    const tally = await getClaudeTokenTally({ db })

    expect(tally.inputTokens).toBe(300)
    expect(tally.outputTokens).toBe(30)
    expect(tally.cacheReadTokens).toBe(1_000)
    expect(tally.cacheWriteTokens).toBe(50)
    expect(tally.sessionCount).toBe(1)
  })

  it('is cumulative and cheap across calls: appended bytes only grow the total', async () => {
    const worktreePath = join(root, 'wt')
    mkdirSync(worktreePath, { recursive: true })
    const main = transcriptPath(worktreePath, 'claude-sess-1')
    writeFileSync(main, entry('m1', 100, 10))
    const db = makeDb(worktreePath, [
      { id: 'hive-1', agentSdk: 'claude-code', claudeSessionId: 'claude-sess-1' }
    ])

    const first = await getClaudeTokenTally({ db })
    expect(first.inputTokens).toBe(100)

    appendFileSync(main, entry('m2', 300, 30))
    const second = await getClaudeTokenTally({ db })
    expect(second.inputTokens).toBe(400)
    expect(second.outputTokens).toBe(40)
  })

  it('skips codex and remote-launch sessions', async () => {
    const worktreePath = join(root, 'wt')
    mkdirSync(worktreePath, { recursive: true })
    writeFileSync(
      transcriptPath(worktreePath, 'claude-sess-1'),
      entry('m1', 100, 10)
    )
    writeFileSync(
      transcriptPath(worktreePath, 'claude-sess-2'),
      entry('m2', 500, 50)
    )

    const db = makeDb(worktreePath, [
      { id: 'hive-codex', agentSdk: 'codex', claudeSessionId: 'claude-sess-1' },
      {
        id: 'hive-remote',
        agentSdk: 'claude-code-cli',
        claudeSessionId: 'claude-sess-2',
        remoteLaunch: 1
      }
    ])

    const tally = await getClaudeTokenTally({ db })
    expect(tally.inputTokens).toBe(0)
    expect(tally.sessionCount).toBe(0)
  })

  it('drops parser state for sessions that aged out of the recent window', async () => {
    const worktreePath = join(root, 'wt')
    mkdirSync(worktreePath, { recursive: true })
    writeFileSync(transcriptPath(worktreePath, 'claude-sess-1'), entry('m1', 100, 10))

    const sessions: SessionRowSpec[] = [
      { id: 'hive-1', agentSdk: 'claude-code-cli', claudeSessionId: 'claude-sess-1' }
    ]
    const db = makeDb(worktreePath, sessions)
    expect((await getClaudeTokenTally({ db })).inputTokens).toBe(100)

    // Session no longer listed as recent: its tokens leave the tally.
    sessions.length = 0
    expect((await getClaudeTokenTally({ db })).inputTokens).toBe(0)
  })

  it('excludes custom-provider sessions attributed to openai/none, keeps anthropic and degraded ones', async () => {
    const worktreePath = join(root, 'wt')
    mkdirSync(worktreePath, { recursive: true })
    writeFileSync(transcriptPath(worktreePath, 'claude-sess-1'), entry('m1', 100, 10))
    writeFileSync(transcriptPath(worktreePath, 'claude-sess-2'), entry('m2', 1_000, 100))
    writeFileSync(transcriptPath(worktreePath, 'claude-sess-3'), entry('m3', 10_000, 1_000))

    const settingsJson = JSON.stringify({
      customProviders: [
        { id: 'cp-openai', name: 'GPT wrapper', command: 'gptcli', usageProvider: 'openai' },
        { id: 'cp-blank', name: 'Broken', command: '   ', usageProvider: 'openai' }
      ]
    })
    const db = makeDb(
      worktreePath,
      [
        // Plain claude session: counted.
        { id: 'hive-1', agentSdk: 'claude-code-cli', claudeSessionId: 'claude-sess-1' },
        // Custom provider attributed to openai: excluded.
        {
          id: 'hive-2',
          agentSdk: 'claude-code-cli',
          claudeSessionId: 'claude-sess-2',
          customProviderId: 'cp-openai'
        },
        // Blank-command provider degrades to plain claude at spawn: counted.
        {
          id: 'hive-3',
          agentSdk: 'claude-code-cli',
          claudeSessionId: 'claude-sess-3',
          customProviderId: 'cp-blank'
        }
      ],
      settingsJson
    )

    const tally = await getClaudeTokenTally({ db })
    expect(tally.inputTokens).toBe(10_100)
    expect(tally.sessionCount).toBe(2)
  })

  it('does not let ineligible sessions consume the tracking cap', async () => {
    const worktreePath = join(root, 'wt')
    mkdirSync(worktreePath, { recursive: true })
    writeFileSync(transcriptPath(worktreePath, 'claude-sess-1'), entry('m1', 100, 10))

    // 60 codex rows ahead of the one local Claude session: a cap applied
    // before filtering would truncate the list and drop the Claude session.
    const sessions: SessionRowSpec[] = [
      ...Array.from({ length: 60 }, (_, i) => ({
        id: `hive-codex-${i}`,
        agentSdk: 'codex',
        claudeSessionId: null
      })),
      { id: 'hive-1', agentSdk: 'claude-code-cli', claudeSessionId: 'claude-sess-1' }
    ]
    const db = makeDb(worktreePath, sessions)

    const tally = await getClaudeTokenTally({ db })
    expect(tally.inputTokens).toBe(100)
    expect(tally.sessionCount).toBe(1)
  })

  it('single-flights concurrent calls', async () => {
    const worktreePath = join(root, 'wt')
    mkdirSync(worktreePath, { recursive: true })
    writeFileSync(transcriptPath(worktreePath, 'claude-sess-1'), entry('m1', 100, 10))
    const db = makeDb(worktreePath, [
      { id: 'hive-1', agentSdk: 'claude-code-cli', claudeSessionId: 'claude-sess-1' }
    ])

    const [a, b] = await Promise.all([getClaudeTokenTally({ db }), getClaudeTokenTally({ db })])
    expect(a).toBe(b)
    expect(
      (db.listRecentUsageSessionIds as ReturnType<typeof vi.fn>).mock.calls
    ).toHaveLength(1)
  })
})
