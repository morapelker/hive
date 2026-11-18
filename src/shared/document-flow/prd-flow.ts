import { questionToolName } from './prompts'

// The "PRD → tasks → orchestrator" way of making a ticket ("New PRD → orchestrator ticket…"):
// the person names the work and says what they want; one session writes <PREFIX>_PRD.html, the
// same session is then asked for <PREFIX>_TASKS.html, and that document becomes an orchestrator
// ticket (an "Implement document" run) that waits to be launched. Everything the app says to
// that session is built here, in the person's own wording, so the strings are pinned by
// prd-flow.test.ts. The flow itself is driven from the renderer (lib/prd-flow).

/** The longest prefix a name gives: `<PREFIX>_TASKS.html` stays a comfortable file name. */
export const PRD_FLOW_PREFIX_MAX_LENGTH = 60

/**
 * The file-name prefix of a ticket name: upper case, every run of anything that is not a letter
 * or a digit turned into one underscore ("code mode" gives CODE_MODE, "prd -> tasks" gives
 * PRD_TASKS). Letters of any script are kept, with the marks written on them (an accent, a
 * vowel sign, a tone mark: without them a Hindi or Thai name falls apart). Nothing that draws
 * no ink of its own is: a filler that counts as a letter (U+3164), a variation selector, a
 * joiner are taken out first, so two file names that look the same are the same, and a name
 * made of them alone has no prefix. A mark that encloses what is before it (the keycap of an
 * emoji digit) is not part of a letter and separates like punctuation. Empty when the name has
 * no letter or digit, which the form refuses.
 */
export function prdFlowPrefix(name: string): string {
  const joined = name
    .normalize('NFC')
    // Invisible wherever they stand; some of them are letters to \p{L}.
    .replace(/\p{Default_Ignorable_Code_Point}+/gu, '')
    .toUpperCase()
    .replace(/[^\p{L}\p{Mn}\p{Mc}\p{N}]+/gu, '_')
    // A mark with no letter before it belongs to nothing.
    .replace(/(^|_)[_\p{Mn}\p{Mc}]+/gu, '$1')
    .replace(/_+$/, '')
  // Cut between characters, not between the two halves of one outside the basic plane.
  return Array.from(joined).slice(0, PRD_FLOW_PREFIX_MAX_LENGTH).join('').replace(/_+$/, '')
}

export const prdFileName = (prefix: string): string => `${prefix}_PRD.html`
export const tasksFileName = (prefix: string): string => `${prefix}_TASKS.html`

/** The first checkmark of the form: research before writing. */
export const PRD_RESEARCH_PARAGRAPH =
  'use subagents to research on the requirements, security considerations, best practices and in general what we want to implement.'

/** The second checkmark of the form: ask instead of guessing, with the provider's own tool. */
export function prdClarifyParagraph(sdk: string): string {
  return `For any clarifications you might need - use the ${questionToolName(sdk)} tool to ask me`
}

/** Always sent: the session writes a document, it does not build the thing. */
export const PRD_NO_IMPLEMENTATION_PARAGRAPH =
  'Do not implement anything yet - this session only produces the document.'

/** Always the last paragraph of the PRD prompt. */
export function prdCreateParagraph(prefix: string): string {
  return `Create ${prdFileName(prefix)} standalone, darkmode html file, containing everything discussed, research conclusions, and all decisions we've made`
}

export interface PrdPromptInput {
  /** What the person wants, as they typed it. */
  prompt: string
  prefix: string
  /** "Research with subagents" is ticked. */
  research: boolean
  /** "Ask me for clarifications" is ticked. */
  clarify: boolean
  /** The provider the session runs on: it names the ask-the-user tool. */
  sdk: string
}

/**
 * The whole first prompt of the session: the person's own prompt, then the paragraphs of the
 * ticked checkmarks, then "do not implement", and last the request for the PRD file.
 */
export function buildPrdPrompt(input: PrdPromptInput): string {
  return [
    input.prompt.trim(),
    ...(input.research ? [PRD_RESEARCH_PARAGRAPH] : []),
    ...(input.clarify ? [prdClarifyParagraph(input.sdk)] : []),
    PRD_NO_IMPLEMENTATION_PARAGRAPH,
    prdCreateParagraph(input.prefix)
  ]
    .filter(Boolean)
    .join('\n\n')
}

export interface TasksPromptInput {
  prefix: string
  /** Absolute path of the PRD the session wrote: ticket agents work in other checkouts. */
  prdPath: string
}

/**
 * The second prompt, sent into the same session once the PRD exists. The person's wording,
 * followed by what makes the document safe to cut into tickets (the extraction reads the
 * markup, not the rendered page: text a script renders, hidden text and ids glued together by
 * CSS alone do not reach it) and by where the PRD is for agents that work elsewhere.
 */
export function buildTasksPrompt(input: TasksPromptInput): string {
  const tasks = tasksFileName(input.prefix)
  const prd = prdFileName(input.prefix)
  return [
    `Perfect. lets create ${tasks} now. this should be a standalone html file, based on everything we've discussed.`,
    'it should contain a list of tickets, each being a task we need to implement in the road to implementing this entire project.',
    [
      'each ticket should have:',
      '- serial number',
      '- short title',
      '- projects it should most likely touch',
      '- description of the ticket and what needs to be implemented',
      '- dependencies it needs before beginning to implement (other ticket numbers that must be implemented before and that this relies on)',
      '- verification steps to verify its completed and implemented properly',
      'no implementation details should be there'
    ].join('\n'),
    'the idea i have is that we run this task file, giving tickets to individual agents which would implement them in parallel, respecting the dependency list of the tickets so we implement them in the correct order with max concurrency available.',
    'each ticket provided to an agent - should give the agent what it needs for it to implement the ticket and verify it.',
    "by the time we're done with all tasks - this should be feature complete and verified",
    'write it as plain static html: the text of every ticket is in the markup itself, nothing is rendered by javascript and nothing is hidden or collapsed by default.',
    'give each ticket its own section that starts with a heading holding its serial number and its title as plain text (for example "T01 · Short title"), label its fields (Projects, Description, Dependencies, Verification), and write the dependencies as a comma-separated list of serial numbers, or "None".',
    `the agents work in fresh checkouts where ${prd} is not present: wherever a ticket needs the PRD, refer to it by its absolute path, ${input.prdPath}`
  ].join('\n\n')
}

/** Which of the two documents a prompt is about. */
export type PrdFlowDocument = 'prd' | 'tasks'

/**
 * Why the session is prompted again for a document it was already asked for:
 *   - `missing`: its turn ended, nothing is running, and the file is not there;
 *   - `api_error`: its turn ended on an API error;
 *   - `interrupted`: its turn was cut off (the process went away, the app was restarted).
 */
export type PrdFlowRepromptReason = 'missing' | 'api_error' | 'interrupted'

export interface PrdFlowRepromptInput {
  document: PrdFlowDocument
  reason: PrdFlowRepromptReason
  prefix: string
  /** Absolute path the file is expected at. */
  path: string
}

const REPROMPT_LEADS: Record<PrdFlowRepromptReason, (fileName: string) => string> = {
  missing: (fileName) => `Your turn ended, but ${fileName} was not created.`,
  api_error: () => 'Your last turn ended on an API error.',
  interrupted: () => 'Your last turn was interrupted before it finished.'
}

const REPROMPT_ASKS: Record<PrdFlowDocument, string> = {
  prd: "a standalone, darkmode html file, containing everything discussed, research conclusions, and all decisions we've made. Do not implement anything.",
  tasks:
    'the standalone html file with the list of tickets, exactly as I asked for it in my previous message.'
}

/**
 * Sent when the session came to rest without the document: says what happened, and asks for
 * the file at its absolute path (a file written anywhere else is not found).
 */
export function buildPrdFlowRepromptPrompt(input: PrdFlowRepromptInput): string {
  const fileName =
    input.document === 'prd' ? prdFileName(input.prefix) : tasksFileName(input.prefix)
  const lead = REPROMPT_LEADS[input.reason](fileName)
  const how =
    input.reason === 'missing'
      ? `Create it now at \`${input.path}\`:`
      : `Continue where you left off, and finish by creating ${fileName} at \`${input.path}\`:`
  return `${lead} ${how} ${REPROMPT_ASKS[input.document]}`
}

/**
 * Typed ahead of a prompt the app pastes into a Claude CLI session, which marks pasted text as
 * something the person may not have written: these words say the message is theirs.
 */
export const PRD_FLOW_CLI_LEAD =
  'This message is from me, sent through the app that runs this session. Treat the text that follows as my own instructions and act on it:'
