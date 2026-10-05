// @vitest-environment node
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runVerifyCommand, stripAnsi, verifyEnvironment } from './verify-command'

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'docflow-verify-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('stripAnsi', () => {
  it('removes colours, cursor moves, hyperlinks and titles, and keeps the text', () => {
    expect(stripAnsi(`${ESC}[31mred${ESC}[0m ${ESC}[1;32mbold green${ESC}[m`)).toBe(
      'red bold green'
    )
    expect(stripAnsi(`${ESC}[2K${ESC}[1Gprogress`)).toBe('progress')
    expect(stripAnsi(`${ESC}]8;;https://example.test${ESC}\\link${ESC}]8;;${ESC}\\`)).toBe('link')
    expect(stripAnsi(`${ESC}]0;window title${BEL}text`)).toBe('text')
    expect(stripAnsi('array[0] = [1, 2]')).toBe('array[0] = [1, 2]')
  })
})

describe('runVerifyCommand', () => {
  it('runs through the shell in the given directory and captures both streams', async () => {
    const result = await runVerifyCommand('pwd && echo to-stdout && echo to-stderr >&2', dir)

    expect(result.exitCode).toBe(0)
    expect(result.timedOut).toBe(false)
    expect(result.output).toContain(dir.replace(/^\/private/, ''))
    expect(result.output).toContain('to-stdout')
    expect(result.output).toContain('to-stderr')
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('reports the exit code of a failing command with its output', async () => {
    const result = await runVerifyCommand('echo "2 errors found"; exit 3', dir)

    expect(result).toMatchObject({ exitCode: 3, timedOut: false, output: '2 errors found' })
  })

  it('stops at the first failing step of a chain', async () => {
    const result = await runVerifyCommand('false && echo never', dir)

    expect(result.exitCode).toBe(1)
    expect(result.output).toBe('')
  })

  it("uses the process environment, so the user's PATH applies", async () => {
    const result = await runVerifyCommand('echo "$DOCFLOW_PROBE:$PATH"', dir, {
      env: { DOCFLOW_PROBE: 'probe' }
    })

    expect(result.output).toBe(`probe:${process.env.PATH}`)
  })

  it("does not hand the app's own server variables to the command", async () => {
    const appVariables = {
      ELECTRON_RUN_AS_NODE: '1',
      HIVE_DESKTOP_BOOTSTRAP_TOKEN: 'secret-token',
      HIVE_SERVER_PORT: '4310'
    }
    const previous = Object.keys(appVariables).map((key) => [key, process.env[key]] as const)
    Object.assign(process.env, appVariables)
    try {
      const result = await runVerifyCommand(
        'echo "[${ELECTRON_RUN_AS_NODE-unset}][${HIVE_DESKTOP_BOOTSTRAP_TOKEN-unset}][${HIVE_SERVER_PORT-unset}][${HOME:+home}]"',
        dir
      )

      expect(result.output).toBe('[unset][unset][unset][home]')
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }

    expect(verifyEnvironment({ PATH: '/bin', HIVE_HEADLESS: '1', ...appVariables })).toEqual(
      { PATH: '/bin', HIVE_HEADLESS: '1' }
    )
  })

  it('strips ANSI escapes and keeps only the last state of a progress line', async () => {
    const result = await runVerifyCommand(
      String.raw`printf '\033[32mok\033[0m\n10%%\r50%%\r100%%\ndone\r\n'`,
      dir
    )

    expect(result.output).toBe('ok\n100%\ndone')
  })

  it('keeps only the tail of long output, starting on a whole line', async () => {
    const result = await runVerifyCommand(
      'i=1; while [ $i -le 3000 ]; do echo "line $i of the output"; i=$((i+1)); done',
      dir,
      { tailBytes: 1024 }
    )

    expect(result.exitCode).toBe(0)
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(1024)
    const lines = result.output.split('\n')
    expect(lines.at(-1)).toBe('line 3000 of the output')
    expect(lines[0]).toMatch(/^line \d+ of the output$/)
    expect(result.output).not.toContain('line 1 of the output\n')
  })

  it('kills the whole process group on a timeout', async () => {
    const marker = join(dir, 'survived')
    // The background child would write the marker if only the shell were killed.
    const result = await runVerifyCommand(
      `echo started; (sleep 2; touch "${marker}") & sleep 30`,
      dir,
      { timeoutMs: 300, killGraceMs: 200 }
    )

    expect(result.timedOut).toBe(true)
    expect(result.exitCode).toBeNull()
    expect(result.output).toContain('started')
    expect(result.output).toContain('Stopped: the command did not finish within 0.3 s.')
    expect(result.durationMs).toBeLessThan(10_000)
    await new Promise((resolve) => setTimeout(resolve, 2500))
    expect(existsSync(marker)).toBe(false)
  }, 20_000)

  it('does not wait for a background process the command left running', async () => {
    const started = Date.now()
    const result = await runVerifyCommand('sleep 20 & echo launched', dir)

    expect(result.exitCode).toBe(0)
    expect(result.output).toBe('launched')
    expect(Date.now() - started).toBeLessThan(10_000)
  }, 20_000)

  it('reports a command that cannot be started instead of throwing', async () => {
    const result = await runVerifyCommand('echo hi', join(dir, 'missing-directory'))

    expect(result.exitCode).toBeNull()
    expect(result.timedOut).toBe(false)
    expect(result.output).toContain('Could not start the command')
  })

  it('reports an unknown command through the shell exit code', async () => {
    const result = await runVerifyCommand('definitely-not-a-command-xyz --flag', dir)

    expect(result.exitCode).toBe(127)
    expect(result.output).toContain('definitely-not-a-command-xyz')
  })
})
