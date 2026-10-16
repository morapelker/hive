/**
 * Process-kill guard for agent shell commands.
 *
 * An agent cleaning up after itself reaches for `pkill -f chrome`, `killall
 * Electron`, `pkill -f "Helper (Renderer)"` or `ps | grep … | xargs kill`. Those
 * match by *name*, and the names are shared: every Electron app (this one
 * included) is a Chromium with `Helper (Renderer) --type=renderer …` children,
 * the user's own Chrome is "Google Chrome", Playwright's browsers are
 * "Chromium", and this app's backend is `<Electron binary> …/out/main/server.js`.
 * One such command takes the user's whole desktop down with it.
 *
 * The guard does not blocklist words. It extracts what the command would
 * signal — a `pkill`/`pgrep` regex, `killall` names, a `grep` feeding a kill, a
 * `kill -1` — and evaluates it the way the tool would, against a fixed set of
 * representative processes that are never the agent's to stop (built by
 * {@link buildProtectedProcesses}). A pattern that singles out the agent's own
 * instance (a worktree path, a port, a `--user-data-dir=/tmp/…` profile) matches
 * none of them and passes; a pattern that would sweep up anything in that set
 * is denied with a reason telling the agent what it would have hit and how to
 * scope the kill instead.
 *
 * Pure: no process access, no I/O. {@link getProtectedProcesses} is the only
 * entry point that reads the environment (this app's own binary and backend).
 */
import path from 'path'
import { resolveDesktopBackendEntryPath } from '../desktop/backend-config'

export interface ProtectedProcess {
  /** What the agent is told it would have killed. */
  label: string
  /** The process name as `pkill`/`killall` (without `-f`) see it. */
  name: string
  /** The full command line as `pkill -f`, `pgrep -f` and `ps` see it. */
  commandLine: string
}

export interface ProcessKillGuardContext {
  /** `process.execPath` of the app hosting the guard (an Electron binary). */
  execPath: string
  platform: NodeJS.Platform
  /** The script the app's backend runs (`…/out/main/server.js`), if known. */
  backendEntryPath?: string
  /** The Chromium profile dir of the app's renderers (`--user-data-dir=`). */
  userDataDir?: string
}

export interface ProcessKillDenial {
  /** The part of the command that was judged dangerous, e.g. `pkill -f chrome`. */
  offender: string
  /** The representative process it would have hit; null for blanket kills (`kill -1`). */
  victim: ProtectedProcess | null
  /** Text handed to the agent as the permission-decision reason. */
  reason: string
}

// ---------------------------------------------------------------------------
// Protected processes
// ---------------------------------------------------------------------------

const APP_SUPPORT = '/Users/you/Library/Application Support'

const CHROME_FRAMEWORK =
  '/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/140.0.0.0/Helpers'

/** Processes that exist on any developer machine, whatever this app is called. */
const STATIC_PROTECTED_PROCESSES: readonly ProtectedProcess[] = [
  // The user's browser: every window and tab they have open.
  {
    label: "the user's own Google Chrome (every window and tab they have open)",
    name: 'Google Chrome',
    commandLine: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  },
  {
    label: "the user's own Google Chrome (every window and tab they have open)",
    name: 'Google Chrome Helper (Renderer)',
    commandLine: `${CHROME_FRAMEWORK}/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer) --type=renderer --lang=en-US --user-data-dir=${APP_SUPPORT}/Google/Chrome`
  },
  // Browsers other sessions and tools are driving.
  {
    label: 'browsers other sessions and tools are driving (Playwright, playwright-cli, the devtools MCP)',
    name: 'Chromium',
    commandLine:
      '/Users/you/Library/Caches/ms-playwright/chromium-1200/chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium --disable-field-trial-config --remote-debugging-pipe --user-data-dir=/var/folders/zz/T/playwright_chromiumdev_profile-abc123 --no-first-run'
  },
  {
    label: 'browsers other sessions and tools are driving (Playwright, playwright-cli, the devtools MCP)',
    name: 'chrome-headless-shell',
    commandLine:
      '/Users/you/Library/Caches/ms-playwright/chromium_headless_shell-1200/chrome-headless-shell-mac-arm64/chrome-headless-shell --headless --remote-debugging-pipe --user-data-dir=/var/folders/zz/T/playwright_chromiumdev_profile-def456'
  },
  // Other Electron apps: a main process that is literally named "Electron"
  // (VS Code), and the Chromium helper tree every Electron app has.
  {
    label: 'other Electron apps on this machine (VS Code, Slack, Discord, …)',
    name: 'Electron',
    commandLine: '/Applications/Visual Studio Code.app/Contents/MacOS/Electron'
  },
  {
    label: 'other Electron apps on this machine (VS Code, Slack, Discord, …)',
    name: 'Slack Helper (Renderer)',
    commandLine: `/Applications/Slack.app/Contents/Frameworks/Slack Helper (Renderer).app/Contents/MacOS/Slack Helper (Renderer) --type=renderer --user-data-dir=${APP_SUPPORT}/Slack --app-path=/Applications/Slack.app/Contents/Resources/app.asar --enable-sandbox --lang=en-US`
  },
  {
    label: 'other Electron apps on this machine (VS Code, Slack, Discord, …)',
    name: 'Code Helper (GPU)',
    commandLine: `/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (GPU).app/Contents/MacOS/Code Helper (GPU) --type=gpu-process --user-data-dir=${APP_SUPPORT}/Code`
  },
  {
    label: 'other Electron apps on this machine (VS Code, Slack, Discord, …)',
    name: 'Code Helper (Plugin)',
    commandLine: `/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin) --type=utility --utility-sub-type=node.mojom.NodeService --lang=en-US`
  },
  // Electron apps running from a dev checkout (`pnpm dev` of any project).
  {
    label: "Electron apps running from a dev checkout (any project's `pnpm dev`, including the user's)",
    name: 'Electron',
    commandLine:
      '/Users/you/dev/some-app/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
  },
  {
    label: "Electron apps running from a dev checkout (any project's `pnpm dev`, including the user's)",
    name: 'Electron',
    commandLine:
      '/Users/you/dev/some-app/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron /Users/you/dev/some-app/out/main/index.js'
  },
  {
    label: "Electron apps running from a dev checkout (any project's `pnpm dev`, including the user's)",
    name: 'Electron Helper (Renderer)',
    commandLine: `/Users/you/dev/some-app/node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Helper (Renderer).app/Contents/MacOS/Electron Helper (Renderer) --type=renderer --user-data-dir=${APP_SUPPORT}/some-app`
  },
  // Other Claude Code sessions (and this one).
  {
    label: 'other Claude Code sessions running in this app (and this one)',
    name: 'claude',
    commandLine:
      '/Users/you/.local/bin/claude --dangerously-skip-permissions --settings {"hooks":{"SessionStart":[{"hooks":[{"type":"http","url":"http://127.0.0.1:50000/hook/00000000-0000-0000-0000-000000000000/session"}]}]}}'
  },
  // Every Node.js process: other sessions' dev servers, MCP servers, tooling.
  {
    label: "every Node.js process on this machine (other sessions' dev servers, MCP servers, this app's tooling)",
    name: 'node',
    commandLine: '/usr/local/bin/node'
  }
]

/**
 * The processes a kill from inside this app must never reach: this app's own
 * process tree (derived from its binary, whatever the app is called or wherever
 * it runs from), then the static set above.
 */
export function buildProtectedProcesses(ctx: ProcessKillGuardContext): ProtectedProcess[] {
  const own: ProtectedProcess[] = []
  const execPath = ctx.execPath
  const exeName = path.basename(execPath)
  const bundleMatch =
    ctx.platform === 'darwin' ? /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath) : null
  const userDataDir = ctx.userDataDir ?? `${APP_SUPPORT}/${exeName}`
  const appLabel = `the ${exeName} app you are running inside (its window would die)`
  const backendLabel = `the backend of the ${exeName} app you are running inside (the app would stop working)`

  own.push({ label: appLabel, name: exeName, commandLine: execPath })
  if (ctx.backendEntryPath) {
    own.push({
      label: backendLabel,
      name: exeName,
      commandLine: `${execPath} ${ctx.backendEntryPath}`
    })
  }

  if (bundleMatch) {
    const bundle = bundleMatch[1]
    const helper = (suffix: string): string =>
      `${bundle}/Contents/Frameworks/${exeName} Helper${suffix}.app/Contents/MacOS/${exeName} Helper${suffix}`
    own.push(
      {
        label: appLabel,
        name: `${exeName} Helper (Renderer)`,
        commandLine: `${helper(' (Renderer)')} --type=renderer --user-data-dir=${userDataDir} --app-path=${bundle}/Contents/Resources/app.asar --enable-sandbox --lang=en-US --field-trial-handle=1718379636,r,123 --seatbelt-client=25`
      },
      {
        label: appLabel,
        name: `${exeName} Helper (GPU)`,
        commandLine: `${helper(' (GPU)')} --type=gpu-process --user-data-dir=${userDataDir} --gpu-preferences=UAAAAAAAAAAgAAAEAAAAAAAAAAAAAAAAAABgAAEAAAA --lang=en-US`
      },
      {
        label: appLabel,
        name: `${exeName} Helper`,
        commandLine: `${helper('')} --type=utility --utility-sub-type=node.mojom.NodeService --lang=en-US --service-sandbox-type=none --user-data-dir=${userDataDir}`
      }
    )
  } else {
    own.push(
      {
        label: appLabel,
        name: exeName,
        commandLine: `${execPath} --type=renderer --user-data-dir=${userDataDir} --lang=en-US`
      },
      {
        label: appLabel,
        name: exeName,
        commandLine: `${execPath} --type=gpu-process --user-data-dir=${userDataDir} --lang=en-US`
      }
    )
  }

  return [...own, ...STATIC_PROTECTED_PROCESSES]
}

let cachedProtectedProcesses: ProtectedProcess[] | null = null

/** The protected set for the running app, built once from `process`. */
export function getProtectedProcesses(): ProtectedProcess[] {
  if (cachedProtectedProcesses) return cachedProtectedProcesses
  let backendEntryPath: string | undefined
  try {
    backendEntryPath = resolveDesktopBackendEntryPath(__dirname)
  } catch {
    backendEntryPath = undefined
  }
  cachedProtectedProcesses = buildProtectedProcesses({
    execPath: process.execPath,
    platform: process.platform,
    backendEntryPath
  })
  return cachedProtectedProcesses
}

export function __resetProtectedProcessesForTests(): void {
  cachedProtectedProcesses = null
}

// ---------------------------------------------------------------------------
// Shell parsing
// ---------------------------------------------------------------------------

/**
 * Splits a shell command into simple commands and tokenizes each one with
 * quotes removed. Boundaries are the control operators (`|`, `||`, `&&`, `;`,
 * `&`, newline), subshell and substitution parens (`(`, `)`, `$(`, backticks).
 * Heredoc bodies and redirections come through as plain words, which is fine:
 * only the first word of each segment and the words that follow it are read.
 */
export function splitShellSegments(command: string): string[][] {
  const segments: string[][] = []
  let words: string[] = []
  let word = ''
  let hasWord = false
  // Quote state is saved on entering `$(`/`(` so a substitution inside a
  // double-quoted string ("$(pgrep -f chrome)") is still read as a command.
  const stack: Array<{ single: boolean; double: boolean }> = []
  let single = false
  let double = false

  const endWord = (): void => {
    if (hasWord) words.push(word)
    word = ''
    hasWord = false
  }
  const endSegment = (): void => {
    endWord()
    if (words.length > 0) segments.push(words)
    words = []
  }

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]
    const next = command[i + 1]

    if (single) {
      if (ch === "'") single = false
      else word += ch
      continue
    }

    if (double) {
      if (ch === '"') {
        double = false
      } else if (ch === '\\' && next !== undefined && '"\\$`'.includes(next)) {
        word += next
        i += 1
      } else if (ch === '$' && next === '(') {
        // The quotes opened a word, but what precedes the substitution is
        // not one unless something was typed (`"$(…)"` is not `"" $(…)`).
        if (word === '') hasWord = false
        stack.push({ single, double })
        double = false
        endSegment()
        i += 1
      } else if (ch === '`') {
        if (word === '') hasWord = false
        endSegment()
      } else {
        word += ch
      }
      continue
    }

    if (ch === "'") {
      single = true
      hasWord = true
    } else if (ch === '"') {
      double = true
      hasWord = true
    } else if (ch === '\\') {
      if (next !== undefined && next !== '\n') {
        word += next
        hasWord = true
      }
      i += 1
    } else if (ch === '$' && next === '(') {
      stack.push({ single, double })
      endSegment()
      i += 1
    } else if (ch === '(') {
      stack.push({ single, double })
      endSegment()
    } else if (ch === ')') {
      endSegment()
      const saved = stack.pop()
      if (saved) {
        single = saved.single
        double = saved.double
      }
    } else if (ch === '`') {
      endSegment()
    } else if (ch === '|' || ch === '&' || ch === ';' || ch === '\n') {
      endSegment()
      if ((ch === '|' || ch === '&') && next === ch) i += 1
    } else if (ch === ' ' || ch === '\t' || ch === '\r') {
      endWord()
    } else {
      word += ch
      hasWord = true
    }
  }
  endSegment()
  return segments
}

/** Words that may precede the actual command in a segment. */
const PREFIX_WORDS = new Set([
  'sudo',
  'doas',
  'nohup',
  'exec',
  'command',
  'builtin',
  'time',
  'timeout',
  'env',
  'xargs',
  'nice',
  'ionice',
  'do',
  'then',
  'else',
  'elif',
  'if',
  'while',
  'until',
  '!',
  '{',
  '}',
  '{}'
])

/** Short flags of a prefix word that take the next word as their value. */
const PREFIX_VALUE_FLAGS: Record<string, string> = {
  sudo: 'ugpCDrtTUh',
  doas: 'uC',
  env: 'uCS',
  timeout: 'sk',
  xargs: 'InPLdaEsJRS',
  nice: 'n',
  ionice: 'cnp',
  exec: 'a'
}

/** Long flags of a prefix word that take the next word as their value (`--flag value`). */
const PREFIX_VALUE_LONG_FLAGS = new Set([
  'user',
  'group',
  'chdir',
  'unset',
  'signal',
  'kill-after',
  'max-args',
  'max-procs',
  'max-lines',
  'max-chars',
  'delimiter',
  'arg-file',
  'eof',
  'replace',
  'adjustment'
])

/** Returns the command word of a segment and the arguments after it. */
function commandOf(segment: readonly string[]): { name: string; args: string[] } | null {
  let i = 0
  let prefix: string | null = null
  while (i < segment.length) {
    const w = segment[i]
    if (PREFIX_WORDS.has(w)) {
      prefix = w
      i += 1
      continue
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || /^\d+(\.\d+)?[smhd]?$/.test(w)) {
      // VAR=value, or `timeout 20`.
      i += 1
      continue
    }
    if (w.startsWith('--') && w.length > 2) {
      // A prefix's long flag (`xargs --max-args 1`, `sudo --user root`).
      i += !w.includes('=') && PREFIX_VALUE_LONG_FLAGS.has(w.slice(2)) ? 2 : 1
      continue
    }
    if (w.startsWith('-') && w.length > 1) {
      // A prefix's short flag (`sudo -n`, `xargs -r`); `env -u X` / `xargs -I {}`
      // also take the next word.
      const takesValue =
        w.length === 2 && prefix !== null && (PREFIX_VALUE_FLAGS[prefix] ?? '').includes(w[1])
      i += takesValue ? 2 : 1
      continue
    }
    break
  }
  if (i >= segment.length) return null
  return { name: path.basename(segment[i]), args: segment.slice(i + 1) }
}

// ---------------------------------------------------------------------------
// Kill-target extraction
// ---------------------------------------------------------------------------

interface PatternTarget {
  kind: 'pattern'
  /** `pkill`, `pgrep`, `killall`, `grep`. */
  tool: string
  /** The regex (or literal name) as given. */
  pattern: string
  /** Matches against the full command line (`-f`, `grep` over `ps`) or the process name. */
  fullCommandLine: boolean
  /** How the pattern is interpreted. */
  syntax: 'ere' | 'bre' | 'literal'
  ignoreCase: boolean
  /** Whole-string match (`pkill -x`, `killall` without `-m`). */
  exact: boolean
  /** The tool itself signals (pkill/killall) vs. only lists (pgrep/grep). */
  kills: boolean
  offender: string
}

interface BlanketTarget {
  kind: 'blanket'
  offender: string
  /** Why it is blanket: `kill -1`, `pkill -u`. */
  what: string
  /** The tool itself signals (kill/pkill/killall) vs. only lists (pgrep). */
  kills: boolean
}

type KillTarget = PatternTarget | BlanketTarget

const SIGNAL_TOKEN = /^-(\d+|(SIG)?[A-Z][A-Z0-9]+)$/
const SIGNAL_VALUE = /^(\d+|(SIG)?[A-Z][A-Z0-9]+)$/

function isPkillLike(name: string): boolean {
  return name === 'pkill' || name === 'pgrep'
}

/** `pkill`/`pgrep`: a regex over the name or (with `-f`) the full command line. */
function parsePkill(name: string, args: readonly string[], offender: string): KillTarget[] {
  const valueFlags = new Set(['d', 'F', 'g', 'G', 'P', 's', 't', 'u', 'U', 'j', 'ns', 'nslist'])
  let full = false
  let ignoreCase = false
  let exact = false
  let userScoped = false
  // -P/-g/-s/-t/-F narrow the match to a parent, group, session, tty or
  // pidfile: whatever the pattern says, the kill cannot sweep the machine.
  let narrowed = false
  let pattern: string | null = null
  let i = 0
  while (i < args.length) {
    const a = args[i]
    i += 1
    if (a === '--') {
      if (pattern === null && i < args.length) pattern = args[i]
      break
    }
    if (a.startsWith('--')) {
      const [flag] = a.slice(2).split('=')
      if (flag === 'full') full = true
      else if (flag === 'ignore-case') ignoreCase = true
      else if (flag === 'exact') exact = true
      else if (flag === 'uid' || flag === 'euid') userScoped = true
      else if (['parent', 'pgroup', 'session', 'terminal', 'pidfile'].includes(flag)) narrowed = true
      if (
        !a.includes('=') &&
        ['signal', 'uid', 'euid', 'parent', 'pgroup', 'session', 'terminal', 'pidfile', 'delimiter', 'ns', 'nslist'].includes(flag)
      ) {
        i += 1
      }
      continue
    }
    if (SIGNAL_TOKEN.test(a)) continue
    if (a.startsWith('-') && a.length > 1) {
      const letters = a.slice(1)
      for (let k = 0; k < letters.length; k += 1) {
        const l = letters[k]
        if (l === 'f') full = true
        else if (l === 'i') ignoreCase = true
        else if (l === 'x') exact = true
        else if (l === 'u' || l === 'U') userScoped = true
        else if (l === 'P' || l === 'g' || l === 's' || l === 't' || l === 'F') narrowed = true
        if (valueFlags.has(l)) {
          // The value is the rest of this token or the next one.
          if (k === letters.length - 1) i += 1
          break
        }
      }
      continue
    }
    if (pattern === null) pattern = a
  }

  if (narrowed) return []
  const kills = name === 'pkill'
  if (pattern === null) {
    if (userScoped) {
      return [
        {
          kind: 'blanket',
          offender,
          what: `\`${name} -u\` with no pattern ${kills ? 'signals' : 'lists'} every process that user owns`,
          kills
        }
      ]
    }
    return []
  }
  return [
    {
      kind: 'pattern',
      tool: name,
      pattern,
      fullCommandLine: full,
      syntax: 'ere',
      ignoreCase,
      exact,
      kills,
      offender
    }
  ]
}

/** `killall`: exact process names (regexes with `-m`/`-r`). */
function parseKillall(args: readonly string[], offender: string): KillTarget[] {
  let regex = false
  let ignoreCase = false
  let userScoped = false
  const names: string[] = []
  let i = 0
  while (i < args.length) {
    const a = args[i]
    i += 1
    if (a === '--') {
      names.push(...args.slice(i))
      break
    }
    if (a.startsWith('--')) {
      const [flag] = a.slice(2).split('=')
      if (flag === 'regexp') regex = true
      else if (flag === 'ignore-case') ignoreCase = true
      else if (flag === 'user') userScoped = true
      if (!a.includes('=') && ['signal', 'user', 'ns', 'older-than', 'younger-than', 'context'].includes(flag)) i += 1
      continue
    }
    if (SIGNAL_TOKEN.test(a)) continue
    if (a.startsWith('-') && a.length > 1) {
      const letters = a.slice(1)
      for (let k = 0; k < letters.length; k += 1) {
        const l = letters[k]
        if (l === 'm' || l === 'r') regex = true
        else if (l === 'I') ignoreCase = true
        else if (l === 'u') userScoped = true
        if (l === 'u' || l === 't' || l === 'c' || l === 'n' || l === 'o' || l === 'y' || l === 'Z') {
          if (k === letters.length - 1) i += 1
          break
        }
        if (l === 's') {
          // GNU: `-s SIGNAL`; BSD: a bare "show only" flag. Consume a value
          // only when one is there to consume.
          if (k === letters.length - 1 && i < args.length && SIGNAL_VALUE.test(args[i])) i += 1
          break
        }
      }
      continue
    }
    names.push(a)
  }

  if (names.length === 0) {
    if (userScoped) {
      return [
        {
          kind: 'blanket',
          offender,
          what: '`killall -u` with no process name signals every process that user owns',
          kills: true
        }
      ]
    }
    return []
  }
  return names.map((n) => ({
    kind: 'pattern' as const,
    tool: 'killall',
    pattern: n,
    fullCommandLine: false,
    syntax: regex ? ('ere' as const) : ('literal' as const),
    ignoreCase,
    // A plain name is compared whole; `-m`/`-r` regexes search the name.
    exact: !regex,
    kills: true,
    offender
  }))
}

/**
 * `kill`: a sink for PIDs found elsewhere in the command, or a blanket kill
 * when a PID is `-1` (every process the user can signal).
 */
function parseKill(args: readonly string[], offender: string): { target: KillTarget | null; sink: boolean } {
  let i = 0
  let signalSeen = false
  let listOnly = false
  let probe = false
  const pids: string[] = []
  while (i < args.length) {
    const a = args[i]
    i += 1
    if (a === '--') {
      pids.push(...args.slice(i))
      break
    }
    if (a === '-l' || a === '-L' || a === '--list' || a === '--table') {
      listOnly = true
      continue
    }
    if (a === '-s' || a === '--signal' || a === '-n') {
      if (i < args.length && args[i] === '0') probe = true
      signalSeen = true
      i += 1
      continue
    }
    if (a.startsWith('--signal=')) {
      if (a.endsWith('=0')) probe = true
      signalSeen = true
      continue
    }
    if (!signalSeen && pids.length === 0 && SIGNAL_TOKEN.test(a)) {
      // The first `-N`/`-NAME` is the signal (`kill -1 1234` is SIGHUP to 1234).
      if (a === '-0') probe = true
      signalSeen = true
      continue
    }
    pids.push(a)
  }
  if (listOnly || probe) return { target: null, sink: false }
  if (pids.includes('-1')) {
    return {
      target: {
        kind: 'blanket',
        offender,
        what: '`kill -1` signals every process the user can reach',
        kills: true
      },
      sink: true
    }
  }
  return { target: null, sink: true }
}

/** `grep` over `ps` output: like `pgrep -f`, but it only lists. */
function parseGrep(name: string, args: readonly string[], offender: string): KillTarget[] {
  let syntax: PatternTarget['syntax'] = name === 'egrep' ? 'ere' : name === 'fgrep' ? 'literal' : 'bre'
  let ignoreCase = false
  let invert = false
  let exact = false
  let pattern: string | null = null
  const valueFlags = new Set(['A', 'B', 'C', 'm', 'd', 'D', 'f'])
  let i = 0
  while (i < args.length) {
    const a = args[i]
    i += 1
    if (a === '--') {
      if (pattern === null && i < args.length) pattern = args[i]
      break
    }
    if (a.startsWith('--')) {
      const [flag, value] = a.slice(2).split('=')
      if (flag === 'extended-regexp') syntax = 'ere'
      else if (flag === 'fixed-strings') syntax = 'literal'
      else if (flag === 'basic-regexp') syntax = 'bre'
      else if (flag === 'perl-regexp') syntax = 'ere'
      else if (flag === 'ignore-case') ignoreCase = true
      else if (flag === 'invert-match') invert = true
      else if (flag === 'line-regexp') exact = true
      else if (flag === 'regexp') {
        if (value !== undefined) pattern = pattern ?? value
        else {
          pattern = pattern ?? args[i]
          i += 1
        }
      }
      continue
    }
    if (a.startsWith('-') && a.length > 1) {
      const letters = a.slice(1)
      for (let k = 0; k < letters.length; k += 1) {
        const l = letters[k]
        if (l === 'E' || l === 'P') syntax = 'ere'
        else if (l === 'F') syntax = 'literal'
        else if (l === 'G') syntax = 'bre'
        else if (l === 'i' || l === 'y') ignoreCase = true
        else if (l === 'v') invert = true
        else if (l === 'x') exact = true
        else if (l === 'e') {
          const rest = letters.slice(k + 1)
          if (rest) pattern = pattern ?? rest
          else {
            pattern = pattern ?? args[i]
            i += 1
          }
          break
        }
        if (valueFlags.has(l)) {
          if (k === letters.length - 1) i += 1
          break
        }
      }
      continue
    }
    if (pattern === null) pattern = a
  }
  if (invert || pattern === null) return []
  return [
    {
      kind: 'pattern',
      tool: name,
      pattern,
      fullCommandLine: true,
      syntax,
      ignoreCase,
      exact,
      kills: false,
      offender
    }
  ]
}

interface ExtractedTargets {
  targets: KillTarget[]
  /** The command contains a `kill` that would signal PIDs found by a lister. */
  hasKillSink: boolean
  /** The command reads the process table (`ps`), so a `grep` in it is over processes. */
  readsProcessTable: boolean
}

function extractKillTargets(command: string): ExtractedTargets {
  const targets: KillTarget[] = []
  let hasKillSink = false
  let readsProcessTable = false
  for (const segment of splitShellSegments(command)) {
    const cmd = commandOf(segment)
    if (!cmd) continue
    const offender = [cmd.name, ...cmd.args].join(' ')
    if (isPkillLike(cmd.name)) {
      targets.push(...parsePkill(cmd.name, cmd.args, offender))
    } else if (cmd.name === 'killall') {
      targets.push(...parseKillall(cmd.args, offender))
    } else if (cmd.name === 'kill') {
      const parsed = parseKill(cmd.args, offender)
      if (parsed.target) targets.push(parsed.target)
      if (parsed.sink) hasKillSink = true
    } else if (cmd.name === 'grep' || cmd.name === 'egrep' || cmd.name === 'fgrep') {
      targets.push(...parseGrep(cmd.name, cmd.args, offender))
    } else if (cmd.name === 'ps') {
      readsProcessTable = true
    }
  }
  return { targets, hasKillSink, readsProcessTable }
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
}

/** POSIX BRE → JS: `\(`, `\)`, `\{`, `\}`, `\|`, `\+`, `\?` are the operators; bare ones are literal. */
function breToJs(pattern: string): string {
  let out = ''
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]
    if (ch === '\\' && i + 1 < pattern.length) {
      const next = pattern[i + 1]
      out += '(){}|+?'.includes(next) ? next : `\\${next}`
      i += 1
    } else if ('(){}|+?'.includes(ch)) {
      out += `\\${ch}`
    } else {
      out += ch
    }
  }
  return out
}

function toRegExp(target: PatternTarget): RegExp {
  const flags = target.ignoreCase ? 'i' : ''
  let source: string
  if (target.syntax === 'literal') source = escapeRegex(target.pattern)
  else if (target.syntax === 'bre') source = breToJs(target.pattern)
  else source = target.pattern
  if (target.exact) source = `^(?:${source})$`
  try {
    return new RegExp(source, flags)
  } catch {
    // Not a regex JS understands (POSIX classes, `\<`): fall back to the literal text.
    const literal = escapeRegex(target.pattern)
    return new RegExp(target.exact ? `^(?:${literal})$` : literal, flags)
  }
}

function findVictim(
  target: PatternTarget,
  protectedProcesses: readonly ProtectedProcess[]
): ProtectedProcess | null {
  if (target.pattern.length === 0) return protectedProcesses[0] ?? null
  const re = toRegExp(target)
  for (const p of protectedProcesses) {
    if (re.test(target.fullCommandLine ? p.commandLine : p.name)) return p
  }
  return null
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`
}

const HOW_TO_SCOPE =
  'Stop only what you started, by PID: list candidates with `pgrep -fl \'<a path, port or --user-data-dir unique to your own instance>\'` (or `lsof -ti :<port>` for a server), check the list, then `kill <pid>`. ' +
  'Browsers you opened with playwright-cli: `playwright-cli -s=<session> close`. ' +
  'If the user really wants every matching process gone, ask them to run the command themselves.'

/**
 * Judges one shell command. Returns a denial when it would signal a protected
 * process (or everything), null when it is scoped enough to let through.
 */
export function evaluateProcessKillCommand(
  command: string,
  protectedProcesses: readonly ProtectedProcess[]
): ProcessKillDenial | null {
  const { targets, hasKillSink, readsProcessTable } = extractKillTargets(command)
  for (const target of targets) {
    // A lister (pgrep, grep over ps) only matters when its PIDs go to a kill.
    if (!target.kills) {
      if (!hasKillSink) continue
      if (target.kind === 'pattern' && target.tool !== 'pgrep' && !readsProcessTable) continue
    }
    if (target.kind === 'blanket') {
      return {
        offender: target.offender,
        victim: null,
        reason:
          `Hive blocked this command: ${target.what}, including this app and every other Claude session. ` +
          HOW_TO_SCOPE
      }
    }
    const victim = findVictim(target, protectedProcesses)
    if (!victim) continue
    const matchedOn = target.fullCommandLine ? 'command line' : 'process name'
    const example = truncate(target.fullCommandLine ? victim.commandLine : victim.name, 160)
    const verb = target.kills ? 'would also kill' : 'feeds `kill` with'
    return {
      offender: target.offender,
      victim,
      reason:
        `Hive blocked this command: \`${truncate(target.offender, 120)}\` ${verb} ${victim.label}. ` +
        `Its ${matchedOn} matches too, for example \`${example}\`. ` +
        HOW_TO_SCOPE
    }
  }
  return null
}
