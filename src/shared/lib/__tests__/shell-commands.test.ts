import { describe, expect, it } from 'vitest'
import {
  SHELL_COMMAND_LABEL_MAX,
  SHELL_COMMAND_MAX_PER_PROJECT,
  SHELL_COMMAND_MAX_SCRIPT_BYTES,
  SHELL_COMMAND_NAME_MAX,
  SHELL_COMMAND_RUN_STATES,
  createSessionShellCommandSnapshot,
  describeShellCommandFailure,
  isShellCommandRunActive,
  isShellCommandRunFinished,
  normalizeShellCommand,
  parseProjectShellCommands,
  parseSessionShellCommand,
  parseShellCommandSteps,
  serializeSessionShellCommand,
  shellCommandOutcomeLabel,
  shellCommandStepLabel,
  validateShellCommand,
  type ProjectShellCommand,
  type SessionShellCommand,
  type ShellCommandRunState
} from '../shell-commands'

const NUL = String.fromCharCode(0)
const BOM = String.fromCharCode(0xfeff)
const ESC = String.fromCharCode(0x1b)
const LINE_SEPARATOR = String.fromCharCode(0x2028)

const command = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'build',
  name: 'Build',
  commands: 'pnpm build',
  ...overrides
})

const snapshot = (overrides: Partial<SessionShellCommand> = {}): SessionShellCommand => ({
  commandId: 'build',
  name: 'Build',
  script: 'pnpm build',
  detached: false,
  state: 'pending',
  runId: null,
  exitCode: null,
  signal: null,
  reason: null,
  error: null,
  startedAt: null,
  finishedAt: null,
  ...overrides
})

describe('parseShellCommandSteps', () => {
  it('splits on CRLF, CR and LF and trims each line', () => {
    expect(parseShellCommandSteps('echo a\r\necho b\recho c\n  echo d  \n')).toEqual([
      'echo a',
      'echo b',
      'echo c',
      'echo d'
    ])
  })

  it('drops blank lines, a shebang, comments and indented comments but keeps inline comments', () => {
    expect(
      parseShellCommandSteps(
        ['#!/bin/bash', '', '# c', '\t# indented', '   ', 'echo b # inline', 'echo c'].join('\n')
      )
    ).toEqual(['echo b # inline', 'echo c'])
  })

  it('joins lines ending in a single backslash', () => {
    expect(parseShellCommandSteps('docker run \\\n  -v a:b \\\n  image\necho after')).toEqual([
      'docker run   -v a:b   image',
      'echo after'
    ])
  })

  it('does not join on an escaped (double) backslash, but does on a triple one', () => {
    expect(parseShellCommandSteps('echo a\\\\\necho b')).toEqual(['echo a\\\\', 'echo b'])
    expect(parseShellCommandSteps('echo a\\\\\\\necho b')).toEqual(['echo a\\\\echo b'])
  })

  it('drops a dangling backslash at the end of the text', () => {
    expect(parseShellCommandSteps('echo dangling \\')).toEqual(['echo dangling'])
    expect(parseShellCommandSteps('echo one\n\\')).toEqual(['echo one'])
  })

  it('never lets a comment ending in a backslash swallow the next line', () => {
    expect(parseShellCommandSteps('# comment \\\necho next')).toEqual(['echo next'])
  })

  it('strips a leading BOM', () => {
    expect(parseShellCommandSteps(`${BOM}echo a\necho b`)).toEqual(['echo a', 'echo b'])
    expect(parseShellCommandSteps(`${BOM}# only a comment`)).toEqual([])
  })

  it('returns [] for empty, whitespace-only and non-string input', () => {
    expect(parseShellCommandSteps('')).toEqual([])
    expect(parseShellCommandSteps(' \n\t\r\n  ')).toEqual([])
    expect(parseShellCommandSteps(undefined as unknown as string)).toEqual([])
    expect(parseShellCommandSteps(42 as unknown as string)).toEqual([])
  })
})

describe('shellCommandStepLabel', () => {
  it('collapses control characters into single spaces', () => {
    expect(shellCommandStepLabel(`echo\ta${ESC}[31m${LINE_SEPARATOR}b`)).toBe('echo a [31m b')
    expect(shellCommandStepLabel('plain step')).toBe('plain step')
  })

  it('truncates to the label maximum in code points, ending in the ellipsis', () => {
    expect(SHELL_COMMAND_LABEL_MAX).toBe(120)
    const exact = 'x'.repeat(120)
    expect(shellCommandStepLabel(exact)).toBe(exact)

    const long = shellCommandStepLabel('x'.repeat(200))
    expect(Array.from(long)).toHaveLength(120)
    expect(long).toBe('x'.repeat(119) + '…')

    // Astral characters count once and are never cut in half.
    const emoji = shellCommandStepLabel('😀'.repeat(130))
    expect(Array.from(emoji)).toHaveLength(120)
    expect(emoji).toBe('😀'.repeat(119) + '…')

    expect(shellCommandStepLabel('abcdefgh', 4)).toBe('abc…')
  })
})

describe('validateShellCommand', () => {
  it('accepts a UUID id, with and without keepRunningOnQuit', () => {
    const id = '3f2b8c1e-9d4a-4f6b-8a2e-5c7d9e1f0a3b'
    expect(validateShellCommand(command({ id }))).toEqual({ valid: true, errors: [] })
    expect(validateShellCommand(command({ id, keepRunningOnQuit: true })).valid).toBe(true)
    expect(validateShellCommand(command({ id, keepRunningOnQuit: false })).valid).toBe(true)
  })

  it('rejects non-objects', () => {
    for (const value of [null, undefined, 'pnpm build', 42, [command()]]) {
      expect(validateShellCommand(value).valid).toBe(false)
    }
  })

  it('rejects a bad id', () => {
    for (const id of ['', 'has space', 'a/b', '../x', 'x'.repeat(65), 42, undefined]) {
      const result = validateShellCommand(command({ id }))
      expect(result.valid).toBe(false)
      expect(result.errors.join(' ')).toContain('id')
    }
  })

  it('rejects a blank or over-long name', () => {
    expect(SHELL_COMMAND_NAME_MAX).toBe(80)
    expect(validateShellCommand(command({ name: '   ' })).valid).toBe(false)
    expect(validateShellCommand(command({ name: undefined })).valid).toBe(false)
    expect(validateShellCommand(command({ name: 'n'.repeat(81) })).valid).toBe(false)
    expect(validateShellCommand(command({ name: 'n'.repeat(80) })).valid).toBe(true)
    // Surrounding whitespace is not counted: the name is stored trimmed.
    expect(validateShellCommand(command({ name: `  ${'n'.repeat(80)}  ` })).valid).toBe(true)
  })

  it('rejects scripts that are empty, comment-only, contain NUL or exceed 64 KB', () => {
    expect(SHELL_COMMAND_MAX_SCRIPT_BYTES).toBe(65536)
    expect(validateShellCommand(command({ commands: '' })).valid).toBe(false)
    expect(validateShellCommand(command({ commands: ' \n ' })).valid).toBe(false)
    expect(validateShellCommand(command({ commands: undefined })).valid).toBe(false)
    expect(validateShellCommand(command({ commands: '#!/bin/sh\n# nothing to run' }))).toEqual({
      valid: false,
      errors: ['commands must contain at least one runnable line']
    })
    expect(validateShellCommand(command({ commands: `echo a${NUL}b` })).valid).toBe(false)
    expect(validateShellCommand(command({ commands: 'x'.repeat(65536) })).valid).toBe(true)
    expect(validateShellCommand(command({ commands: 'x'.repeat(65537) })).valid).toBe(false)
    // The limit is in UTF-8 bytes, not UTF-16 units.
    expect(validateShellCommand(command({ commands: 'é'.repeat(32769) })).valid).toBe(false)
  })

  it('rejects a non-boolean keepRunningOnQuit', () => {
    for (const keepRunningOnQuit of ['true', 1, null, {}]) {
      const result = validateShellCommand(command({ keepRunningOnQuit }))
      expect(result).toEqual({ valid: false, errors: ['keepRunningOnQuit must be a boolean'] })
    }
  })

  it('reports every problem at once', () => {
    expect(validateShellCommand({ id: 'bad id', name: '', commands: '' }).errors).toHaveLength(3)
  })
})

describe('normalizeShellCommand / parseProjectShellCommands', () => {
  it('normalizes: trims the name, keeps only known keys, omits a false keepRunningOnQuit', () => {
    expect(
      normalizeShellCommand({
        ...command({ name: '  Build  ', keepRunningOnQuit: false, extra: 1 })
      } as unknown as ProjectShellCommand)
    ).toEqual({ id: 'build', name: 'Build', commands: 'pnpm build' })
    expect(
      normalizeShellCommand(command({ keepRunningOnQuit: true }) as unknown as ProjectShellCommand)
    ).toEqual({ id: 'build', name: 'Build', commands: 'pnpm build', keepRunningOnQuit: true })
  })

  it('reads a JSON string and an already-parsed array alike', () => {
    const list = [command({ keepRunningOnQuit: true }), command({ id: 'test', name: 'Test' })]
    const expected = [
      { id: 'build', name: 'Build', commands: 'pnpm build', keepRunningOnQuit: true },
      { id: 'test', name: 'Test', commands: 'pnpm build' }
    ]
    expect(parseProjectShellCommands(JSON.stringify(list))).toEqual(expected)
    expect(parseProjectShellCommands(list)).toEqual(expected)
  })

  it('yields [] for garbage and never throws', () => {
    for (const value of [null, undefined, '', '   ', '{not json', '{"id":"x"}', '42', 42, {}]) {
      expect(parseProjectShellCommands(value)).toEqual([])
    }
  })

  it('drops invalid entries and later duplicates of an id, and strips unknown keys', () => {
    expect(
      parseProjectShellCommands([
        command({ unknown: 'dropped', keepRunningOnQuit: false }),
        command({ name: 'Duplicate', commands: 'echo second' }),
        command({ id: 'noop', commands: '# nothing' }),
        command({ id: 'bad id' }),
        'pnpm test',
        null,
        command({ id: 'test', name: ' Test ' })
      ])
    ).toEqual([
      { id: 'build', name: 'Build', commands: 'pnpm build' },
      { id: 'test', name: 'Test', commands: 'pnpm build' }
    ])
  })

  it('keeps at most the per-project maximum', () => {
    expect(SHELL_COMMAND_MAX_PER_PROJECT).toBe(50)
    const many = Array.from({ length: 60 }, (_, index) => command({ id: `cmd-${index}` }))
    const parsed = parseProjectShellCommands(many)
    expect(parsed).toHaveLength(50)
    expect(parsed[49].id).toBe('cmd-49')
  })
})

describe('session snapshots', () => {
  it('creates a pending snapshot from a command', () => {
    expect(
      createSessionShellCommandSnapshot({
        id: 'build',
        name: '  Build  ',
        commands: 'pnpm build\npnpm test',
        keepRunningOnQuit: true
      })
    ).toEqual(snapshot({ script: 'pnpm build\npnpm test', detached: true }))
    expect(
      createSessionShellCommandSnapshot({ id: 'build', name: 'Build', commands: 'pnpm build' })
        .detached
    ).toBe(false)
  })

  it('round-trips through serialize and parse', () => {
    const pending = createSessionShellCommandSnapshot({
      id: 'build',
      name: 'Build',
      commands: 'pnpm build',
      keepRunningOnQuit: true
    })
    expect(parseSessionShellCommand(serializeSessionShellCommand(pending))).toEqual(pending)

    const finished = snapshot({
      detached: true,
      state: 'failed',
      runId: 'run_2026-10-05-abc',
      exitCode: 3,
      signal: 15,
      reason: 'output-limit',
      error: 'spawn failed',
      startedAt: '2026-10-05T00:00:00.000Z',
      finishedAt: '2026-10-05T00:00:05.000Z'
    })
    expect(parseSessionShellCommand(serializeSessionShellCommand(finished))).toEqual(finished)
    // An already-parsed object is accepted too.
    expect(parseSessionShellCommand({ ...finished })).toEqual(finished)
  })

  it('falls back to "not run yet" values for bogus or missing run fields', () => {
    expect(
      parseSessionShellCommand({
        commandId: 'build',
        name: 'Build',
        script: 'pnpm build',
        state: 'exploded',
        runId: '../../etc',
        exitCode: '1',
        signal: 1.5,
        reason: 'because',
        error: '',
        startedAt: 12,
        finishedAt: null,
        unknown: 'dropped'
      })
    ).toEqual(snapshot())
    expect(
      parseSessionShellCommand('{"commandId":"build","name":"Build","script":"pnpm build"}')
    ).toEqual(snapshot())
    expect(parseSessionShellCommand(snapshot({ detached: 'yes' as unknown as boolean }))).toEqual(
      snapshot()
    )
  })

  it('returns null when the value does not describe a runnable snapshot', () => {
    for (const value of [
      null,
      undefined,
      '',
      '  ',
      '{not json',
      '[]',
      '42',
      42,
      [snapshot()],
      { ...snapshot(), commandId: '' },
      { ...snapshot(), commandId: 7 },
      { ...snapshot(), name: null },
      { ...snapshot(), script: '   ' },
      { ...snapshot(), script: undefined },
      { ...snapshot(), script: `echo${NUL}` },
      { ...snapshot(), script: 'x'.repeat(SHELL_COMMAND_MAX_SCRIPT_BYTES + 1) }
    ]) {
      expect(parseSessionShellCommand(value)).toBeNull()
    }
  })
})

describe('run state helpers', () => {
  const outcome = (
    state: ShellCommandRunState,
    overrides: Partial<SessionShellCommand> = {}
  ): SessionShellCommand => snapshot({ state, ...overrides })

  it('splits the states into active and finished', () => {
    expect(SHELL_COMMAND_RUN_STATES).toEqual([
      'pending',
      'running',
      'succeeded',
      'failed',
      'cancelled',
      'interrupted'
    ])
    const active = SHELL_COMMAND_RUN_STATES.filter((state) => isShellCommandRunActive(state))
    expect(active).toEqual(['pending', 'running'])
    for (const state of SHELL_COMMAND_RUN_STATES) {
      expect(isShellCommandRunFinished(state)).toBe(!isShellCommandRunActive(state))
    }
  })

  it('describes only failed and interrupted runs', () => {
    expect(describeShellCommandFailure(outcome('pending'))).toBeNull()
    expect(describeShellCommandFailure(outcome('running'))).toBeNull()
    expect(describeShellCommandFailure(outcome('succeeded', { exitCode: 0 }))).toBeNull()
    expect(describeShellCommandFailure(outcome('cancelled', { exitCode: 130 }))).toBeNull()

    expect(describeShellCommandFailure(outcome('failed', { exitCode: 7 }))).toBe(
      'Command failed (exit 7)'
    )
    expect(describeShellCommandFailure(outcome('failed'))).toBe('Command failed (exit 1)')
    expect(describeShellCommandFailure(outcome('failed', { reason: 'output-limit' }))).toBe(
      'Command stopped: output limit reached'
    )
    expect(
      describeShellCommandFailure(
        outcome('failed', { reason: 'start-failed', error: 'Worktree not found' })
      )
    ).toBe('Command could not start: Worktree not found')
    expect(describeShellCommandFailure(outcome('failed', { reason: 'start-failed' }))).toBe(
      'Command could not start'
    )
    expect(describeShellCommandFailure(outcome('interrupted'))).toBe(
      'Command interrupted (the app quit while it was running)'
    )
  })

  it('always puts a space in a failure text (ticket marks without one render as API codes)', () => {
    const failures: SessionShellCommand[] = [
      outcome('failed'),
      outcome('failed', { exitCode: 0 }),
      outcome('failed', { exitCode: 255 }),
      outcome('failed', { reason: 'output-limit' }),
      outcome('failed', { reason: 'start-failed' }),
      outcome('failed', { reason: 'start-failed', error: 'ENOENT' }),
      outcome('interrupted'),
      outcome('interrupted', { exitCode: 1, reason: 'start-failed' })
    ]
    for (const run of failures) {
      const text = describeShellCommandFailure(run)
      expect(text).not.toBeNull()
      expect(text).toMatch(/\s/)
    }
  })

  it('labels every state for the status strip', () => {
    expect(shellCommandOutcomeLabel(outcome('pending'))).toBe('Starting…')
    expect(shellCommandOutcomeLabel(outcome('running'))).toBe('Running')
    expect(shellCommandOutcomeLabel(outcome('succeeded', { exitCode: 0 }))).toBe('Succeeded')
    expect(shellCommandOutcomeLabel(outcome('cancelled'))).toBe('Stopped')
    expect(shellCommandOutcomeLabel(outcome('interrupted'))).toBe('Interrupted')
    expect(shellCommandOutcomeLabel(outcome('failed', { exitCode: 2 }))).toBe('Failed (exit 2)')
    expect(shellCommandOutcomeLabel(outcome('failed'))).toBe('Failed (exit 1)')
    expect(shellCommandOutcomeLabel(outcome('failed', { reason: 'output-limit' }))).toBe(
      'Failed (output limit reached)'
    )
    expect(shellCommandOutcomeLabel(outcome('failed', { reason: 'start-failed' }))).toBe(
      'Could not start'
    )
    for (const state of SHELL_COMMAND_RUN_STATES) {
      expect(shellCommandOutcomeLabel(outcome(state))).not.toBe('')
    }
  })
})
