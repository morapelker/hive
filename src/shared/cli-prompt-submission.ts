// Terminal input that hands a whole prompt to a CLI agent (Claude Code, Codex) running in a PTY.

const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

/**
 * `prompt` as a bracketed paste and its Enter: the paste keeps a multi-line prompt from being
 * submitted line by line.
 *
 * `lead` is typed ahead of the paste, as keystrokes. Claude Code hands a pasted prompt to its
 * agent inside `<pasted_content>` tags, as text the user may not have written, and the agent
 * acts on instructions in there only where the user's own words tell it to: the lead is those
 * words. One line; anything that could act as a key press is taken out.
 */
export function encodeCliPromptSubmission(prompt: string, lead?: string): string {
  const typed = lead?.replace(/\p{Cc}+/gu, ' ').trim()
  return `${typed ? `${typed} ` : ''}${PASTE_START}${prompt}${PASTE_END}\r`
}

/** Terminal input that is a whole prompt submission: one bracketed paste (after its typed lead, if any) and its Enter. */
export function isCliPromptSubmission(data: string): boolean {
  if (!data.endsWith(`${PASTE_END}\r`)) return false
  const pasteAt = data.indexOf(PASTE_START)
  return pasteAt !== -1 && !/\p{Cc}/u.test(data.slice(0, pasteAt))
}
