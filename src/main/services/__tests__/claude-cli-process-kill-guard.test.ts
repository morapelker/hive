// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  buildProtectedProcesses,
  evaluateProcessKillCommand,
  splitShellSegments,
  type ProcessKillDenial
} from '../claude-cli-process-kill-guard'

const protectedProcesses = buildProtectedProcesses({
  execPath: '/Applications/Hive.app/Contents/MacOS/Hive',
  platform: 'darwin',
  backendEntryPath: '/Applications/Hive.app/Contents/Resources/app.asar/out/main/server.js',
  userDataDir: '/Users/you/Library/Application Support/hive'
})

const judge = (command: string): ProcessKillDenial | null =>
  evaluateProcessKillCommand(command, protectedProcesses)

const OWN_APP = 'the Hive app you are running inside'
const OWN_BACKEND = 'the backend of the Hive app'
const CHROME = "the user's own Google Chrome"
const DRIVEN_BROWSERS = 'browsers other sessions and tools are driving'
const OTHER_ELECTRON = 'other Electron apps on this machine'
const DEV_ELECTRON = 'Electron apps running from a dev checkout'
const CLAUDE_SESSIONS = 'other Claude Code sessions'
const NODE = 'every Node.js process'

describe('evaluateProcessKillCommand: name-based kills that would reach protected processes', () => {
  it.each<[string, string]>([
    ['pkill -f electron', DEV_ELECTRON],
    ['pkill -f Electron', OTHER_ELECTRON],
    ['pkill -f chrome', DRIVEN_BROWSERS],
    ['pkill -if chrome', CHROME],
    ['pkill -f Chromium', DRIVEN_BROWSERS],
    ['pkill -f chrome-headless-shell', DRIVEN_BROWSERS],
    ['pkill -f ms-playwright', DRIVEN_BROWSERS],
    ['killall "Google Chrome"', CHROME],
    ['pkill -x "Google Chrome"', CHROME],
    ['killall Electron', OTHER_ELECTRON],
    ['killall -9 "Slack Helper (Renderer)"', OTHER_ELECTRON],
    ['pkill -f "Helper \\(Renderer\\)"', OWN_APP],
    ['pkill -fl Helper', OWN_APP],
    ['killall -m Helper', OWN_APP],
    ['pkill -f -- --type=renderer', OWN_APP],
    ['pkill -f type=renderer', OWN_APP],
    ['pkill -f gpu-process', OWN_APP],
    ['pkill -f user-data-dir', OWN_APP],
    ['pkill -f "Hive"', OWN_APP],
    ['pkill -f .', OWN_APP],
    ['pkill -f out/main/server.js', OWN_BACKEND],
    ['pkill -f server.js', OWN_BACKEND],
    ['pkill -f claude', CLAUDE_SESSIONS],
    ['killall node', NODE],
    ['pkill node', NODE],
    ["pkill -f 'electron/dist/Electron.app/Contents/MacOS/Electron'", DEV_ELECTRON],
    ['pkill -f "electron/dist/Electron.app/Contents/MacOS/Electron$"', DEV_ELECTRON]
  ])('denies %s', (command, victim) => {
    const denial = judge(command)
    expect(denial).not.toBeNull()
    expect(denial?.victim?.label).toContain(victim)
    expect(denial?.reason).toContain('Hive blocked this command')
    expect(denial?.reason).toContain('kill <pid>')
  })

  it.each([
    'sudo pkill -f electron',
    'nohup pkill -f chrome &',
    'cd /tmp && pkill -f chrome',
    'echo cleaning; pkill -f chrome; echo done',
    'timeout 5 pkill -9 -f chrome',
    'pkill -KILL -f chrome',
    'pkill -SIGTERM -f chrome',
    'pkill --signal TERM -f chrome',
    'env -u FOO pkill -f chrome',
    '/usr/bin/pkill -f chrome',
    'cat > /tmp/cleanup.sh <<\'EOF\'\npkill -f chrome\nEOF'
  ])('sees through prefixes and chains: %s', (command) => {
    expect(judge(command)).not.toBeNull()
  })

  it('names the offending part of a longer command', () => {
    const denial = judge('playwright-cli -s=x close; sleep 1; pkill -f Chromium; lsof -i :3000')
    expect(denial?.offender).toBe('pkill -f Chromium')
  })
})

describe('evaluateProcessKillCommand: listers feeding a kill', () => {
  it.each([
    'kill $(pgrep -f chrome)',
    'kill "$(pgrep -f Electron)"',
    'kill -9 `pgrep -f Chromium`',
    'pgrep -f chrome | xargs kill',
    'pgrep -f electron | xargs -r kill -9',
    'for p in $(pgrep -f Chromium); do kill $p; done',
    "ps aux | grep -i electron | grep -v grep | awk '{print $2}' | xargs kill -9",
    "ps -eo pid,command | grep '[E]lectron' | awk '{print $1}' | xargs kill",
    "ps aux | grep -E 'Chrome|Chromium' | grep -v grep | awk '{print $2}' | xargs kill"
  ])('denies %s', (command) => {
    const denial = judge(command)
    expect(denial).not.toBeNull()
    expect(denial?.reason).toContain('feeds `kill` with')
  })

  it.each([
    'pgrep -fl electron | head',
    'ps aux | grep electron',
    'ps aux | grep -i chrome | grep -v grep | wc -l',
    'pgrep -u mor | wc -l',
    'kill -0 $(pgrep -f electron) && echo alive',
    'until ! kill -0 $(pgrep -f electron | head -1) 2>/dev/null; do sleep 3; done',
    'grep -rn "pkill -f chrome" src',
    'grep -i electron /tmp/ps.txt; kill 1234'
  ])('allows a lister that does not drive a kill, or a kill with no process-table lister: %s', (command) => {
    expect(judge(command)).toBeNull()
  })
})

describe('evaluateProcessKillCommand: blanket kills', () => {
  it.each([
    ['kill -9 -1', 'kill -1'],
    ['kill -- -1', 'kill -1'],
    ['kill -s KILL -1', 'kill -1'],
    ['kill -TERM -1', 'kill -1'],
    ['pkill -u mor', 'pkill -u'],
    ['pkill -U 501', 'pkill -u'],
    ['killall -u mor', 'killall -u'],
    ['kill $(pgrep -u mor)', 'pgrep -u']
  ])('denies %s', (command, what) => {
    const denial = judge(command)
    expect(denial).not.toBeNull()
    expect(denial?.victim).toBeNull()
    expect(denial?.reason).toContain(what)
  })
})

describe('evaluateProcessKillCommand: scoped kills pass', () => {
  it.each([
    '',
    'echo hi',
    'kill 1234',
    'kill -9 1234 5678',
    'kill -TERM 1234',
    'kill -s TERM 1234',
    'kill -1 1234',
    'kill -l',
    'kill $(cat /tmp/dev.pid)',
    'lsof -ti :3000 | xargs kill -9',
    'lsof -nP -iTCP:9223 -sTCP:LISTEN -t | xargs -r kill',
    "pkill -f 'user-data-dir=/tmp/bugreport-25-chrome'",
    "pkill -f 'remote-debugging-port=9223'",
    "pkill -f 'next dev -p 3000'",
    'pkill -f "next-server"',
    "pkill -f 'node hostile-servers.mjs'",
    "pkill -f 'hive--ticket-ids/apps/shell/out/main/server.js'",
    "pkill -f '/Users/mor/.hive-worktrees/x/node_modules/.pnpm/electron'",
    'pkill -P 1234',
    'pkill -P $(cat /tmp/dev.pid)',
    'pkill -P 1234 -f chrome',
    'pkill -F /tmp/chrome.pid',
    'pkill -t ttys003',
    'playwright-cli -s=x close',
    'playwright-cli kill-all',
    'git commit -m "fix: stop using pkill -f electron"',
    'echo "pkill -f chrome" > notes.txt',
    'osascript -e \'tell application "Electron" to quit\''
  ])('allows %s', (command) => {
    expect(judge(command)).toBeNull()
  })
})

describe('buildProtectedProcesses', () => {
  it('derives the app, its helpers and its backend from the macOS bundle', () => {
    const names = protectedProcesses.map((p) => p.name)
    expect(names).toContain('Hive')
    expect(names).toContain('Hive Helper (Renderer)')
    expect(names).toContain('Hive Helper (GPU)')
    const renderer = protectedProcesses.find((p) => p.name === 'Hive Helper (Renderer)')
    expect(renderer?.commandLine).toContain(
      '/Applications/Hive.app/Contents/Frameworks/Hive Helper (Renderer).app/Contents/MacOS/Hive Helper (Renderer) --type=renderer'
    )
    expect(renderer?.commandLine).toContain('--user-data-dir=/Users/you/Library/Application Support/hive')
    const backend = protectedProcesses.find((p) => p.label.includes('backend'))
    expect(backend?.commandLine).toBe(
      '/Applications/Hive.app/Contents/MacOS/Hive /Applications/Hive.app/Contents/Resources/app.asar/out/main/server.js'
    )
  })

  it('covers a dev checkout (the binary is Electron itself)', () => {
    const dev = buildProtectedProcesses({
      execPath:
        '/Users/you/dev/hive/node_modules/.pnpm/electron@39.0.0/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
      platform: 'darwin',
      backendEntryPath: '/Users/you/dev/hive/apps/shell/out/main/server.js'
    })
    expect(dev[0]).toMatchObject({ name: 'Electron' })
    expect(evaluateProcessKillCommand('killall Electron', dev)?.victim?.label).toContain(
      'the Electron app you are running inside'
    )
    // A kill scoped to another worktree's build does not touch this one.
    expect(
      evaluateProcessKillCommand("pkill -f 'hive--feature/apps/shell/out/main/server.js'", dev)
    ).toBeNull()
  })

  it('falls back to flat command lines off macOS', () => {
    const linux = buildProtectedProcesses({ execPath: '/opt/hive/hive', platform: 'linux' })
    expect(linux[0]).toMatchObject({ name: 'hive', commandLine: '/opt/hive/hive' })
    expect(linux.some((p) => p.commandLine.includes('--type=renderer'))).toBe(true)
    expect(linux.some((p) => p.label.includes('backend'))).toBe(false)
    expect(evaluateProcessKillCommand('pkill hive', linux)).not.toBeNull()
  })
})

describe('splitShellSegments', () => {
  it('splits on control operators and substitutions, stripping quotes', () => {
    expect(splitShellSegments('kill "$(pgrep -f chrome)"')).toEqual([['kill'], ['pgrep', '-f', 'chrome']])
    expect(splitShellSegments("a 'b c' d\\ e | f && g; h || i & j")).toEqual([
      ['a', 'b c', 'd e'],
      ['f'],
      ['g'],
      ['h'],
      ['i'],
      ['j']
    ])
    expect(splitShellSegments('x=1 (cd /tmp; ls) `date`\nnext')).toEqual([
      ['x=1'],
      ['cd', '/tmp'],
      ['ls'],
      ['date'],
      ['next']
    ])
  })
})
