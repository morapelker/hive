import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  DETACHED_HOST_ARGV0,
  DETACHED_HOST_SCRIPT,
  SHELL_COMMAND_ARGV0,
  SHELL_COMMAND_WRAPPER
} from '../shell-command-scripts'

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * The two shell constants are byte-exact copies of the scripts that were measured
 * against zsh, bash 3.2, bash 5, sh, ksh and dash. Any change (even whitespace) must
 * be re-measured, so their hashes are pinned here. Do not relax these tests.
 */
describe('shell-command-scripts', () => {
  it('SHELL_COMMAND_WRAPPER is the measured wrapper, byte for byte', () => {
    expect(Buffer.byteLength(SHELL_COMMAND_WRAPPER, 'utf8')).toBe(1412)
    expect(sha256(SHELL_COMMAND_WRAPPER)).toBe(
      'a4537c6d6135f38a09979ea15673544af99d1bc0b3089f3bace5e203ed690a8b'
    )
  })

  it('DETACHED_HOST_SCRIPT is the measured host, byte for byte', () => {
    expect(Buffer.byteLength(DETACHED_HOST_SCRIPT, 'utf8')).toBe(1586)
    expect(sha256(DETACHED_HOST_SCRIPT)).toBe(
      'e559a2e27f66ad1830cacec82c2a6b92d4c205db424a954f8410cbd112a5303e'
    )
  })

  it('neither script contains a backtick or a dollar-brace (String.raw safety)', () => {
    for (const script of [SHELL_COMMAND_WRAPPER, DETACHED_HOST_SCRIPT]) {
      expect(script).not.toMatch(/`/)
      expect(script).not.toMatch(/\$\{/)
    }
  })

  it('exposes the two argv0 constants', () => {
    expect(SHELL_COMMAND_ARGV0).toBe('hive-shell-command')
    expect(DETACHED_HOST_ARGV0).toBe('hive-shell-host')
  })

  it('the wrapper only reaches the run dir through the environment variable the host sets', () => {
    expect(SHELL_COMMAND_WRAPPER).toContain('__tc_dir=$HIVE_SHELL_RUN_DIR')
    expect(SHELL_COMMAND_WRAPPER).toContain('unset HIVE_SHELL_RUN_DIR')
    expect(DETACHED_HOST_SCRIPT).toContain('export HIVE_SHELL_RUN_DIR="$d"')
  })
})
