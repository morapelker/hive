import { execFile } from 'child_process'
import { promisify } from 'util'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'
import { join } from 'path'
import { writeFileSync, unlinkSync } from 'fs'
import simpleGit from 'simple-git'

import { createLogger } from './logger'
import { createGitService } from './git-service'
import { loadClaudeSDK } from './claude-sdk-loader'
import { openCodeService } from './opencode-service'
import { getDatabase } from '../db'

const log = createLogger({ component: 'PRService' })

const execFileAsync = promisify(execFile)

const MAX_COMMIT_LOG_SIZE = 20 * 1024
const MAX_DIFF_STAT_SIZE = 20 * 1024
const MAX_DIFF_PATCH_SIZE = 50 * 1024

function cap(text: string, limit: number): string {
  if (text.length <= limit) return text
  return text.slice(0, limit) + '\n... [truncated]'
}

// ── Diff context gathering ────────────────────────────────────────

export async function gatherDiffContext(
  worktreePath: string,
  baseBranch: string
): Promise<{ commitLog: string; diffStat: string; diffPatch: string }> {
  const git = simpleGit(worktreePath)

  const [commitLog, diffStat, diffPatch] = await Promise.all([
    git.raw(['log', '--oneline', `${baseBranch}..HEAD`]).catch(() => ''),
    git.raw(['diff', '--stat', `${baseBranch}..HEAD`]).catch(() => ''),
    git.raw(['diff', '--patch', '--minimal', `${baseBranch}..HEAD`]).catch(() => '')
  ])

  return {
    commitLog: cap(commitLog, MAX_COMMIT_LOG_SIZE),
    diffStat: cap(diffStat, MAX_DIFF_STAT_SIZE),
    diffPatch: cap(diffPatch, MAX_DIFF_PATCH_SIZE)
  }
}

// ── Prompt template ───────────────────────────────────────────────

function buildPrompt(params: {
  baseBranch: string
  headBranch: string
  commitLog: string
  diffStat: string
  diffPatch: string
}): string {
  return `You write GitHub pull request content.
Return a JSON object with exactly two keys: title, body
Rules:
- title: concise, specific, under 70 characters
- body: markdown with '## Summary' and '## Testing' headings
- under Summary, short bullet points describing the changes
- under Testing, concrete testing steps or 'Not tested'
- Return ONLY valid JSON, no markdown fences, no other text

Base branch: ${params.baseBranch}
Head branch: ${params.headBranch}

Commits:
${params.commitLog}

Diff stat:
${params.diffStat}

Diff:
${params.diffPatch}`
}

// ── JSON parsing helper ───────────────────────────────────────────

function parseAIResponse(raw: string): { title: string; body: string } {
  let text = raw.trim()

  // Strip markdown fences if present
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/)
  if (fenceMatch) {
    text = fenceMatch[1].trim()
  }

  const parsed = JSON.parse(text)
  if (typeof parsed.title !== 'string' || typeof parsed.body !== 'string') {
    throw new Error('AI response missing title or body keys')
  }

  return { title: parsed.title, body: parsed.body }
}

// ── SDK routing helpers ───────────────────────────────────────────

function resolveAgentSdk(
  worktreeId: string
): { sdk: 'claude-code' | 'opencode'; model: string | null } {
  const db = getDatabase()

  // Check most recent session's agent_sdk for this worktree
  const session = db
    .getSessionsByWorktree(worktreeId)
    .find((s) => s.agent_sdk)

  if (session?.agent_sdk) {
    const worktree = db.getWorktree(worktreeId)
    return {
      sdk: session.agent_sdk as 'claude-code' | 'opencode',
      model: worktree?.last_model_id ?? null
    }
  }

  // Fallback: default to Claude Code with Sonnet
  return { sdk: 'claude-code', model: 'sonnet' }
}

// ── Claude Code path ──────────────────────────────────────────────

async function generateViaClaudeCode(
  prompt: string,
  worktreePath: string,
  model: string
): Promise<string> {
  const sdk = await loadClaudeSDK()
  const abortController = new AbortController()

  const conversation = sdk.query({
    prompt,
    options: {
      cwd: worktreePath,
      permissionMode: 'plan' as const,
      model,
      maxThinkingTokens: 0,
      abortController
    }
  }) as AsyncIterable<Record<string, unknown>>

  let result = ''
  for await (const message of conversation) {
    if (message.type === 'assistant') {
      const content = message.content as
        | Array<{ type: string; text?: string }>
        | undefined
      if (content) {
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            result += block.text
          }
        }
      }
    }
  }

  return result
}

// ── OpenCode path ─────────────────────────────────────────────────

async function generateViaOpenCode(
  prompt: string,
  worktreePath: string
): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = (openCodeService as any).instance?.client
  if (!client) {
    throw new Error('No OpenCode instance available')
  }

  // Create a temporary session
  const createResult = await client.session.create({
    query: { directory: worktreePath }
  })
  const sessionId = createResult.data?.id
  if (!sessionId) {
    throw new Error('Failed to create temporary OpenCode session')
  }

  try {
    // Send prompt
    await client.session.promptAsync({
      path: { id: sessionId },
      query: { directory: worktreePath },
      body: {
        parts: [{ type: 'text', text: prompt }]
      }
    })

    // Poll for completion
    const maxWait = 120_000
    const pollInterval = 1_000
    const start = Date.now()

    while (Date.now() - start < maxWait) {
      await new Promise((resolve) => setTimeout(resolve, pollInterval))

      const statusResult = await client.session.status({
        query: { directory: worktreePath }
      })
      const statusMap = statusResult.data as
        | Record<string, { type: string }>
        | undefined
      if (statusMap?.[sessionId]?.type === 'idle') {
        break
      }
    }

    // Fetch messages and extract assistant response
    const messagesResult = await client.session.messages({
      path: { id: sessionId },
      query: { directory: worktreePath }
    })
    const messages = Array.isArray(messagesResult.data) ? messagesResult.data : []

    // Find the last assistant message text
    let assistantText = ''
    for (const msg of messages) {
      const record = typeof msg === 'object' && msg !== null ? msg : null
      if (!record) continue
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const info = (record as any).info ?? record
      const role = info?.role
      if (role !== 'assistant') continue

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const parts = Array.isArray((record as any).parts) ? (record as any).parts : []
      for (const part of parts) {
        if (part?.type === 'text' && typeof part.text === 'string') {
          assistantText = part.text
        }
      }
    }

    return assistantText
  } finally {
    // Best-effort cleanup — OpenCode SDK may not expose session.delete
    try {
      await client.session.abort({
        path: { id: sessionId },
        query: { directory: worktreePath }
      })
    } catch {
      // Ignore cleanup errors
    }
  }
}

// ── AI content generation ─────────────────────────────────────────

export async function generatePRContent(params: {
  worktreePath: string
  worktreeId: string
  baseBranch: string
  headBranch: string
}): Promise<{ title: string; body: string }> {
  const { worktreePath, worktreeId, baseBranch, headBranch } = params

  log.info('Generating PR content', { worktreePath, baseBranch, headBranch })

  const diffContext = await gatherDiffContext(worktreePath, baseBranch)
  const prompt = buildPrompt({
    baseBranch,
    headBranch,
    ...diffContext
  })

  const { sdk, model } = resolveAgentSdk(worktreeId)
  log.info('Resolved agent SDK for PR generation', { sdk, model })

  let rawResponse: string

  try {
    if (sdk === 'opencode') {
      rawResponse = await generateViaOpenCode(prompt, worktreePath)
    } else {
      rawResponse = await generateViaClaudeCode(prompt, worktreePath, model ?? 'sonnet')
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error('AI generation failed', error instanceof Error ? error : new Error(message), {
      sdk,
      worktreePath
    })
    throw new Error(`Failed to generate PR content via ${sdk}: ${message}`)
  }

  if (!rawResponse.trim()) {
    throw new Error('AI returned empty response')
  }

  log.info('AI response received', { length: rawResponse.length })

  try {
    return parseAIResponse(rawResponse)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error('Failed to parse AI response', error instanceof Error ? error : new Error(message), {
      responsePreview: rawResponse.slice(0, 200)
    })
    throw new Error(`Failed to parse AI response: ${message}`)
  }
}

// ── PR creation via gh CLI ────────────────────────────────────────

export async function createPR(params: {
  worktreePath: string
  worktreeId: string
  title: string
  body: string
  baseBranch: string
}): Promise<{ success: boolean; prNumber?: number; prUrl?: string; error?: string }> {
  const { worktreePath, worktreeId, baseBranch } = params
  let { title, body } = params

  const gitService = createGitService(worktreePath)

  try {
    // If title or body empty, generate via AI
    if (!title.trim() || !body.trim()) {
      log.info('Title or body empty, generating via AI')
      const branchName = await gitService.getCurrentBranch()
      const generated = await generatePRContent({
        worktreePath,
        worktreeId,
        baseBranch,
        headBranch: branchName
      })
      if (!title.trim()) title = generated.title
      if (!body.trim()) body = generated.body
    }

    const branchName = await gitService.getCurrentBranch()
    const ghEnv = { ...process.env, GH_PROMPT_DISABLED: '1' }

    // Check for existing PR on this branch
    try {
      const { stdout: existingPRs } = await execFileAsync(
        'gh',
        [
          'pr', 'list',
          '--head', branchName,
          '--state', 'open',
          '--json', 'number,url',
          '--limit', '1'
        ],
        { cwd: worktreePath, env: ghEnv }
      )

      const parsed = JSON.parse(existingPRs)
      if (Array.isArray(parsed) && parsed.length > 0) {
        const existing = parsed[0]
        return {
          success: false,
          prNumber: existing.number,
          prUrl: existing.url,
          error: `A pull request already exists for branch "${branchName}": ${existing.url}`
        }
      }
    } catch (error) {
      log.warn('Failed to check existing PRs, proceeding with creation', {
        error: error instanceof Error ? error.message : String(error)
      })
    }

    // Check if push is needed
    const branchInfo = await gitService.getBranchInfo()
    if (branchInfo.success && branchInfo.branch) {
      const needsPush = !branchInfo.branch.tracking || branchInfo.branch.ahead > 0
      if (needsPush) {
        log.info('Pushing branch to remote', { branchName })
        const pushResult = await gitService.push('origin', branchName)
        if (!pushResult.success) {
          return {
            success: false,
            error: `Failed to push branch: ${pushResult.error}`
          }
        }
      }
    }

    // Write body to temp file to avoid shell escaping issues
    const tmpFile = join(tmpdir(), `hive-pr-body-${process.pid}-${randomUUID()}.md`)
    try {
      writeFileSync(tmpFile, body, 'utf-8')

      // Create PR via gh CLI
      const { stdout } = await execFileAsync(
        'gh',
        [
          'pr', 'create',
          '--base', baseBranch,
          '--title', title,
          '--body-file', tmpFile
        ],
        { cwd: worktreePath, env: ghEnv }
      )

      // Parse PR URL from stdout
      const urlMatch = stdout.match(/https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/)
      if (urlMatch) {
        const prNumber = parseInt(urlMatch[1], 10)
        const prUrl = urlMatch[0]
        log.info('PR created successfully', { prNumber, prUrl })
        return { success: true, prNumber, prUrl }
      }

      // gh may return just a URL on stdout
      const trimmedUrl = stdout.trim()
      log.info('PR created, raw output', { stdout: trimmedUrl })
      return { success: true, prUrl: trimmedUrl }
    } finally {
      // Clean up temp file
      try {
        unlinkSync(tmpFile)
      } catch {
        // Ignore cleanup errors
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error('Failed to create PR', error instanceof Error ? error : new Error(message), {
      worktreePath,
      baseBranch
    })
    return { success: false, error: message }
  }
}
