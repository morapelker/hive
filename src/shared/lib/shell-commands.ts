// src/shared/lib/shell-commands.ts

/**
 * Project shell commands: named, pre-configured shell snippets that a project runs in
 * a dedicated terminal session from the project / worktree right-click menu.
 *
 * Not to be confused with CustomProjectCommand (custom-commands.ts): those are AI
 * prompt templates, these are executed by a shell.
 *
 * Shared by the main process (spawn + persistence), the server child (zod / backup)
 * and the renderer (editor, menus, session view), so this file must stay free of
 * node- and DOM-only imports.
 */

/** A command definition stored on the project (projects.shell_commands, JSON array). */
export interface ProjectShellCommand {
  id: string
  name: string
  /** One step per line. See parseShellCommandSteps for the exact rules. */
  commands: string
  /**
   * "Keep running if the app quits": run detached from the app so the command
   * survives the app quitting or being replaced mid-run (e.g. an installer).
   */
  keepRunningOnQuit?: boolean
}

export const SHELL_COMMAND_RUN_STATES = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted'
] as const

/**
 * pending    : session created, run not started yet
 * running    : the steps are executing
 * succeeded  : every step exited 0
 * failed     : a step failed (exitCode), the run could not start, or the output limit hit
 * cancelled  : stopped by the user (Stop button, tab close, ticket dragged back)
 * interrupted: the owner of the run vanished without a result (app quit / crash)
 */
export type ShellCommandRunState = (typeof SHELL_COMMAND_RUN_STATES)[number]

export type ShellCommandFailureReason = 'output-limit' | 'start-failed'

/**
 * Snapshot + run state persisted on the session (sessions.shell_command, JSON).
 * The script is snapshotted at launch so "Run again" and the transcript do not depend
 * on later edits of the project's command. The main process is the only writer of
 * everything from `state` down.
 */
export interface SessionShellCommand {
  /** ProjectShellCommand.id the session was launched from. */
  commandId: string
  name: string
  /** ProjectShellCommand.commands at launch time. */
  script: string
  /** ProjectShellCommand.keepRunningOnQuit at launch time. */
  detached: boolean
  state: ShellCommandRunState
  /** Id of the current / last run; names its directory under shell-command-runs/<sessionId>/. */
  runId: string | null
  exitCode: number | null
  signal: number | null
  reason: ShellCommandFailureReason | null
  /** Human-readable cause when reason is 'start-failed'. Never contains script text. */
  error: string | null
  startedAt: string | null
  finishedAt: string | null
}

/**
 * A shell command's ticket is an ordinary ticket row marked through the external-source
 * fields (like a document run's ticket), so it stays a shell-command ticket without a
 * session: duplicated, or dragged back to To Do. Only the command id is stored. The
 * script always comes from the project's own definition at launch, so neither a ticket
 * edit nor a board markdown file can decide what gets executed.
 */
export const SHELL_COMMAND_TICKET_PROVIDER = 'shell-command'

/** The ProjectShellCommand.id a ticket stands for; null for every other ticket. */
export function shellCommandIdOfTicket(
  ticket: { external_provider?: string | null; external_id?: string | null } | null | undefined
): string | null {
  if (ticket?.external_provider !== SHELL_COMMAND_TICKET_PROVIDER) return null
  return ticket.external_id || null
}

export interface ShellCommandValidationResult {
  valid: boolean
  errors: string[]
}

export const SHELL_COMMAND_NAME_MAX = 80
/** argv shares ARG_MAX (1 MiB on macOS) with the environment; keep scripts far below it. */
export const SHELL_COMMAND_MAX_SCRIPT_BYTES = 64 * 1024
export const SHELL_COMMAND_MAX_PER_PROJECT = 50
export const SHELL_COMMAND_LABEL_MAX = 120

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const FAILURE_REASONS: readonly string[] = ['output-limit', 'start-failed']
/** argv cannot carry a NUL character, so a script containing one can never be spawned. */
const NUL = String.fromCharCode(0)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

/**
 * Split stored command text into runnable steps.
 * - CRLF / CR / LF all split; a leading BOM is stripped; each line is trimmed.
 * - Blank lines and lines whose first non-blank character is '#' are dropped (so a
 *   '#!/bin/bash' first line is simply ignored: the text is never run as a script file).
 * - A line ending in an odd number of backslashes is joined with the next line (the
 *   backslash is removed; comment lines never join; a dangling '\' at the end is dropped).
 * Multi-line constructs (heredocs, if/fi across lines) are NOT supported: every step
 * must parse on its own, otherwise the run fails at that step.
 */
export function parseShellCommandSteps(text: string): string[] {
  if (typeof text !== 'string') return []
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const lines = body.split(/\r\n|\r|\n/)
  const steps: string[] = []
  let pending: string | null = null
  for (const raw of lines) {
    const line: string = pending === null ? raw.trim() : pending + raw.trimEnd()
    pending = null
    if (line === '' || line.startsWith('#')) continue
    // Count trailing backslashes with a backward scan: a `/\\+$/` regex is quadratic
    // on a long run of backslashes, and this parser runs on every project row read.
    let trailing = 0
    for (let i = line.length - 1; i >= 0 && line[i] === '\\'; i--) trailing++
    if (trailing % 2 === 1) {
      pending = line.slice(0, -1)
      continue
    }
    steps.push(line)
  }
  if (pending !== null && pending.trim() !== '') steps.push(pending.trimEnd())
  return steps
}

/** Banner text for a step: control characters collapsed, truncated to `max` code points. */
export function shellCommandStepLabel(step: string, max = SHELL_COMMAND_LABEL_MAX): string {
  const chars = Array.from(step.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' '))
  return chars.length <= max ? chars.join('') : chars.slice(0, max - 1).join('') + '…'
}

/** Validates one command definition (editor rows, RPC payloads, backup restore). */
export function validateShellCommand(command: unknown): ShellCommandValidationResult {
  if (!isRecord(command)) {
    return { valid: false, errors: ['Command must be an object'] }
  }

  const errors: string[] = []

  if (typeof command.id !== 'string' || !ID_PATTERN.test(command.id)) {
    errors.push('id must be 1-64 characters of letters, digits, "_" or "-"')
  }

  if (typeof command.name !== 'string' || command.name.trim() === '') {
    errors.push('name must be a non-empty string')
  } else if (Array.from(command.name.trim()).length > SHELL_COMMAND_NAME_MAX) {
    errors.push(`name must be at most ${SHELL_COMMAND_NAME_MAX} characters`)
  }

  if (typeof command.commands !== 'string' || command.commands.trim() === '') {
    errors.push('commands must be a non-empty string')
  } else if (command.commands.includes(NUL)) {
    errors.push('commands must not contain NUL characters')
  } else if (utf8ByteLength(command.commands) > SHELL_COMMAND_MAX_SCRIPT_BYTES) {
    errors.push(`commands must be at most ${SHELL_COMMAND_MAX_SCRIPT_BYTES / 1024} KB`)
  } else if (parseShellCommandSteps(command.commands).length === 0) {
    errors.push('commands must contain at least one runnable line')
  }

  if (command.keepRunningOnQuit !== undefined && typeof command.keepRunningOnQuit !== 'boolean') {
    errors.push('keepRunningOnQuit must be a boolean')
  }

  return { valid: errors.length === 0, errors }
}

/** Trimmed copy holding only the known keys (unknown keys never reach storage). */
export function normalizeShellCommand(command: ProjectShellCommand): ProjectShellCommand {
  return {
    id: command.id,
    name: command.name.trim(),
    commands: command.commands,
    ...(command.keepRunningOnQuit === true ? { keepRunningOnQuit: true } : {})
  }
}

/**
 * Tolerant reader for projects.shell_commands: accepts the stored JSON string or an
 * already-parsed array, keeps only valid entries (first occurrence of an id wins) and
 * never throws. Anything else yields [].
 */
export function parseProjectShellCommands(value: unknown): ProjectShellCommand[] {
  let parsed: unknown = value
  if (typeof value === 'string') {
    if (value.trim() === '') return []
    try {
      parsed = JSON.parse(value)
    } catch {
      return []
    }
  }
  if (!Array.isArray(parsed)) return []

  const commands: ProjectShellCommand[] = []
  const seen = new Set<string>()
  for (const entry of parsed) {
    if (commands.length >= SHELL_COMMAND_MAX_PER_PROJECT) break
    if (!validateShellCommand(entry).valid) continue
    const command = normalizeShellCommand(entry as ProjectShellCommand)
    if (seen.has(command.id)) continue
    seen.add(command.id)
    commands.push(command)
  }
  return commands
}

/** The snapshot a new shell-command session starts with (state 'pending'). */
export function createSessionShellCommandSnapshot(
  command: ProjectShellCommand
): SessionShellCommand {
  return {
    commandId: command.id,
    name: command.name.trim(),
    script: command.commands,
    detached: command.keepRunningOnQuit === true,
    state: 'pending',
    runId: null,
    exitCode: null,
    signal: null,
    reason: null,
    error: null,
    startedAt: null,
    finishedAt: null
  }
}

function asNullableInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * Reads sessions.shell_command (JSON string, or an already-parsed object). Returns
 * null when the value is missing or does not describe a runnable snapshot; optional
 * run fields fall back to their "not run yet" values so older rows keep parsing.
 */
export function parseSessionShellCommand(value: unknown): SessionShellCommand | null {
  let parsed: unknown = value
  if (typeof value === 'string') {
    if (value.trim() === '') return null
    try {
      parsed = JSON.parse(value)
    } catch {
      return null
    }
  }
  if (!isRecord(parsed)) return null
  if (typeof parsed.commandId !== 'string' || parsed.commandId === '') return null
  if (typeof parsed.name !== 'string') return null
  if (typeof parsed.script !== 'string' || parsed.script.trim() === '') return null
  if (parsed.script.includes(NUL)) return null
  if (utf8ByteLength(parsed.script) > SHELL_COMMAND_MAX_SCRIPT_BYTES) return null

  const state = (SHELL_COMMAND_RUN_STATES as readonly string[]).includes(String(parsed.state))
    ? (parsed.state as ShellCommandRunState)
    : 'pending'
  const runId =
    typeof parsed.runId === 'string' && ID_PATTERN.test(parsed.runId) ? parsed.runId : null
  const reason = FAILURE_REASONS.includes(String(parsed.reason))
    ? (parsed.reason as ShellCommandFailureReason)
    : null

  return {
    commandId: parsed.commandId,
    name: parsed.name,
    script: parsed.script,
    detached: parsed.detached === true,
    state,
    runId,
    exitCode: asNullableInteger(parsed.exitCode),
    signal: asNullableInteger(parsed.signal),
    reason,
    error: asNullableString(parsed.error),
    startedAt: asNullableString(parsed.startedAt),
    finishedAt: asNullableString(parsed.finishedAt)
  }
}

export function serializeSessionShellCommand(snapshot: SessionShellCommand): string {
  return JSON.stringify(snapshot)
}

/** pending or running: the ticket belongs in In Progress and Run again is unavailable. */
export function isShellCommandRunActive(state: ShellCommandRunState): boolean {
  return state === 'pending' || state === 'running'
}

/** A terminal state: the transcript is final and Run again is available. */
export function isShellCommandRunFinished(state: ShellCommandRunState): boolean {
  return !isShellCommandRunActive(state)
}

type ShellCommandOutcome = Pick<SessionShellCommand, 'state' | 'exitCode' | 'reason' | 'error'>

/**
 * The error text for runs that need attention (failed / interrupted), null otherwise.
 * It is the linked ticket's error mark, so it always contains a space: the ticket card
 * renders whitespace-free marks as Claude API error codes.
 */
export function describeShellCommandFailure(run: ShellCommandOutcome): string | null {
  if (run.state === 'interrupted') {
    return 'Command interrupted (the app quit while it was running)'
  }
  if (run.state !== 'failed') return null
  if (run.reason === 'start-failed') {
    return run.error ? `Command could not start: ${run.error}` : 'Command could not start'
  }
  if (run.reason === 'output-limit') return 'Command stopped: output limit reached'
  return `Command failed (exit ${run.exitCode ?? 1})`
}

/** Short status text for the session's status strip and the tab tooltip. */
export function shellCommandOutcomeLabel(run: ShellCommandOutcome): string {
  switch (run.state) {
    case 'pending':
      return 'Starting…'
    case 'running':
      return 'Running'
    case 'succeeded':
      return 'Succeeded'
    case 'cancelled':
      return 'Stopped'
    case 'interrupted':
      return 'Interrupted'
    case 'failed':
      if (run.reason === 'start-failed') return 'Could not start'
      if (run.reason === 'output-limit') return 'Failed (output limit reached)'
      return `Failed (exit ${run.exitCode ?? 1})`
  }
}
