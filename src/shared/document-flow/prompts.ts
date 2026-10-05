import type { DocumentRunVerdict } from '../types/document-flow'

// Everything the orchestrator says to an agent after the ticket text itself. The ticket's
// description (written at extraction, editable in the preview) says WHAT to build; these say
// how to behave inside a run: stay in scope, commit, never touch the base branch, and end with
// a status footer the classifier can lean on.

interface TicketRef {
  key: string
  title: string
}

const listTickets = (tickets: readonly TicketRef[]): string =>
  tickets.map((ticket) => `${ticket.key} (${ticket.title})`).join(', ')

/** The footer every ticket session is asked to end its final message with. */
export const STATUS_FOOTER_INSTRUCTIONS = `End your final message with exactly this block:

STATUS: DONE | NEEDS_INPUT | BLOCKED
SUMMARY: what you implemented, in one or two sentences
MIGRATIONS: migration files you added, or "none"
MANUAL STEPS: anything a human must do after this is merged (run migrations, set env vars, data fixes), or "none"
ASSUMPTIONS: decisions you made where the spec was silent, or "none"
QUESTIONS: what you need answered, or "none"

Use DONE only when the task is fully implemented and committed. Use NEEDS_INPUT when you are waiting for an answer, and BLOCKED when something outside your control stops you.`

export interface LaunchFooterInput {
  key: string
  title: string
  documentTitle: string
  integrationBranch: string
  baseBranch: string
  /** Other tickets of the run, built on their own branches. */
  siblings: readonly TicketRef[]
  /** Dependencies already merged into the integration branch this ticket starts from. */
  mergedDependencies: readonly TicketRef[]
  interactive: boolean
  hasMigration: boolean
}

/**
 * Appended to the ticket prompt at launch. Generalises the manual brief ("use subagents to
 * research the spec … ask me if anything is unclear … then implement") and adds what an
 * unattended, later-merged run needs.
 */
export function buildLaunchFooter(input: LaunchFooterInput): string {
  const lines: string[] = [
    '',
    '',
    '---',
    `You are implementing task ${input.key} of the document "${input.documentTitle}" as part of an automated run. Your branch was cut from \`${input.integrationBranch}\`, and will be merged back into it when you are done.`,
    '',
    '## How to work',
    '- Use subagents to read the spec section and its mock-ups, explore the code it touches, and research best practices before you write code.'
  ]

  lines.push(
    input.interactive
      ? '- If a requirement is unclear and a wrong guess would be costly, ask with the AskUserQuestion tool. Otherwise decide, and record the decision under ASSUMPTIONS.'
      : '- Nobody is watching this run. Do not stop to ask questions: settle them from the spec, choose the most reasonable reading, and record the decision under ASSUMPTIONS. Ask only if a wrong guess would be destructive.'
  )
  lines.push(
    '- Then implement the task completely, and run the checks this repository uses (typecheck, lint, the tests you touched).',
    '- If dependencies are not installed yet, a setup script may still be running in this worktree: wait for it or install them yourself.',
    '',
    '## Scope'
  )
  lines.push(
    `- Implement only ${input.key}. Keep the diff narrow: no drive-by refactors or reformatting.`
  )
  if (input.siblings.length > 0) {
    lines.push(
      `- Other tasks of this document are built in parallel on their own branches and merged with yours: ${listTickets(input.siblings)}. Do not implement them. Where your task needs something one of them delivers, build against a minimal seam and say so under ASSUMPTIONS.`
    )
  }
  if (input.mergedDependencies.length > 0) {
    lines.push(
      `- Already on your branch (merged before you started): ${listTickets(input.mergedDependencies)}. Build on that work rather than re-implementing it.`
    )
  }
  lines.push(
    input.hasMigration
      ? "- Schema or data changes: add a NEW migration following this repository's convention. Never edit an existing migration, and never run migrations against any database — list them under MIGRATIONS."
      : "- If you find you need a schema or data change, add a NEW migration following this repository's convention, never run it against any database, and list it under MIGRATIONS."
  )
  lines.push(
    '',
    '## When you are done',
    '- Commit all of your work on this branch (several commits are fine). Uncommitted work is not merged.',
    `- Do not push. Do not switch branches. Never commit to, merge into, or otherwise change \`${input.baseBranch}\`.`,
    '',
    STATUS_FOOTER_INSTRUCTIONS
  )
  return lines.join('\n')
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
