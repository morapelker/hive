import type { HandoffAgentSdk } from '../types/agent-sdk'
import type { DocumentRunPromptStyle, DocumentRunVerdict } from '../types/document-flow'

// Everything the orchestrator says to an agent. The launch prompt is deliberately the short
// brief a person would type: which task, of which document, research it, ask through the
// question tool, implement. What to change and where is the implementing model's call. The
// follow-ups say how to behave inside a run: resolve a conflict, fix a failing check, finish.

interface TicketRef {
  key: string
  title: string
}

const listTickets = (tickets: readonly TicketRef[]): string =>
  tickets.map((ticket) => `${ticket.key} (${ticket.title})`).join(', ')

/**
 * The block the follow-up prompts ask a session to end its final message with. Questions are
 * not part of it: an agent that needs an answer asks through its question tool, which the
 * runner sees as a waiting session. (The footer parser still reads the older block, which had
 * NEEDS_INPUT and a QUESTIONS line.)
 */
export const STATUS_FOOTER_INSTRUCTIONS = `If you need an answer from me, ask through your question tool rather than in the text of your message.

End your final message with exactly this block:

STATUS: DONE | BLOCKED
SUMMARY: what you implemented, in one or two sentences
MIGRATIONS: migration files you added, or "none"
MANUAL STEPS: anything a human must do after this is merged (run migrations, set env vars, data fixes), or "none"
ASSUMPTIONS: decisions you made where the spec was silent, or "none"

Use DONE only when the task is fully implemented and committed, and BLOCKED when something outside your control stops you.`

/**
 * `file://` URL of an absolute path, the way a browser's address bar shows it: spaces and
 * non-ASCII are escaped, `(`, `)` and `/` are kept, and `?` / `#` (legal in file names, but
 * URL delimiters) are escaped too. Windows paths become `file:///C:/…`.
 */
export function toFileUrl(path: string): string {
  const slashed = path.replace(/\\/g, '/')
  const encoded = encodeURI(slashed).replace(/[?#]/g, encodeURIComponent)
  return `file://${encoded.startsWith('/') ? '' : '/'}${encoded}`
}

/** What each provider calls its ask-the-user tool (see agent-mode-prefixes.ts). */
function questionToolName(sdk: HandoffAgentSdk): string {
  switch (sdk) {
    case 'codex':
    case 'codex-cli':
      return 'request_user_input'
    case 'opencode':
      return 'question'
    default:
      return 'AskUserQuestion'
  }
}

export interface LaunchPromptInput {
  key: string
  title: string
  /** Absolute path of the document the user picked (not the pre-processed text copy). */
  sourcePath: string
  promptStyle: DocumentRunPromptStyle
  interactive: boolean
  sdk: HandoffAgentSdk
}

/**
 * The whole prompt of a ticket session. The wording is the user's own manual brief; the title
 * is there because some keys are made up at extraction and appear nowhere in the document.
 * `small` drops the subagent research paragraph, and an unattended run swaps the
 * clarifications paragraph for "decide yourself".
 */
export function buildLaunchPrompt(input: LaunchPromptInput): string {
  const title = input.title.replace(/\s+/g, ' ').trim()
  const paragraphs: string[] = [
    `implement task ${input.key}${title ? ` ("${title}")` : ''} from the ${toFileUrl(input.sourcePath)}`
  ]
  if (input.promptStyle === 'full') {
    paragraphs.push(
      'use subagents to research and read the spec attached there, read the description of it, understand the requirements, research best practices regarding it'
    )
  }
  paragraphs.push(
    input.interactive
      ? `if you have any clarifications you might need - use the ${questionToolName(input.sdk)} tool to ask me.`
      : 'do not stop to ask me for clarifications - decide yourself, and mention the decisions you made in your final message.',
    'then - implement this',
    'implement only this task, commit your work on this branch, do not push or switch branches, and do not run migrations against any database.'
  )
  return paragraphs.join('\n\n')
}

export interface ConflictPromptInput {
  integrationBranch: string
  /**
   * The integration branch's commit to merge in: its verified tip at the time of the check.
   * The branch itself may carry a merge that is still being verified (and may be rolled back).
   */
  integrationCommit: string | null
  conflictedFiles: readonly string[]
  /** Tickets merged into the integration branch since this ticket's branch was cut. */
  mergedTickets: readonly TicketRef[]
  attempt: number
}

/** Sent to the ticket's own session when its branch no longer merges cleanly. */
export function buildConflictPrompt(input: ConflictPromptInput): string {
  const files =
    input.conflictedFiles.length > 0
      ? input.conflictedFiles.map((file) => `- ${file}`).join('\n')
      : '- (run the merge to see them)'
  const merged =
    input.mergedTickets.length > 0
      ? `Merged into it so far: ${listTickets(input.mergedTickets)}.`
      : 'Other tasks were merged into it.'
  return [
    `Your work is ready to merge, but your branch conflicts with \`${input.integrationBranch}\`. ${merged}`,
    '',
    'Conflicting files:',
    files,
    '',
    'Resolve it on your branch:',
    input.integrationCommit
      ? `1. Run \`git merge ${input.integrationCommit}\` in this worktree (that is the current verified commit of \`${input.integrationBranch}\`; merge that commit, not the branch name, which may already carry an unverified change).`
      : `1. Run \`git merge ${input.integrationBranch}\` in this worktree.`,
    "2. Resolve every conflict so that BOTH sides keep working: your task and the tasks already merged. Do not drop either side's behaviour, and do not touch files that are not part of the conflict.",
    "3. Never hand-merge generated files (lockfiles, generated code, migration journals or snapshots): take the integration branch's version and regenerate yours on top with the repository's own command. A migration of yours whose number now collides must be regenerated or renumbered after the ones already merged.",
    "4. Run the repository's checks (typecheck, lint, the tests you touched) and fix what the merge broke.",
    '5. Commit the merge. Do not push, and do not change any other branch.',
    '',
    input.attempt > 1
      ? `This is attempt ${input.attempt}: the previous resolution still conflicted. Make sure the merge commit exists and that \`git status\` is clean.`
      : 'When `git status` is clean and the merge is committed, you are done.',
    '',
    'In the block below, describe your whole task as it now stands on this branch, not only the merge: its summary, its migrations, and the manual steps that still apply after the merge.',
    '',
    STATUS_FOOTER_INSTRUCTIONS
  ].join('\n')
}

export interface FixTicketInput {
  documentTitle: string
  key: string
  title: string
  integrationBranch: string
  verifyCommand: string
  /** Tail of the failing command's output. */
  verifyOutput: string
  attempt: number
}

/**
 * The ticket for a fix session in the integration worktree: the merge was textually clean,
 * but the verify command fails on the merged result.
 */
export function buildFixTicket(input: FixTicketInput): { title: string; description: string } {
  // The launcher writes the title into `<ticket title="…">` unescaped.
  const title = `Fix checks after merging ${input.key} (${input.documentTitle})`
    .replace(/["<>\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  // Command output may itself contain a code fence; a longer one keeps ours closed.
  const fence = /```/.test(`${input.verifyCommand}\n${input.verifyOutput}`) ? '`````' : '```'
  const description = [
    `Task ${input.key} (${input.title}) was just merged into \`${input.integrationBranch}\`, the branch checked out in this worktree. The merge was clean, but the verification command now fails.`,
    '',
    'Command:',
    fence,
    input.verifyCommand,
    fence,
    '',
    'Output (tail):',
    fence,
    input.verifyOutput.trim() || '(no output)',
    fence,
    '',
    '## What to do',
    '- Find what the merge broke. It is usually an interaction between this task and one merged earlier (a renamed symbol, a changed signature, duplicate or misnumbered migrations, a stale generated file), not a flaw in either alone.',
    "- Fix it here with the smallest change that keeps every merged task working. Regenerate generated files with the repository's own commands instead of editing them by hand.",
    '- Re-run the command above until it passes.',
    '- Commit the fix on this branch. Do not push, do not switch branches, and do not change any other branch.',
    '',
    ...(input.attempt > 1
      ? [`This is attempt ${input.attempt}; the previous fix did not make the command pass.`, '']
      : []),
    STATUS_FOOTER_INSTRUCTIONS
  ].join('\n')
  return { title, description }
}

/** Sent when the classifier judged the final message as only partly done. */
export function buildNudgePrompt(verdict: Pick<DocumentRunVerdict, 'reason'>): string {
  return [
    'Your last message reads as only partly done:',
    verdict.reason,
    '',
    'Continue until the task is fully implemented, the checks pass and everything is committed. If something genuinely stops you, say so instead of stopping silently.',
    '',
    STATUS_FOOTER_INSTRUCTIONS
  ].join('\n')
}

/** Sent to resume a turn that ended on an API error or was cut off by an app restart. */
export function buildContinuePrompt(reason: 'api_error' | 'interrupted'): string {
  const lead =
    reason === 'api_error'
      ? 'Your last turn ended on an API error.'
      : 'Your last turn was interrupted before it finished.'
  return [
    `${lead} Continue where you left off: check \`git status\` and your earlier progress first, then finish the task and commit.`,
    '',
    STATUS_FOOTER_INSTRUCTIONS
  ].join('\n')
}
