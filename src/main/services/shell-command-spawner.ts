import { shellCommandStepLabel } from '@shared/lib/shell-commands'
import {
  DETACHED_HOST_ARGV0,
  DETACHED_HOST_SCRIPT,
  SHELL_COMMAND_ARGV0,
  SHELL_COMMAND_WRAPPER
} from './shell-command-scripts'

/**
 * Pure argv builders for shell-command runs. User text (the steps) only ever becomes
 * positional argv: nothing is interpolated into the two script constants.
 */
export interface ShellCommandSpawn {
  command: string
  args: string[]
}

/** Shells that can run the POSIX wrapper. fish, tcsh and unknown shells fall back. */
const POSIX_WRAPPER_SHELLS = new Set(['zsh', 'bash', 'sh', 'dash', 'ksh'])

/** argv cannot carry a NUL character. */
const NUL = String.fromCharCode(0)

/**
 * The in-app spawn (also the inner command of a detached run):
 * `<shell> <flags> SHELL_COMMAND_WRAPPER SHELL_COMMAND_ARGV0 <label1> <step1> <label2> <step2> ...`
 */
export function buildShellCommandPtySpawn(
  steps: string[],
  opts: { shell?: string; platform?: NodeJS.Platform } = {}
): ShellCommandSpawn {
  const platform = opts.platform ?? process.platform
  if (platform === 'win32') throw new Error('Shell commands are not supported on Windows')
  if (steps.length === 0) throw new Error('Shell command has no runnable lines')
  if (steps.some((step) => step.includes(NUL))) {
    throw new Error('Shell command contains an invalid character')
  }
  const posixFallback = platform === 'darwin' ? '/bin/zsh' : '/bin/bash'
  const shell = opts.shell ?? process.env.SHELL ?? posixFallback
  const shellName = shell.split('/').pop() ?? shell
  const command = POSIX_WRAPPER_SHELLS.has(shellName) ? shell : posixFallback
  const name = command.split('/').pop() ?? command
  // zsh/sh/ksh: -ilc (login + interactive = full PATH and aliases); bash: -ic (.bashrc);
  // dash: never -i (interactive dash drops to a prompt after a syntax error).
  const flags = name === 'bash' ? '-ic' : name === 'dash' ? '-c' : '-ilc'
  const pairs = steps.flatMap((step) => [shellCommandStepLabel(step), step])
  return { command, args: [flags, SHELL_COMMAND_WRAPPER, SHELL_COMMAND_ARGV0, ...pairs] }
}

/**
 * The detached spawn: `/bin/sh -c DETACHED_HOST_SCRIPT DETACHED_HOST_ARGV0 <runDir> <cols>
 * <rows> <inner command and args>`, where the inner command is an in-app spawn.
 */
export function buildDetachedHostSpawn(
  spawn: ShellCommandSpawn,
  opts: { runDir: string; cols: number; rows: number }
): ShellCommandSpawn {
  return {
    command: '/bin/sh',
    args: [
      '-c',
      DETACHED_HOST_SCRIPT,
      DETACHED_HOST_ARGV0,
      opts.runDir,
      String(opts.cols),
      String(opts.rows),
      spawn.command,
      ...spawn.args
    ]
  }
}
