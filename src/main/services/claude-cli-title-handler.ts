import type { BrowserWindow } from 'electron'
import type { DatabaseService } from '../db/database'
import { autoRenameWorktreeBranch } from './git-service'
import { createLogger } from './logger'

const log = createLogger({ component: 'ClaudeCliTitle' })

// Matches OSC 0 or OSC 2 with BEL or ST terminator.
// Body excludes BEL (\x07) and ESC (\x1b) so partial sequences stay unmatched.
const OSC_TITLE_RE = /\x1b\][02];([^\x07\x1b]*)(?:\x07|\x1b\\)/g

// Tail buffer cap — a partial OSC sequence should never exceed this in practice.
// Anything larger means we lost a terminator; drop the buffer to avoid unbounded growth.
const MAX_TAIL_LENGTH = 4096

// Non-braille spinner / status glyphs claude-cli (and friends) may prefix titles with.
const NON_BRAILLE_SPINNERS = new Set(['✻', '✶', '✳', '✺', '·', '⏺', '◐', '◓', '◑', '◒'])

function isSpinnerGlyph(ch: string): boolean {
  if (!ch) return false
  const code = ch.codePointAt(0)
  if (code === undefined) return false
  // Full Braille Patterns block — claude-cli cycles through these.
  if (code >= 0x2800 && code <= 0x28ff) return true
  return NON_BRAILLE_SPINNERS.has(ch)
}

function stripSpinnerPrefix(title: string): string {
  let i = 0
  while (i < title.length) {
    const ch = title[i]
    if (ch === ' ' || ch === '\t' || isSpinnerGlyph(ch)) {
      i += 1
    } else {
      break
    }
  }
  return title.slice(i)
}

// Boilerplate titles claude-cli emits before the meaningful one (case-insensitive,
// compared after the spinner prefix is stripped).
const BOILERPLATE_TITLES = new Set(['claude', 'claude code'])

const tailBuffers = new Map<string, string>()
const appliedSessions = new Set<string>()

interface ProcessOptions {
  worktreeBasename?: string
}

type TitleVerdict =
  | { kind: 'accepted'; cleaned: string }
  | { kind: 'noise'; reason: string }

function classifyTitle(raw: string, options: ProcessOptions): TitleVerdict {
  const cleaned = stripSpinnerPrefix(raw).trim()
  if (!cleaned) return { kind: 'noise', reason: 'empty' }
  if (BOILERPLATE_TITLES.has(cleaned.toLowerCase()))
    return { kind: 'noise', reason: 'boilerplate' }
  if (cleaned.startsWith('/') || cleaned.startsWith('~'))
    return { kind: 'noise', reason: 'absolute-path' }
  if (options.worktreeBasename && cleaned === options.worktreeBasename)
    return { kind: 'noise', reason: 'worktree-basename' }
  return { kind: 'accepted', cleaned }
}

/**
 * Scan a PTY chunk for the first acceptable OSC 0/2 title.
 * Returns the title string on a hit (and marks the session as applied so
 * subsequent chunks short-circuit). Returns null when no title is found, or
 * when the session has already had a title applied.
 *
 * Maintains a per-session tail buffer so that an OSC sequence split across
 * two chunks is still matched on the second chunk.
 */
export function processClaudeCliPtyData(
  sessionId: string,
  chunk: string,
  options: ProcessOptions = {}
): string | null {
  if (appliedSessions.has(sessionId)) return null

  const prev = tailBuffers.get(sessionId) ?? ''
  const buffer = prev + chunk

  let foundTitle: string | null = null
  let lastConsumedIndex = 0
  OSC_TITLE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = OSC_TITLE_RE.exec(buffer)) !== null) {
    lastConsumedIndex = OSC_TITLE_RE.lastIndex
    const verdict = classifyTitle(m[1], options)
    if (verdict.kind === 'accepted') {
      foundTitle = verdict.cleaned
      break
    }
  }

  // Preserve any partial OSC suffix after the last consumed match for the next chunk.
  const remainder = buffer.slice(lastConsumedIndex)
  const lastEsc = remainder.lastIndexOf('\x1b]')
  let newTail = ''
  if (lastEsc !== -1) {
    const suffix = remainder.slice(lastEsc)
    if (!suffix.includes('\x07') && !suffix.includes('\x1b\\')) {
      newTail = suffix
    }
  }
  if (newTail.length > MAX_TAIL_LENGTH) newTail = ''
  if (newTail) {
    tailBuffers.set(sessionId, newTail)
  } else {
    tailBuffers.delete(sessionId)
  }

  if (foundTitle !== null) {
    appliedSessions.add(sessionId)
    tailBuffers.delete(sessionId)
    return foundTitle
  }
  return null
}

export function resetClaudeCliTitleState(sessionId: string): void {
  tailBuffers.delete(sessionId)
  appliedSessions.delete(sessionId)
}

export function resetAllClaudeCliTitleState(): void {
  tailBuffers.clear()
  appliedSessions.clear()
}

export interface ApplyClaudeCliTitleParams {
  sessionId: string
  title: string
  db: DatabaseService
  mainWindow: BrowserWindow
}

/**
 * Mirrors the post-title-generation flow in claude-code-implementer.ts /
 * codex-implementer.ts: write the title to the DB, push an opencode:stream
 * session.updated event to the renderer, then auto-rename the worktree
 * branch (and any connection-member branches) when still eligible.
 *
 * Fire-and-forget — errors are logged and swallowed.
 */
export async function applyClaudeCliTitle({
  sessionId,
  title,
  db,
  mainWindow
}: ApplyClaudeCliTitleParams): Promise<void> {
  try {
    const session = db.getSession(sessionId)
    if (!session || session.agent_sdk !== 'claude-code-cli') return

    db.updateSession(sessionId, { name: title })
    log.info('applied claude-cli title', { sessionId, title })

    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('opencode:stream', {
        type: 'session.updated',
        sessionId,
        data: { title, info: { title } }
      })
    }

    const worktree = db.getWorktreeBySessionId(sessionId)
    if (worktree && !worktree.branch_renamed) {
      try {
        const result = await autoRenameWorktreeBranch({
          worktreeId: worktree.id,
          worktreePath: worktree.path,
          currentBranchName: worktree.branch_name,
          sessionTitle: title,
          db
        })
        if (result.renamed && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('worktree:branchRenamed', {
            worktreeId: worktree.id,
            newBranch: result.newBranch
          })
        } else if (result.error) {
          log.warn('branch rename failed', { sessionId, error: result.error })
        }
      } catch (err) {
        db.updateWorktree(worktree.id, { branch_renamed: 1 })
        log.warn('branch rename threw', {
          sessionId,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    }

    if (!session.connection_id) return
    const connection = db.getConnection(session.connection_id)
    if (!connection) return

    for (const member of connection.members) {
      if (worktree && member.worktree_id === worktree.id) continue
      try {
        const memberWt = db.getWorktree(member.worktree_id)
        if (!memberWt || memberWt.branch_renamed) continue
        const result = await autoRenameWorktreeBranch({
          worktreeId: memberWt.id,
          worktreePath: memberWt.path,
          currentBranchName: memberWt.branch_name,
          sessionTitle: title,
          db
        })
        if (result.renamed && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('worktree:branchRenamed', {
            worktreeId: memberWt.id,
            newBranch: result.newBranch
          })
        }
      } catch (err) {
        log.warn('connection member branch rename threw', {
          worktreeId: member.worktree_id,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    }
  } catch (err) {
    log.warn('applyClaudeCliTitle unexpected error', {
      sessionId,
      error: err instanceof Error ? err.message : String(err)
    })
  }
}
