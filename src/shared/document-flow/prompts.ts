import type { ClaudeCliPendingWork } from '../types/claude-cli-stop-completion'
import type { HandoffAgentSdk } from '../types/agent-sdk'
import {
  DOCUMENT_VERIFICATION_METHODS,
  type DocumentRunMember,
  type DocumentRunPromptStyle,
  type DocumentRunVerdict,
  type DocumentVerificationMethod
} from '../types/document-flow'

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

// ── Connection projects ────────────────────────────────────────────────────

/** A member repository of a connection directory, as the prompts name it. */
export interface ConnectionWorkspaceMember {
  /** Directory name of the member inside the connection directory (`web`). */
  symlinkName: string
  projectName: string
}

/** The members of a run as the prompts name them. */
export function workspaceOfMembers(
  members: readonly Pick<DocumentRunMember, 'symlink_name' | 'project_name'>[]
): ConnectionWorkspaceMember[] {
  return members.map((member) => ({
    symlinkName: member.symlink_name,
    projectName: member.project_name
  }))
}

const listMembers = (members: readonly ConnectionWorkspaceMember[]): string =>
  members.map((member) => `\`${member.symlinkName}/\` is ${member.projectName}`).join(', ')

const CONNECTION_WORKSPACE_LEAD = 'this task runs in a connection directory: '

/**
 * Told to every session of a run on a connection project. The connection directory's own
 * AGENTS.md asks agents not to commit or run git unless told to; the run tells them to.
 */
export function connectionWorkspaceParagraph(
  members: readonly ConnectionWorkspaceMember[]
): string {
  return `${CONNECTION_WORKSPACE_LEAD}each member repository is a subdirectory of it (${listMembers(members)}). work inside those repositories, never at the top level of the connection directory, and commit in every repository you changed - that overrides the note in this directory's AGENTS.md about not committing or running git on your own. a repository you did not change stays untouched.`
}

const isConnectionWorkspaceParagraph = (paragraph: string): boolean =>
  paragraph.startsWith(CONNECTION_WORKSPACE_LEAD)

/**
 * The block the follow-up prompts ask a session to end its final message with. Questions are
 * not part of it: an agent that needs an answer asks through its question tool, which the
 * runner sees as a waiting session. (The footer parser still reads the older block, which had
 * NEEDS_INPUT and a QUESTIONS line.)
 */
const STATUS_FOOTER_ASK =
  'If you need an answer from me, ask through your question tool rather than in the text of your message.'

/** The same rule the unattended launch prompt gives, for the follow-ups of a run that may not ask. */
const STATUS_FOOTER_DO_NOT_ASK =
  'Do not ask me anything - I am not next to the computer to answer. Where you need a clarification, pick the recommended approach; if a decision is too pivotal to make on your own, skip that part, leave it as a gap and list it under ASSUMPTIONS.'

const STATUS_FOOTER_BLOCK = `End your final message with exactly this block:

STATUS: DONE | WAITING | BLOCKED
SUMMARY: what you implemented, in one or two sentences
MIGRATIONS: migration files you added, or "none"
MANUAL STEPS: anything a human must do after this is merged (run migrations, set env vars, data fixes), or "none"
ASSUMPTIONS: decisions you made where the spec was silent, or "none"

Use DONE only when the task is fully implemented and committed and every monitor you started is stopped, WAITING only when you have stopped to wait for checks or builds you started in the background and will be woken when they finish (say what you wait for in SUMMARY), and BLOCKED when something outside your control stops you. Commit on this branch without waiting for my go-ahead. What you may not do here (push, deploy, run migrations, check against a live system) goes under MANUAL STEPS and does not make the task BLOCKED.`

/** The footer for the run's current "agents may ask" setting, which can change mid-run. */
export function statusFooterInstructions(interactive: boolean): string {
  return `${interactive ? STATUS_FOOTER_ASK : STATUS_FOOTER_DO_NOT_ASK}\n\n${STATUS_FOOTER_BLOCK}`
}

export const STATUS_FOOTER_INSTRUCTIONS = statusFooterInstructions(true)

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
export function questionToolName(sdk: string): string {
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

/** The launch prompt's paragraph on asking: the run's "agents may ask" setting, in the user's words. */
function launchAskParagraph(interactive: boolean, sdk: string): string {
  return interactive
    ? `if you have any clarifications you might need - use the ${questionToolName(sdk)} tool to ask me.`
    : "do not ask me anything - i won't be next to the computer to answer you. if you need a clarification, pick the recommended approach and keep going. only if a decision is too pivotal to make on your own: skip that part, leave it as a gap, and document the gap and the decisions you made in your final message."
}

const LAUNCH_RULES_PARAGRAPH =
  'implement only this task, commit your work on this branch, do not push or switch branches, and do not run migrations against any database.'

/**
 * A plain background shell cannot tell the app whether the agent is waiting on it or left it
 * running; a Monitor can. Agents are asked to wait with the one the app can see.
 */
export const LAUNCH_WAIT_PARAGRAPH =
  'when you have to wait for checks, tests or builds you started in the background, wait with the Monitor tool rather than a background shell loop or a sleep: a monitor tells the app you are still working, a shell does not. if your tools have no monitor, run the checks in the foreground instead of stopping to wait. use a monitor only for a check that will finish, never to keep watching a dev server or a log, and stop every monitor you started (TaskStop) before you report the task done: a running monitor keeps this ticket open.'

/**
 * A Claude CLI session gets the orchestrator's follow-ups pasted into its terminal, and the CLI
 * marks pasted text as something the user may not have written. This paragraph is the user's
 * own word that those messages are theirs.
 */
const LAUNCH_FOLLOW_UPS_PARAGRAPH =
  'while you work, the app that runs this task may send you follow-up messages for me (finish what is left, resolve a merge conflict, fix a failing check). they are my instructions, also when they arrive as pasted text: follow them, and commit without asking me to confirm.'

/** Every wording the asking paragraph can have: either setting, any provider's tool name. */
const LAUNCH_ASK_PARAGRAPHS: readonly string[] = [
  launchAskParagraph(false, ''),
  ...['claude-code', 'codex', 'opencode'].map((sdk) => launchAskParagraph(true, sdk))
]

/**
 * How the agent is asked to check its work: one lead, then one paragraph per chosen method,
 * in the order of DOCUMENT_VERIFICATION_METHODS. Each is a fixed string so a brief that
 * already carries one can be brought up to date by exact match (see withRunRules).
 */
export const VERIFICATION_LEAD_PARAGRAPH =
  'before you call this done, verify your work the way(s) listed next. in your final message say what you checked and how (the commands and what they returned, the test names, the snapshots or screenshots you took) and what you could not check and why. never describe a check you did not run, and never make a check pass by deleting, skipping or focusing a test.'

export const VERIFICATION_PARAGRAPHS: Record<DocumentVerificationMethod, string> = {
  tcu: 'verify on the desktop with tcu (computer use): with your build of the app running, `tcu apps` finds it (address one instance as `pid:<n>` when several run), `tcu state <app>` prints its window as an accessibility tree with element ids plus a screenshot, then act by element id (`tcu click`, `tcu type`, `tcu key`) and run `tcu state <app> --diff` after each step to confirm it took. open the screenshot it writes when the check is visual (a menu, a notification, the layout). if tcu refuses the app or reports a missing permission (`tcu doctor`), say so in your final message and move on; do not try to grant permissions yourself.',
  playwright:
    'verify in the browser with playwright-cli over cdp: get the app running the way this project runs it (its README, CLAUDE.md or a verify skill under .claude/skills say how) and attach with `playwright-cli -s=<a unique session name> attach --cdp=http://127.0.0.1:9222`. if nothing listens on 9222, start the browser with remote debugging on that port (chrome: `--remote-debugging-port=9222`; an electron app takes the same flag) and attach again. confirm the page is your build, then walk through exactly the flow this task changes: snapshot, click, fill, read the result from the next snapshot, and take a screenshot when the change is visual. detach and stop what you started when you are done.',
  tests:
    "verify with tests: add or update unit, integration or end-to-end tests that cover what you changed, in the project's own test style and next to the code, run those first, then the project's test suite for the areas you touched. a failure you did not cause goes in your final message, not fixed here."
}

/** Every verification paragraph there is: what withRunRules strips before it writes the current choice. */
const VERIFICATION_ALL_PARAGRAPHS: readonly string[] = [
  VERIFICATION_LEAD_PARAGRAPH,
  ...DOCUMENT_VERIFICATION_METHODS.map((method) => VERIFICATION_PARAGRAPHS[method])
]

/** The paragraphs for a choice of methods: nothing when there is none. */
export function verificationParagraphs(
  methods: readonly DocumentVerificationMethod[] | null | undefined
): string[] {
  const chosen = DOCUMENT_VERIFICATION_METHODS.filter((method) => methods?.includes(method))
  if (chosen.length === 0) return []
  return [VERIFICATION_LEAD_PARAGRAPH, ...chosen.map((method) => VERIFICATION_PARAGRAPHS[method])]
}

export interface LaunchPromptInput {
  key: string
  title: string
  /** Absolute path of the document the user picked (not the pre-processed text copy). */
  sourcePath: string
  promptStyle: DocumentRunPromptStyle
  interactive: boolean
  sdk: HandoffAgentSdk
  /** How the agent is asked to verify its work; empty or missing = the brief says nothing. */
  verification?: readonly DocumentVerificationMethod[] | null
  /** Connection projects: the members of the connection directory the session runs in. */
  workspace?: readonly ConnectionWorkspaceMember[] | null
}

/**
 * The whole prompt of a ticket session. The wording is the user's own manual brief; the title
 * is there because some keys are made up at extraction and appear nowhere in the document.
 * `small` drops the subagent research paragraph, and an unattended run swaps the
 * clarifications paragraph for "do not ask: pick the recommended approach, or leave a gap".
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
  if (input.workspace && input.workspace.length > 0) {
    paragraphs.push(connectionWorkspaceParagraph(input.workspace))
  }
  paragraphs.push(
    launchAskParagraph(input.interactive, input.sdk),
    'then - implement this',
    ...verificationParagraphs(input.verification),
    LAUNCH_WAIT_PARAGRAPH,
    LAUNCH_RULES_PARAGRAPH,
    LAUNCH_FOLLOW_UPS_PARAGRAPH
  )
  return paragraphs.join('\n\n')
}

/**
 * The brief as a session is launched with it. A ticket's description was written when the run
 * started and may have been edited on the board since, so the rules of the run are settled
 * here: the asking paragraph follows the setting as it is now (it can be flipped while the
 * ticket waits its turn), the verification paragraphs are those of the choice as it is now
 * (the ticket's methods, or none while the run skips verification), and the commit and
 * follow-up paragraphs are there whatever the description says.
 */
export function withRunRules(
  brief: string,
  input: Pick<LaunchPromptInput, 'interactive' | 'sdk' | 'verification' | 'workspace'>
): string {
  const ask = launchAskParagraph(input.interactive, input.sdk)
  let text = brief.trim()
  // The connection paragraph names the members as they are now; an older wording goes.
  const workspace =
    input.workspace && input.workspace.length > 0
      ? connectionWorkspaceParagraph(input.workspace)
      : null
  const stripped = text
    .split('\n\n')
    .filter((paragraph) => !isConnectionWorkspaceParagraph(paragraph.trim()))
  if (stripped.length > 0) text = stripped.join('\n\n')
  for (const stale of LAUNCH_ASK_PARAGRAPHS) {
    if (stale === ask || !text.includes(stale)) continue
    text = text.replace(stale, text.includes(ask) ? '' : ask)
  }
  for (const stale of VERIFICATION_ALL_PARAGRAPHS) {
    if (text.includes(stale)) text = text.split(stale).join('')
  }
  text = text.replace(/\n{3,}/g, '\n\n').trim()
  const verification = verificationParagraphs(input.verification)
  if (verification.length > 0) {
    const block = verification.join('\n\n')
    // Before the wait and commit rules, where buildLaunchPrompt puts it; after the brief otherwise.
    const anchor = [LAUNCH_WAIT_PARAGRAPH, LAUNCH_RULES_PARAGRAPH].find((paragraph) =>
      text.includes(paragraph)
    )
    text = anchor
      ? text.replace(anchor, `${block}\n\n${anchor}`)
      : [text, block].filter(Boolean).join('\n\n')
  }
  // The connection paragraph goes where buildLaunchPrompt puts it: before the asking paragraph.
  if (workspace && !text.includes(workspace)) {
    text = text.includes(ask)
      ? text.replace(ask, `${workspace}\n\n${ask}`)
      : [text, workspace].filter(Boolean).join('\n\n')
  }
  const missing = [
    ask,
    LAUNCH_WAIT_PARAGRAPH,
    LAUNCH_RULES_PARAGRAPH,
    LAUNCH_FOLLOW_UPS_PARAGRAPH
  ].filter((paragraph) => !text.includes(paragraph))
  return [text, ...missing].filter(Boolean).join('\n\n')
}

export interface MigrationPromptInput {
  documentTitle: string
  integrationBranch: string
  /** The report's list: migration file paths, and what the agents said they added. */
  migrations: readonly string[]
  /** The session's own SDK, which names its question tool. */
  sdk: string
  /** Connection projects: the session runs in the integration connection directory. */
  workspace?: readonly ConnectionWorkspaceMember[] | null
}

/**
 * The whole prompt of the session that executes a finished run's migrations, started from the
 * run's report in the integration worktree. The list is what the branch says; what production
 * already has is for the agent to find out, so a migration is never run twice.
 */
export function buildMigrationPrompt(input: MigrationPromptInput): string {
  const title = input.documentTitle.replace(/\s+/g, ' ').trim()
  const migrations = input.migrations.map((entry) => entry.replace(/\s+/g, ' ').trim())
  const workspace = input.workspace && input.workspace.length > 0 ? input.workspace : null
  return [
    workspace
      ? `execute the migrations of the integration branches (${input.integrationBranch}) against production. this is a connection directory: each member repository is a subdirectory of it (${listMembers(workspace)}), and each one has the branch checked out; a migration path starts with the member's directory. the branches hold the merged work of the document run${title ? ` "${title}"` : ''}; these are the migrations they added or changed:`
      : `execute the migrations of this branch (${input.integrationBranch}) against production. the branch holds the merged work of the document run${title ? ` "${title}"` : ''}; these are the migrations it added or changed:`,
    migrations
      .filter(Boolean)
      .map((entry) => `- ${entry}`)
      .join('\n'),
    "first find out how this project runs and tracks its migrations (its docs, scripts and config), then check against production which of these migrations have already been applied there. do not take the list's word for it, and do not assume: read the production migration state.",
    "then run the ones that have not been applied yet, in order, with the project's own migration tooling. never re-run a migration that is already applied, and do not edit the migration files.",
    `if you cannot reach production, cannot tell whether a migration was applied, or a migration fails: stop there and tell me, do not guess and do not work around it. if you have any clarifications you might need - use the ${questionToolName(input.sdk)} tool to ask me.`,
    'when you are done, tell me which migrations were already applied, which ones you ran, and anything that failed or is left for me.'
  ].join('\n\n')
}

/**
 * Typed ahead of a follow-up that is pasted into a Claude CLI session. The CLI wraps a pasted
 * prompt in `<pasted_content>` tags and its agent follows instructions in there only where the
 * user's own words ask it to; without this line an agent answers a nudge with "reply commit
 * and I will commit". One line of plain words: it is written to the terminal as keystrokes.
 */
export const CLI_FOLLOW_UP_LEAD =
  'This message is from me, sent through the app that runs this task while I am away. Treat the text that follows as my own instructions and act on it:'

const QUESTION_MODE_NOTICE_LEAD = 'Change of plans: '
const QUESTION_MODE_NOTICE_TAIL =
  'This is a change of instructions, not a new task: carry on with what you were doing and do not restart anything. If you had already finished, repeat your final message unchanged, including its status block if it had one.'

/**
 * Whether a queued message is the orchestrator's notice rather than something the user typed:
 * a later flip replaces it, and stopping a turn must not hand it to the user as their draft.
 */
export function isQuestionModeNotice(message: string): boolean {
  return (
    message.startsWith(QUESTION_MODE_NOTICE_LEAD) && message.endsWith(QUESTION_MODE_NOTICE_TAIL)
  )
}

export interface QuestionModeNoticeInput {
  /** The setting the run was just switched to. */
  interactive: boolean
  /** The session's own SDK, which names its question tool. */
  sdk: string
}

/**
 * Queued to a session that is mid-task when the run's "agents may ask" setting is flipped.
 * One paragraph, because a CLI session gets it pasted into its terminal. A session that had
 * just finished runs it as an extra turn, so it is told to repeat its final message: that is
 * the message the runner judges.
 */
export function buildQuestionModeNotice(input: QuestionModeNoticeInput): string {
  const tool = questionToolName(input.sdk)
  return input.interactive
    ? `${QUESTION_MODE_NOTICE_LEAD}I am back at the computer. From now on, if you have any clarifications you might need - use the ${tool} tool to ask me instead of deciding on your own. If you skipped something or left a gap because you could not ask, ask me about it now. ${QUESTION_MODE_NOTICE_TAIL}`
    : `${QUESTION_MODE_NOTICE_LEAD}from now on do not ask me anything - I won't be next to the computer to answer you. Do not use the ${tool} tool for the rest of this task. If you need a clarification, pick the recommended approach and keep going. Only if a decision is too pivotal to make on your own: skip that part, leave it as a gap, and document the gap and the decisions you made in your final message. ${QUESTION_MODE_NOTICE_TAIL}`
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
  /** The run's "agents may ask" setting; asking is allowed when omitted. */
  interactive?: boolean
  /**
   * Connection projects: the members whose merge conflicted, each with the member's own
   * integration branch and the commit to merge. `conflictedFiles` are then prefixed with the
   * member directory, and the merge instruction is given per member.
   */
  members?: readonly ConflictPromptMember[] | null
}

export interface ConflictPromptMember {
  symlinkName: string
  projectName: string
  integrationBranch: string
  integrationCommit: string | null
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
  const members = input.members && input.members.length > 0 ? input.members : null
  const mergeStep = members
    ? [
        'This is a connection directory: each member repository is a subdirectory of it, and the conflict is in the repositories listed below. In each of them, run the merge inside that directory:',
        ...members.map(
          (member) =>
            `   - \`${member.symlinkName}/\` (${member.projectName}): ${
              member.integrationCommit
                ? `\`git merge ${member.integrationCommit}\` (the current verified commit of \`${member.integrationBranch}\`; merge that commit, not the branch name, which may already carry an unverified change)`
                : `\`git merge ${member.integrationBranch}\``
            }`
        )
      ].join('\n')
    : input.integrationCommit
      ? `Run \`git merge ${input.integrationCommit}\` in this worktree (that is the current verified commit of \`${input.integrationBranch}\`; merge that commit, not the branch name, which may already carry an unverified change).`
      : `Run \`git merge ${input.integrationBranch}\` in this worktree.`
  return [
    `Your work is ready to merge, but your branch conflicts with \`${input.integrationBranch}\`. ${merged}`,
    '',
    'Conflicting files:',
    files,
    '',
    'Resolve it on your branch:',
    `1. ${mergeStep}`,
    "2. Resolve every conflict so that BOTH sides keep working: your task and the tasks already merged. Do not drop either side's behaviour, and do not touch files that are not part of the conflict.",
    "3. Never hand-merge generated files (lockfiles, generated code, migration journals or snapshots): take the integration branch's version and regenerate yours on top with the repository's own command. A migration of yours whose number now collides must be regenerated or renumbered after the ones already merged.",
    "4. Run the repository's checks (typecheck, lint, the tests you touched) and fix what the merge broke.",
    members
      ? '5. Commit the merge in every repository you merged. Do not push, and do not change any other branch.'
      : '5. Commit the merge. Do not push, and do not change any other branch.',
    '',
    input.attempt > 1
      ? `This is attempt ${input.attempt}: the previous resolution still conflicted. Make sure the merge commit exists and that \`git status\` is clean${members ? ' in every member repository' : ''}.`
      : `When \`git status\` is clean${members ? ' in every member repository' : ''} and the merge is committed, you are done.`,
    '',
    'In the block below, describe your whole task as it now stands on this branch, not only the merge: its summary, its migrations, and the manual steps that still apply after the merge.',
    '',
    statusFooterInstructions(input.interactive ?? true)
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
  /** The run's "agents may ask" setting; asking is allowed when omitted. */
  interactive?: boolean
  /**
   * Connection projects: the session runs in the integration connection directory, and the
   * failing command ran in `failedMember`'s repository.
   */
  workspace?: readonly ConnectionWorkspaceMember[] | null
  failedMember?: ConnectionWorkspaceMember | null
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
  const workspace = input.workspace && input.workspace.length > 0 ? input.workspace : null
  const description = [
    workspace
      ? `Task ${input.key} (${input.title}) was just merged into \`${input.integrationBranch}\`, the branch checked out in every member repository of this connection directory (${listMembers(workspace)}). The merge was clean, but the verification command${input.failedMember ? ` of \`${input.failedMember.symlinkName}/\` (${input.failedMember.projectName}), run inside that directory,` : ''} now fails.`
      : `Task ${input.key} (${input.title}) was just merged into \`${input.integrationBranch}\`, the branch checked out in this worktree. The merge was clean, but the verification command now fails.`,
    '',
    workspace && input.failedMember
      ? `Command (run in \`${input.failedMember.symlinkName}/\`):`
      : 'Command:',
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
    workspace && input.failedMember
      ? `- Re-run the command above inside \`${input.failedMember.symlinkName}/\` until it passes.`
      : '- Re-run the command above until it passes.',
    workspace
      ? '- Commit the fix on this branch in every member repository you changed. Do not push, do not switch branches, and do not change any other branch.'
      : '- Commit the fix on this branch. Do not push, do not switch branches, and do not change any other branch.',
    '',
    ...(input.attempt > 1
      ? [`This is attempt ${input.attempt}; the previous fix did not make the command pass.`, '']
      : []),
    statusFooterInstructions(input.interactive ?? true)
  ].join('\n')
  return { title, description }
}

export type NudgeVerdict = Pick<DocumentRunVerdict, 'reason'> &
  Partial<Pick<DocumentRunVerdict, 'status' | 'question' | 'source'>> & {
    /**
     * What held the session's last pause open (monitors, wake-ups, agents). Set, the nudge is
     * the wrap-up question: is that work still needed, or should it be stopped?
     */
    pending?: ClaudeCliPendingWork
  }

/** One line per thing a paused session still has running, for the wrap-up prompt. */
export function describePendingWork(pending: ClaudeCliPendingWork): string[] {
  const lines = pending.monitors.map(
    (description) => `- a monitor${description ? `: ${description}` : ' (no description)'}`
  )
  if (pending.wakeups > 0) {
    lines.push(
      `- ${pending.wakeups === 1 ? 'a scheduled wake-up' : `${pending.wakeups} scheduled wake-ups`}`
    )
  }
  if (pending.agents > 0) {
    lines.push(
      `- ${pending.agents === 1 ? 'a subagent or workflow' : `${pending.agents} subagents or workflows`}`
    )
  }
  return lines
}

/**
 * What a paused session still has running, in a few words for a status line: `monitor "CI
 * checks"`, `2 monitors (CI checks; build)`, `a scheduled wake-up`, `a subagent or workflow`.
 */
export function summarizePendingWork(pending: ClaudeCliPendingWork): string {
  const parts: string[] = []
  const monitors = pending.monitors
  if (monitors.length === 1) {
    parts.push(monitors[0] ? `monitor "${monitors[0]}"` : 'a monitor')
  } else if (monitors.length > 1) {
    const named = monitors.filter(Boolean)
    parts.push(`${monitors.length} monitors${named.length > 0 ? ` (${named.join('; ')})` : ''}`)
  }
  if (pending.wakeups > 0) {
    parts.push(
      pending.wakeups === 1 ? 'a scheduled wake-up' : `${pending.wakeups} scheduled wake-ups`
    )
  }
  if (pending.agents > 0) {
    parts.push(
      pending.agents === 1 ? 'a subagent or workflow' : `${pending.agents} subagents or workflows`
    )
  }
  return parts.length > 0 ? parts.join(' and ') : 'background work'
}

/**
 * The wrap-up question for a session that paused with monitors or wake-ups still pending: the
 * agent itself is the best judge of whether its watch still matters, so it is asked — the
 * way the user would — and told to stop what it no longer needs.
 */
function wrapUpBrief(
  verdict: NudgeVerdict,
  pending: ClaudeCliPendingWork
): [lead: string, quote: string, ask: string] {
  const lead =
    verdict.status === 'done'
      ? 'Your last message reads as done, but background work you started is still running, and it keeps this ticket open:'
      : 'You stopped to wait, and background work you started is still running, which keeps this ticket open:'
  return [
    lead,
    describePendingWork(pending).join('\n'),
    'Do you still need it to finish this ticket? If a monitor waits on checks or builds whose result you need, keep it and say what it waits for. Otherwise stop every monitor you no longer need with TaskStop, cancel the wake-ups you no longer need, finish whatever is left and commit. Do not re-arm a monitor that has nothing left to wait for: a ticket whose monitors keep running never completes.'
  ]
}

/** What the nudge says of the last message, and what to do about it. */
function nudgeBrief(verdict: NudgeVerdict): [lead: string, quote: string, ask: string] {
  if (verdict.pending && (verdict.status === 'waiting' || verdict.status === 'done')) {
    return wrapUpBrief(verdict, verdict.pending)
  }
  // Judged without the classifier: only a closing question or a wait for the agent's own
  // background work says anything about the message.
  if (
    verdict.source === 'fallback' &&
    verdict.status !== 'needs_input' &&
    verdict.status !== 'waiting'
  ) {
    return [
      'I could not tell from your last message whether the task is finished.',
      '',
      'If it is not, continue until the task is fully implemented, the checks pass and everything is committed. If it is, say so.'
    ]
  }
  switch (verdict.status) {
    case 'needs_input':
      return [
        'Your last message waits for an answer or a go-ahead from me:',
        verdict.question?.trim() || verdict.reason,
        'Nobody will answer: I am not at the computer. Decide it yourself - take the approach you would recommend and note it under ASSUMPTIONS - then finish the task and commit. You do not need my go-ahead to commit on this branch.'
      ]
    case 'waiting':
      return [
        'Your last message said you were waiting for background work you started:',
        verdict.reason,
        'Nothing has come back since, so it may have finished quietly or died. Check on it now - read its output, or run the checks again in the foreground - then finish the task and commit. Do not stop to wait again unless you have started a Monitor that will wake you.'
      ]
    case 'blocked':
    case 'failed':
      return [
        'Your last message reads as stopped short of done:',
        verdict.reason,
        'Nobody is here to unblock it. Work around it where you can, finish everything that does not depend on it, leave the rest as a gap listed under MANUAL STEPS or ASSUMPTIONS, and commit. Report BLOCKED only if no part of the task can be done.'
      ]
    default:
      return [
        'Your last message reads as only partly done:',
        verdict.reason,
        'Continue until the task is fully implemented, the checks pass and everything is committed. If something genuinely stops you, say so instead of stopping silently.'
      ]
  }
}

/**
 * Sent when the final message does not read as done: only partly done, a wait for background
 * work that ran out, or, in a run whose agents may not ask, a question or a stop that nobody is
 * there to answer.
 */
export function buildNudgePrompt(verdict: NudgeVerdict, interactive = true): string {
  const [lead, quote, ask] = nudgeBrief(verdict)
  return [lead, ...(quote ? [quote] : []), '', ask, '', statusFooterInstructions(interactive)].join(
    '\n'
  )
}

/** Sent to resume a turn that ended on an API error or was cut off by an app restart. */
export function buildContinuePrompt(
  reason: 'api_error' | 'interrupted',
  interactive = true
): string {
  const lead =
    reason === 'api_error'
      ? 'Your last turn ended on an API error.'
      : 'Your last turn was interrupted before it finished.'
  return [
    `${lead} Continue where you left off: check \`git status\` and your earlier progress first, then finish the task and commit.`,
    '',
    statusFooterInstructions(interactive)
  ].join('\n')
}

// ── Updating the document ──────────────────────────────────────────────────
// Once a ticket is merged, its own session is asked to record in the document the run was made
// from (the user's own file, not the run's copy) what was done, how it was verified and what is
// left. One session edits the document at a time; the runner judges the edit by the file's hash
// and reads the DOCUMENT footer only for the words it shows.

export type DocumentUpdateFormat = 'html' | 'markdown' | 'text'

/** How each format is marked up: fixed strings, one per format the document can be. */
export const DOCUMENT_UPDATE_FORMAT_PARAGRAPHS: Record<DocumentUpdateFormat, string> = {
  markdown:
    'This is a Markdown file: strike through with `~~…~~`; tick a `- [ ]` checklist item as `- [x]`; write the notes block as a `> ` blockquote list right under the heading; link screenshots as `![what it shows](relative/path.png)`.',
  html: 'This is an HTML file: strike through with `<s>…</s>` (or `<del>` if the document uses it); put the status in the heading as a short `<span>` badge ("✅ DONE", "⚠️ PARTIAL") styled like the document\'s own badges; write the notes block as a `<div>` with a `<ul>` right after the heading, reusing the document\'s own classes; screenshots as `<img src="relative/path.png" alt="…">` sized to fit. Keep the file valid HTML; add no scripts or external stylesheets.',
  text: 'This is a plain-text file: it has no strikethrough, so prefix the title with `[✅ DONE]` or `[⚠️ PARTIAL]`, start item lines with ✅, ⚠️ or ❌, write the notes as indented lines under the title, and give screenshot paths as plain paths.'
}

/** The asking line of a document update in a run whose agents may not ask. */
const DOCUMENT_UPDATE_DO_NOT_ASK =
  'Do not ask me anything - I am not next to the computer to answer. If something is unclear, make the edit you would recommend and say so in NOTES.'

/** The block a document update ends with; `parseDocumentUpdateFooter` reads it. */
export const DOCUMENT_UPDATE_FOOTER_BLOCK = `End your final message with exactly this block:

DOCUMENT: UPDATED | UNCHANGED | FAILED
VERIFIED: one line — how the task was verified (methods and results), or "not verified"
FOLLOW-UPS: none, or a semicolon-separated list
NOTES: one sentence on what you changed in the document, or why you could not`

/** The asking line for the run's current setting, then the DOCUMENT footer. */
export function documentUpdateFooterInstructions(interactive: boolean): string {
  return `${interactive ? STATUS_FOOTER_ASK : DOCUMENT_UPDATE_DO_NOT_ASK}\n\n${DOCUMENT_UPDATE_FOOTER_BLOCK}`
}

/** One member repository's merge of the task, on a connection run. */
export interface DocumentUpdateMemberMerge {
  /** Directory name of the member inside the connection directory (`web`). */
  symlinkName: string
  /** The member's merge commit; null when that member had nothing new to merge. */
  mergeSha: string | null
}

export interface DocumentUpdatePromptInput {
  key: string
  title: string
  /** Absolute path of the document the run was made from (`DocumentRun.source_path`), not the run's copy. */
  sourcePath: string
  /**
   * The run's text copy of the document (`DocumentRun.document_path`), which the ticket's
   * description lists among its read-only spec files; never the file to edit.
   */
  documentCopyPath?: string | null
  format: DocumentUpdateFormat
  /** The file's encoding as detected (`utf-8`, `windows-1252`); null when unknown. */
  encoding: string | null
  /** The document sits inside a git work tree (often the project's own main checkout). */
  insideRepo: boolean
  integrationBranch: string
  /** The task's branch; null when not recorded. */
  branchName: string | null
  /** The merge commit on the integration branch; null when there is none (or a connection run). */
  mergeSha: string | null
  /** Connection projects: the merge of each member repository. */
  memberMerges?: readonly DocumentUpdateMemberMerge[] | null
  /** What the run last made of the agent's message; null when it was never judged. */
  verdict: Pick<
    DocumentRunVerdict,
    'status' | 'reason' | 'summary' | 'migrations' | 'manualSteps'
  > | null
  /** How the agent was asked to verify its work (none while the run skips verification). */
  verification: readonly DocumentVerificationMethod[]
  /** The run's verify command, which passed on the integration branch after this merge; null when none ran. */
  verifyCommand: string | null
  /** Fix sessions it took for the verify command to pass after the merge. */
  fixAttempts: number
  /** `<dirname>/<stem>.assets` next to the document; screenshots go in `<assetsDir>/<KEY>/`. */
  assetsDir: string
  /** Keys of the run's other tasks, whose sections must be left alone. */
  otherTasks: readonly string[]
  /** YYYY-MM-DD, for the notes block. */
  today: string
  /** The run's "agents may ask" setting, as it is now. */
  interactive: boolean
  /**
   * The task was closed without a merge: an unattended run found that its branch had nothing new
   * to merge, because the task was already implemented.
   */
  alreadyImplemented?: boolean
}

const VERIFICATION_LABELS: Record<DocumentVerificationMethod, string> = {
  tcu: 'tcu (computer use)',
  playwright: 'playwright',
  tests: 'tests'
}

/** "`web/` at `abc`, `api/` (nothing new)": where each member's merge sits. */
const listMemberMerges = (members: readonly DocumentUpdateMemberMerge[]): string =>
  members
    .map((member) =>
      member.mergeSha
        ? `\`${member.symlinkName}/\` at \`${member.mergeSha}\``
        : `\`${member.symlinkName}/\` (nothing new)`
    )
    .join(', ')

/** The opening line: what happened to the task, and what is asked now. */
function documentUpdateLead(input: DocumentUpdatePromptInput, title: string): string {
  const task = `Your task ${input.key}${title ? ` ("${title}")` : ''}`
  const ask =
    'One last step: record in the document this run was made from what was done, how it was verified, and what is left.'
  if (input.alreadyImplemented) {
    return `${task} is closed without a merge: your branch had nothing new to merge: the task was already implemented on \`${input.integrationBranch}\`. ${ask}`
  }
  const members = input.memberMerges && input.memberMerges.length > 0 ? input.memberMerges : null
  const where = members
    ? ` (${listMemberMerges(members)})`
    : input.mergeSha
      ? ` (merge commit \`${input.mergeSha}\`)`
      : ''
  return `${task} is merged into \`${input.integrationBranch}\`${where}. ${ask}`
}

/** The "Merged:" line of the notes block. */
function mergedNote(input: DocumentUpdatePromptInput): string {
  if (input.alreadyImplemented) {
    return `nothing new, the task was already implemented on \`${input.integrationBranch}\``
  }
  const members = input.memberMerges && input.memberMerges.length > 0 ? input.memberMerges : null
  const branch = input.branchName ? `\`${input.branchName}\` into ` : 'into '
  if (members) return `${branch}\`${input.integrationBranch}\`: ${listMemberMerges(members)}`
  return `${branch}\`${input.integrationBranch}\`${input.mergeSha ? ` at \`${input.mergeSha}\`` : ''}`
}

/** One line of text that ends as a sentence does, without doubling a full stop. */
const asSentence = (text: string): string => {
  const line = text.replace(/\s+/g, ' ').trim()
  return /[.!?]$/.test(line) ? line : `${line}.`
}

const listOrNone = (entries: readonly string[] | undefined): string => {
  const cleaned = (entries ?? []).map((entry) => entry.replace(/\s+/g, ' ').trim()).filter(Boolean)
  return cleaned.length > 0 ? cleaned.join('; ') : 'none'
}

/**
 * Sent to a merged ticket's own session (or one an unattended run closed as already
 * implemented) to update the user's document: mark the task done, and add a short notes block
 * on what was done, how it was verified, the screenshots and the follow-ups. The file is named
 * by its plain absolute path, because the agent edits it with its own tools; a copy of the
 * document inside the worktree is a different file.
 */
export function buildDocumentUpdatePrompt(input: DocumentUpdatePromptInput): string {
  const title = input.title.replace(/\s+/g, ' ').trim()
  const key = input.key
  const verdict = input.verdict
  const assets = `${input.assetsDir.replace(/[\\/]+$/, '')}/${key}/`
  const others =
    input.otherTasks.length > 0
      ? `Other tasks of this document (${input.otherTasks.join(', ')}) update it too, one at a time, and I may have it open.`
      : 'I may have it open.'
  const encoding = input.encoding
    ? `Keep the file's encoding (\`${input.encoding}\`) and its line endings.`
    : "Keep the file's encoding and its line endings."
  const facts = [
    `- Summary: ${verdict?.summary?.replace(/\s+/g, ' ').trim() || 'none recorded'}`,
    ...(verdict && verdict.status !== 'done' && !input.alreadyImplemented
      ? [
          `- Caveat: it was merged although your last message read as not done: ${asSentence(verdict.reason)} Mark the task ⚠️ PARTIAL unless that was resolved, and list what is missing under Follow-ups.`
        ]
      : []),
    input.verification.length > 0
      ? `- Verification asked for: ${input.verification.map((method) => VERIFICATION_LABELS[method]).join(', ')}`
      : '- Verification asked for: none (say what you did check, if anything)',
    ...(input.verifyCommand
      ? [
          `- Checks after the merge: \`${input.verifyCommand}\` passed on \`${input.integrationBranch}\`${
            input.fixAttempts > 0
              ? ` after ${input.fixAttempts} fix attempt${input.fixAttempts === 1 ? '' : 's'} in the integration worktree`
              : ''
          }`
        ]
      : []),
    `- Migrations: ${listOrNone(verdict?.migrations)}`,
    `- Manual steps: ${listOrNone(verdict?.manualSteps)}`
  ]
  return [
    documentUpdateLead(input, title),
    '',
    `The document: \`${input.sourcePath}\``,
    '',
    `1. Edit that file in place, at that absolute path. It is my own file, not part of your branch: do not edit a copy of it inside your worktree (a file there with the same name is a different file), do not move or rename it, and do not commit it, stage it or run git in its directory${
      input.insideRepo ? ' (it sits inside a git checkout, whose git state stays as it is)' : ''
    }. Your branch ${input.alreadyImplemented ? 'stays' : 'is merged and stays'} as it is: no code changes and no commits. Your task listed the spec files as read-only: that no longer holds for this file, which you now edit${
      input.documentCopyPath
        ? `, but it still holds for the run's text copy of it (\`${input.documentCopyPath}\`): do not edit that one`
        : ''
    }.`,
    `2. ${others} Read the file right before you edit it, and change it with small targeted edits, never by rewriting the whole file. If it changed while you worked, read it again and redo your edit.`,
    `3. Edit only the section(s) of task ${key}. Where ${key} is also listed elsewhere (a table of contents, a task table, a checklist), update only its own row or line. Never change other tasks' sections. Keep the document's formatting, headings, anchors, ids and the wording of the spec.`,
    '4. Mark what is done:',
    "   - The task's title: ✅ DONE and struck through when the task is done; ⚠️ PARTIAL (not struck through) when only part of it is.",
    '   - Each item of its checklist, acceptance criteria or sub-tasks: struck through with ✅ when done, ⚠️ and what is missing when partly done, ❌ and why when not done.',
    '   Strike through titles and list items only; keep the paragraphs of the spec readable.',
    "5. Right under the task's title add one short notes block (replace the one an earlier update added, if any):",
    `   - Status: Done | Partially done | Not done (${input.today})`,
    '   - What was done: two or three sentences',
    `   - Merged: ${mergedNote(input)}`,
    '   - Verified: for each way you checked, what you ran or walked through and what it returned: commands, test names, the flow. Say "not verified" and why where you could not check. Never describe a check you did not run.',
    `   - Screenshots: copy the screenshots from your verification that show the change into \`${assets}\` (create it) and link them with a path relative to the document. Leave this line out when you took none.`,
    '   - Migrations and manual steps: what a human must still do, or "none"',
    '   - Follow-ups: work this task leaves for later (gaps, bugs you noticed, decisions you made alone that I should review), each as an open to-do item, or "None"',
    `6. ${DOCUMENT_UPDATE_FORMAT_PARAGRAPHS[input.format]} ${encoding}`,
    '',
    'What the run knows of your task, from your earlier messages (correct it from what you actually did):',
    ...facts,
    '',
    documentUpdateFooterInstructions(input.interactive)
  ].join('\n')
}

/**
 * Sent once when the agent's turn ended and the document's bytes are what they were before the
 * prompt. With uncommitted changes in its worktree, the agent most likely edited the copy there.
 */
export function buildDocumentUpdateNudgePrompt(
  sourcePath: string,
  worktreeDirty: boolean,
  interactive = true
): string {
  const lead = worktreeDirty
    ? `The document at \`${sourcePath}\` is unchanged, and your worktree has uncommitted changes: you edited a copy in your worktree, not the document. Undo those changes (your branch is merged and stays as it is), then make the edit in the file at that absolute path.`
    : `The document at \`${sourcePath}\` is unchanged since I asked you to update it. Make the edit in the file at that absolute path (not a copy of it in your worktree), then check that it was saved. If you changed a copy of it in your worktree instead, undo that change: your branch is merged and stays as it is.`
  return [
    lead,
    '',
    'If you cannot edit it, say why in NOTES and report FAILED. Do not commit anything.',
    '',
    documentUpdateFooterInstructions(interactive)
  ].join('\n')
}

/** Sent to resume a document update that ended on an API error or was cut off. */
export function buildDocumentUpdateContinuePrompt(
  reason: 'api_error' | 'interrupted',
  interactive = true
): string {
  const lead =
    reason === 'api_error'
      ? 'Your last turn ended on an API error.'
      : 'Your last turn was interrupted before it finished.'
  return [
    `${lead} Continue updating the document where you left off: read it again first to see what you already changed, then finish the edit. Do not commit anything and do not change your branch.`,
    '',
    documentUpdateFooterInstructions(interactive)
  ].join('\n')
}
