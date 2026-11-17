// @vitest-environment node
/**
 * Live check of live usage for Code Mode sessions, against the REAL `claude` binary and the
 * real Anthropic API (Code Mode T21; PRD section 13, "Live, opt-in"). It is the check to run
 * when a new version of the Claude CLI ships: the usage of a Code Mode session is read from
 * the CLI's own debug log, whose format is the CLI's to change.
 *
 * Opt-in, from the repository root:
 *
 *   CODE_MODE_USAGE_LIVE=1 pnpm exec vitest run --project main src/main/services/claude-debug-log/__tests__/claude-code-mode-usage.live.test.ts
 *
 * Without `CODE_MODE_USAGE_LIVE=1` it is skipped, and none of the app's modules is loaded.
 *
 * Needs `claude` on PATH (or its path in `CLAUDE_BIN`), signed in to a claude.ai subscription
 * that has accepted Code Mode once, and network. It runs ONE tiny prompt on haiku
 * (`CODE_MODE_USAGE_LIVE_MODEL` picks another model) and one shell command typed into the
 * session, which the CLI follows with a turn of its own that is cut short when the session is
 * closed. So it costs a few tokens of the signed-in account, and it makes one profile request
 * with that account's access token.
 *
 * It starts an interactive session the way the app does, through `createClaudeCliTerminal`:
 * Code Mode asked for in Settings → Environment Variables, the app's API proxy "running" (its
 * address on the environment every PTY inherits), the prompt on the command line, a real PTY.
 * It waits for the answer, then proves the chain end to end:
 *  - the launch is taken off the proxy and put on the debug log, and the session's screen
 *    says "Code Mode (experimental) is on";
 *  - the session's log receives a `response start` entry;
 *  - the app's follower and parser turn it into a usage reading with a weekly window;
 *  - the reading's organization is the one the app learns for the signed-in account from
 *    that account's own token, so the live updater credits the reading to that account;
 *  - a shell command run inside the session does not see `ANTHROPIC_LOG` (`printenv
 *    ANTHROPIC_LOG` prints nothing): the launch's environment file takes it out again;
 *  - nothing was sent to the proxy's address;
 *  - after the session is closed and its process has ended, no file of it remains.
 *
 * When the CLI is missing, nobody is signed in, or the CLI does not turn Code Mode on, it
 * fails with a message that says so, and never by running into the test timeout.
 *
 * What is real: the CLI, the PTY, the transport decision, the launch directory, the spawn
 * arguments, the log follower and parser, the live usage updater, the organization learner
 * and its request. What is not: the database (a stub with one session, in a temporary
 * folder, and an account table in memory), the hook server and the renderer. Its launch
 * directory is in a temporary place, never beside the app's data.
 *
 * It writes nothing of its own to the developer's Claude files but one thing the app does
 * for every session folder: it marks its temporary folder as trusted in `~/.claude.json`
 * (the CLI would otherwise stop at its folder-trust dialog). The CLI itself keeps its usual
 * record of the session under `~/.claude`. The session runs in that empty folder with the
 * options the app gives a session in build mode, `--dangerously-skip-permissions` among them.
 * It answers no dialog: when the CLI asks for consent to Code Mode, the test stops and says
 * how to give it. It never prints a token, an e-mail address, a log line, or more than the
 * first 8 characters of an organization id.
 */
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync
} from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { ClaudeLiveUsagePayload } from '@shared/types/claude-live-usage'
import type { SavedUsageAccount, Session } from '../../../db/types'
import type { ClaudeUsageObservation } from '../../claude-api-proxy/claude-usage-live-updater'

const LIVE = process.env.CODE_MODE_USAGE_LIVE === '1'
const MODEL = process.env.CODE_MODE_USAGE_LIVE_MODEL ?? 'haiku'
const CLAUDE_BIN = process.env.CLAUDE_BIN?.trim() || null

const describeLive = LIVE ? describe : describe.skip

const SESSION_ID = `code-mode-live-${Date.now().toString(36)}`
// The answer is a word the prompt does not contain, so that the answer on the screen cannot
// be taken for the prompt that is shown above it.
const PROMPT =
  'Join these letters into one word and reply with that word only, in capitals: Z E B R A F I S H'
const REPLY = /ZEBRAFISH/i
// Typed into the session's shell mode. Short enough to stay on one row of the input.
const SHELL_OUTPUT_FILE = 'debug-variable.txt'
const SHELL_COMMAND = `printenv ANTHROPIC_LOG > ${SHELL_OUTPUT_FILE}; echo "exit=$?" >> ${SHELL_OUTPUT_FILE}`
const CODE_MODE_VARIABLE = 'CLAUDE_CODE_EXPERIMENTAL_CODE_MODE'
const KILL_SWITCH_VARIABLE = 'HIVE_DISABLE_CLAUDE_DEBUG_USAGE'

// Every wait has its own limit and reason; together they stay under the test's timeout.
const CODE_MODE_WAIT_MS = 60_000
const REPLY_WAIT_MS = 90_000
const RESPONSE_ENTRY_WAIT_MS = 20_000
const READING_WAIT_MS = 20_000
const ATTRIBUTION_WAIT_MS = 45_000
const QUIET_WAIT_MS = 30_000
const TYPING_WAIT_MS = 10_000
const SHELL_WAIT_MS = 30_000
const EXIT_WAIT_MS = 30_000
const TEST_TIMEOUT_MS = 420_000
/** A screen that has not changed for this long shows a session at rest: a turn animates. */
const QUIET_MS = 1_500
/** Between the key that opens shell mode and the command typed into it. */
const KEY_PAUSE_MS = 500
/** A session that has its first answer from the API has long printed its Code Mode notice. */
const NOTICE_GRACE_AFTER_RESPONSE_MS = 5_000

const live = vi.hoisted(() => ({
  /** The database the app reads, once the test has made it. */
  db: null as unknown,
  /** What the app's modules warned about: component and message, never their data. */
  problems: [] as string[]
}))

vi.mock('../../logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../logger')>()
  const quiet = (component: string): ReturnType<typeof actual.createLogger> => ({
    debug: () => {},
    info: () => {},
    warn: (message) => void live.problems.push(`${component}: ${message}`),
    error: (message) => void live.problems.push(`${component}: ${message}`)
  })
  return { ...actual, createLogger: (options: { component: string }) => quiet(options.component) }
})

vi.mock('../../../db', () => ({ getDatabase: () => live.db }))

// The hook server reports a session's turns to the rest of the app (the database, telemetry).
// None of that is under test, and none of it may run against a stub.
vi.mock('../../claude-hook-server', () => ({
  getClaudeHookServer: async () => ({ port: 9 }),
  closeClaudeHookServer: async () => {},
  buildClaudeCliHookSettings: () => JSON.stringify({ hooks: {} }),
  mapHookEventToStatus: () => null,
  captureClaudeCliSessionId: () => {},
  __resetClaudeCliSessionIdCaptureForTests: () => {},
  publishClaudeCliStatus: () => {},
  resetClaudeCliBackgroundWork: () => {},
  getLastClaudeCliStatus: () => undefined,
  clearClaudeCliStatus: () => {},
  subscribeClaudeCliStatus: () => () => {},
  subscribeCliHookEvents: () => () => {}
}))

// Finds the session's transcript under the developer's ~/.claude to store its id: no row to
// store it in.
vi.mock('../../claude-session-watcher', () => ({
  watchForClaudeSessionId: () => ({ close: () => {} })
}))

// Terminal output and status go to the renderer through this; there is none.
vi.mock('../../../desktop/backend-event-publisher', () => ({
  publishDesktopBackendEvent: async () => true
}))

// The native terminal module is not built for a test run.
vi.mock('../../ghostty-service', () => ({ ghosttyService: { shutdown: () => {} } }))
vi.mock('../../ghostty-config', () => ({ parseGhosttyConfig: () => ({}) }))

// The app's own lookup (`claude` on PATH), unless CLAUDE_BIN names the binary.
vi.mock('../../claude-binary-resolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../claude-binary-resolver')>()
  return {
    ...actual,
    resolveClaudeBinaryPath: () =>
      CLAUDE_BIN ? (existsSync(CLAUDE_BIN) ? CLAUDE_BIN : null) : actual.resolveClaudeBinaryPath()
  }
})

/** Everything of the app the check uses, loaded only when it runs. */
async function loadApp() {
  const [
    bridge,
    pty,
    launchesLive,
    debugDir,
    usageSource,
    entryParser,
    liveUpdater,
    proxyEnv,
    learner,
    usageService,
    accountStore,
    binaryResolver,
    session,
    settings,
    dbTypes
  ] = await Promise.all([
    import('../../terminal-pty-bridge'),
    import('../../pty-service'),
    import('../../claude-cli-usage-launches-live'),
    import('../../claude-cli-debug-dir'),
    import('../claude-debug-log-usage-source'),
    import('../claude-debug-log-entry-parser'),
    import('../../claude-api-proxy/claude-usage-live-updater'),
    import('../../claude-api-proxy/claude-api-proxy-env'),
    import('../../claude-organization-learner'),
    import('../../usage-service'),
    import('../../account-store-claude'),
    import('../../claude-binary-resolver'),
    import('./code-mode-live-session'),
    import('@shared/types/settings'),
    import('../../../db/types')
  ])
  return {
    ...bridge,
    ...pty,
    ...launchesLive,
    ...debugDir,
    ...usageSource,
    ...entryParser,
    ...liveUpdater,
    ...proxyEnv,
    ...learner,
    ...usageService,
    ...accountStore,
    ...binaryResolver,
    ...session,
    ...settings,
    ...dbTypes
  }
}

/** Enough of an organization id to recognise it. */
const short = (organization: string | null | undefined): string =>
  organization ? `${organization.slice(0, 8)}…` : String(organization)

function makeSession(): Session {
  const now = new Date().toISOString()
  return {
    id: SESSION_ID,
    worktree_id: 'code-mode-live-worktree',
    project_id: 'code-mode-live-project',
    connection_id: null,
    name: 'Code Mode live check',
    status: 'active',
    opencode_session_id: null,
    claude_session_id: null,
    agent_sdk: 'claude-code-cli',
    mode: 'build',
    session_type: 'default',
    model_provider_id: 'anthropic',
    model_id: MODEL,
    model_variant: null,
    remote_launch: null,
    created_at: now,
    updated_at: now,
    completed_at: null,
    pinned_to_board: false
  } as Session
}

/**
 * The database as the app reads it for this launch: one Claude CLI session in `cwd`, and the
 * settings blob with Code Mode asked for in Settings → Environment Variables. What the
 * session's bookkeeping would write (its title, its trust check) goes nowhere.
 */
function stubDatabase(session: Session, cwd: string, settingsKey: string): unknown {
  const settings = JSON.stringify({
    environmentVariables: [{ key: CODE_MODE_VARIABLE, value: '1' }]
  })
  const known: Record<string, (...args: never[]) => unknown> = {
    getSession: () => session,
    getWorktree: () => ({ path: cwd }),
    getConnection: () => null,
    getProject: () => ({ id: session.project_id, path: cwd, kind: 'git', trust_check_done: false }),
    getSetting: (key: string) => (key === settingsKey ? settings : null),
    getSessionByClaudeSessionId: () => null
  }
  return new Proxy(known, {
    get: (target, name) => {
      if (typeof name !== 'string' || name === 'then') return undefined
      return name in target ? target[name] : () => null
    }
  })
}

describeLive('live usage of a Code Mode session (live)', () => {
  const cleanups: Array<() => Promise<void> | void> = []
  afterAll(async () => {
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup()
      } catch (error) {
        console.warn('[code mode live] cleanup failed', error)
      }
    }
  }, 60_000)

  it(
    'reads the usage of a real Code Mode session from its debug log and credits the signed-in account',
    async () => {
      const app = await loadApp()

      // 0. What the check cannot do without, said plainly.
      const claudeBinary = app.resolveClaudeBinaryPath()
      if (!claudeBinary) {
        throw new Error(
          CLAUDE_BIN
            ? `The Claude CLI was not found: CLAUDE_BIN names ${CLAUDE_BIN}, which does not exist.`
            : 'The Claude CLI was not found: `claude` is not on PATH. Install it, or put the ' +
                'path of the binary in CLAUDE_BIN.'
        )
      }
      const cliVersion = execFileSync(claudeBinary, ['--version'], {
        encoding: 'utf8',
        timeout: 15_000
      }).trim()
      const identity = await app.readClaudeLiveIdentity()
      const liveEmail = identity.email?.toLowerCase() ?? null
      if (!liveEmail || !(await app.readClaudeCredentialsBlob())?.accessToken) {
        throw new Error(
          'No signed-in Claude account was found (no account in the CLI identity file, or no ' +
            'credential for it). Start `claude`, sign in with /login, then run this test again.'
        )
      }

      // 1. The app's surroundings: its data folder, the session's folder, its API proxy.
      const base = realpathSync(mkdtempSync(join(tmpdir(), 'code-mode-usage-live-')))
      cleanups.push(() => rmSync(base, { recursive: true, force: true }))
      const cwd = join(base, 'project')
      mkdirSync(cwd)
      const dataDir = join(base, 'data')
      mkdirSync(dataDir, { mode: 0o700 })
      const root = join(dataDir, app.CLAUDE_CLI_DEBUG_DIRNAME)

      // The proxy "runs": its address is on the app's environment, where every PTY inherits
      // it, and a Code Mode launch has to take it out again. Nothing may arrive here.
      let proxyRequests = 0
      const proxy = createServer((_request, response) => {
        proxyRequests += 1
        response.statusCode = 502
        response.end()
      })
      await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
      cleanups.push(() => new Promise<void>((resolve) => proxy.close(() => resolve())))
      const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`

      // The app's environment is the login shell's. This process may itself run inside a
      // Claude Code session: that session's own variables are kept out of the nested CLI.
      cleanups.push(() => {
        vi.unstubAllEnvs()
      })
      for (const name of Object.keys(process.env)) {
        if (name === 'CLAUDECODE' || name.startsWith('CLAUDE_CODE_') || name === 'ANTHROPIC_LOG') {
          vi.stubEnv(name, undefined)
        }
      }
      vi.stubEnv(app.ANTHROPIC_BASE_URL_ENV, proxyUrl)
      vi.stubEnv(app.ASSUME_FIRST_PARTY_ENV, '1')
      app.setClaudeApiProxyBaseUrl(proxyUrl)
      cleanups.push(() => app.setClaudeApiProxyBaseUrl(null))

      live.db = stubDatabase(makeSession(), cwd, app.APP_SETTINGS_DB_KEY)
      cleanups.push(() => {
        live.db = null
      })

      // 2. The live usage updater, over an account table in memory: the signed-in account,
      //    whose organization has not been learned yet.
      const accounts: Array<{ id: string; email: string; organizationUuid: string | null }> = [
        { id: 'signed-in', email: liveEmail, organizationUuid: null }
      ]
      const rows = new Map<string, SavedUsageAccount>()
      const published: ClaudeLiveUsagePayload[] = []
      const learning: string[] = []
      const silent = { debug: () => {}, info: () => {}, warn: () => {} }

      // The app's learner and its one request (the OAuth profile), with the signed-in
      // account's own access token. Nothing is refreshed, nothing is stored outside `accounts`.
      const learner = new app.ClaudeOrganizationLearner({
        listAccountsWithoutOrganization: () =>
          accounts
            .filter((account) => account.organizationUuid === null)
            .map(({ id, email }) => ({ id, email })),
        readCredential: async () => {
          const credential = await app.readClaudeCredentialsBlob()
          if (!credential?.accessToken) {
            learning.push('no credential')
            return null
          }
          return { accessToken: credential.accessToken, expiresAt: credential.expiresAt }
        },
        fetchOrganization: async (accessToken) => {
          const result = await app.fetchClaudeProfileOrganization(accessToken)
          learning.push(result.ok ? 'learned' : `failed: ${result.reason}`)
          return result
        },
        storeOrganization: (account, organizationUuid) => {
          const stored = accounts.find((candidate) => candidate.id === account.id)
          if (!stored) return false
          stored.organizationUuid = organizationUuid
          return true
        },
        log: { info: () => {}, warn: () => {} }
      })

      const updater = new app.ClaudeUsageLiveUpdater({
        // A reading from a debug log names its organization and nothing else: it is placed
        // through the organizations stored per account, never through a credential.
        listManagedAccounts: async () => [],
        readLiveTokenFingerprint: async () => null,
        ensureLiveAccountManaged: async () => false,
        rememberAccountUuid: async () => false,
        readLiveIdentity: app.readClaudeLiveIdentity,
        isAccountManaged: async (email) => accounts.some((account) => account.email === email),
        readUsageRow: (email) => rows.get(email) ?? null,
        writeLiveUsage: (email, usage) => {
          const account = accounts.find((candidate) => candidate.email === email)
          const row = {
            id: account?.id ?? email,
            provider: 'anthropic',
            email,
            credentials_json: '',
            last_usage_json: JSON.stringify(usage),
            last_fetched_at: null,
            status: 'ok',
            last_error: null,
            org_uuid: account?.organizationUuid ?? null,
            created_at: '',
            updated_at: ''
          } as SavedUsageAccount
          rows.set(email, row)
          return row
        },
        publish: (_channel, payload) => {
          published.push(payload)
          return true
        },
        listAccountOrganizations: () =>
          accounts.map(({ email, organizationUuid }) => ({ email, organizationUuid })),
        readLastAccountSwitchAt: () => null,
        // As in the app: a reading for an organization nobody is mapped to is held while the
        // organizations of the accounts that have none are learned, then placed.
        requestOrganizations: () => {
          void learner.sweep().then(() => updater.organizationsLearned())
        },
        log: silent
      })
      cleanups.push(() => updater.dispose())

      // 3. The app's usage source and launches, over this test's folders.
      const observations: ClaudeUsageObservation[] = []
      const readDelaysMs: number[] = []
      let firstObservationAt: number | null = null
      const source = new app.ClaudeDebugLogUsageSource({
        submit: (observation) => {
          firstObservationAt ??= Date.now()
          observations.push(observation)
          readDelaysMs.push(Date.now() - observation.observedAt)
          updater.observe(observation)
        }
      })
      cleanups.push(() => source.dispose())
      const launches = app.createClaudeCliUsageLaunches({
        dirs: new app.ClaudeCliDebugDirs({ root }),
        source
      })
      app.__setClaudeCliUsageLaunchesForTests(launches)
      cleanups.push(() => app.__setClaudeCliUsageLaunchesForTests(null))
      // The app's quit: every PTY is ended and reaped, whatever happened before, so that no
      // CLI process outlives the test. Runs before what it needs is taken down (the cleanups
      // run last to first).
      cleanups.push(() => app.cleanupTerminals())

      const problems = (): string =>
        live.problems.length > 0
          ? `What the app warned about:\n${live.problems.map((line) => `  - ${line}`).join('\n')}`
          : 'The app warned about nothing.'

      // 4. Start the session as the app does.
      const result = await app.createClaudeCliTerminal(SESSION_ID, { pendingPrompt: PROMPT })
      if (!result.success) {
        throw new Error(`The app could not start the session: ${result.error}\n${problems()}`)
      }
      const screen = new app.LiveSessionScreen(result.cols ?? 80, result.rows ?? 24)
      cleanups.push(() => screen.dispose())
      let exit: { code: number; signal: number } | null = null
      app.ptyService.onData(SESSION_ID, (data) => screen.feed(data))
      app.ptyService.onExit(SESSION_ID, (code, signal) => {
        exit = { code, signal }
      })

      const whatIsKnown = (): string =>
        [
          `The session's screen (${cliVersion}):`,
          screen.report(),
          `Requests that reached the proxy's address: ${proxyRequests}.`,
          problems()
        ].join('\n')
      /** A session whose process has ended cannot get any further. */
      const failIfEnded = (before: string): void => {
        if (exit === null) return
        throw new Error(
          `The Claude CLI ended (exit code ${exit.code}, signal ${exit.signal}) before ${before}.\n` +
            whatIsKnown()
        )
      }

      const transport = launches.transport(SESSION_ID)
      if (transport !== 'debug-log') {
        throw new Error(
          transport === null
            ? 'The launch stayed on the API proxy: the app did not take the session for a Code ' +
                'Mode session it can follow (an API address or provider of your own in the ' +
                'environment or in the Claude settings excludes it).\n' +
                problems()
            : 'The launch was taken off the proxy without live usage (transport `none`): live ' +
                `usage for Code Mode sessions is switched off (${KILL_SWITCH_VARIABLE}` +
                `${process.env[KILL_SWITCH_VARIABLE] ? ' is set' : ' is not set'}), or its ` +
                'launch directory could not be prepared.\n' +
                problems()
        )
      }
      const launchDirs = readdirSync(root)
      expect(launchDirs, 'one launch directory for the one launch').toHaveLength(1)
      expect(launchDirs[0].startsWith(`${SESSION_ID}-`)).toBe(true)
      const launchDir = join(root, launchDirs[0])
      const logFile = join(launchDir, app.CLAUDE_CLI_DEBUG_LOG_FILENAME)
      expect(existsSync(logFile)).toBe(true)

      // 5. The session reports Code Mode on.
      await app.waitForLive({
        what: 'the session to report "Code Mode (experimental) is on"',
        timeoutMs: CODE_MODE_WAIT_MS,
        look: async () => {
          await screen.settled()
          const reading = screen.codeModeReading()
          if (reading.kind === 'on') return true
          if (reading.kind === 'unavailable') {
            throw new Error(
              `Code Mode is not available for this session. The CLI says: "${reading.notice}"\n` +
                whatIsKnown()
            )
          }
          if (reading.kind === 'consent-needed') {
            throw new Error(
              'The CLI asks for consent to Code Mode, and this test does not give it for you. ' +
                `Start \`${CODE_MODE_VARIABLE}=1 claude\` once, choose "Yes, turn on Code Mode", ` +
                'then run this test again.'
            )
          }
          failIfEnded('it reported Code Mode on')
          if (
            firstObservationAt !== null &&
            Date.now() - firstObservationAt > NOTICE_GRACE_AFTER_RESPONSE_MS
          ) {
            throw new Error(
              'The session has an answer from the API and never reported Code Mode on: the CLI ' +
                'started it without Code Mode (not available for this account or model?).\n' +
                whatIsKnown()
            )
          }
          return undefined
        },
        context: whatIsKnown
      })

      // 6. The prompt is answered. The CLI writes a response to its log when the response's
      //    headers arrive, before any of its text: with the answer on the screen, the log
      //    holds the response of this turn.
      await app.waitForLive({
        what: 'the answer to the prompt to appear on the screen',
        timeoutMs: REPLY_WAIT_MS,
        look: async () => {
          await screen.settled()
          if (REPLY.test(screen.text())) return true
          failIfEnded('the prompt was answered')
          return undefined
        },
        context: whatIsKnown
      })

      // 7. The log receives a response entry. Counted here by kind, never shown.
      const responseEntries = (): { start: number; error: number } => {
        const counts = { start: 0, error: 0 }
        let text: string
        try {
          text = readFileSync(logFile, 'utf8')
        } catch {
          return counts
        }
        for (const line of text.split('\n')) {
          const parsed = app.parseClaudeDebugLogLine(line)
          if (parsed.kind !== 'entry') continue
          if (parsed.entry.kind === 'response-start') counts.start += 1
          else counts.error += 1
        }
        return counts
      }
      const sourceFacts = (): string => {
        const facts = source.facts(SESSION_ID)
        if (!facts) return 'The usage source no longer follows the log.'
        return (
          `The usage source read ${facts.bytesRead} bytes, ${facts.linesRead} lines: ` +
          `${facts.entriesParsed} response entries, ${facts.observations} readings, ` +
          `${facts.entriesWithoutUsage} without usage, ` +
          `${facts.entriesWithoutOrganization} without an organization, ` +
          `${facts.parseFailures} unreadable, degraded: ${facts.degraded?.reason ?? 'no'}.`
        )
      }
      const entries = await app.waitForLive({
        what: "a `response start` entry in the session's debug log",
        timeoutMs: RESPONSE_ENTRY_WAIT_MS,
        intervalMs: 250,
        look: () => {
          const counts = responseEntries()
          if (counts.start > 0) return counts
          failIfEnded('its debug log received a `response start` entry')
          return undefined
        },
        context: () => [sourceFacts(), whatIsKnown()].join('\n')
      })

      // 8. The entry yields a usage reading with a weekly window, through the app's own
      //    follower and parser. The newest one is looked at: the turn's, or one just before it.
      const hasWeeklyWindow = (observation: ClaudeUsageObservation): boolean =>
        typeof observation.snapshot.sevenDay?.utilizationPercent === 'number'
      const reading = await app.waitForLive({
        what: 'the usage source to turn a log entry into a reading with a weekly window',
        timeoutMs: READING_WAIT_MS,
        look: () => {
          // Everything in the log has been read: no reading of this turn is still to come.
          const facts = source.facts(SESSION_ID)
          const counted = responseEntries()
          if (!facts || facts.entriesParsed < counted.start + counted.error) return undefined
          return observations.filter(hasWeeklyWindow).at(-1)
        },
        context: () =>
          [
            `Readings so far: ${observations.length}, with a weekly window: ` +
              `${observations.filter(hasWeeklyWindow).length}.`,
            sourceFacts(),
            whatIsKnown()
          ].join('\n')
      })
      expect(reading.credentialFingerprint).toBeNull()
      expect(reading.accountUuid).toBeNull()
      expect(reading.organizationUuid, 'the reading names its organization').toBeTruthy()
      expect(reading.snapshot.sevenDay?.utilizationPercent).toBeGreaterThanOrEqual(0)

      // 9. The reading's organization maps to the signed-in account: the app learns that
      //    account's organization with its own token, and the updater then credits it.
      const readingOrganization = app.normalizeOrgUuid(reading.organizationUuid)
      const payload = await app.waitForLive({
        what: 'the live updater to credit the reading to the signed-in account',
        timeoutMs: ATTRIBUTION_WAIT_MS,
        look: () => {
          const credited = published.find((candidate) => candidate.email === liveEmail)
          if (credited) return credited
          const failure = learning.find((step) => step !== 'learned')
          if (failure) {
            throw new Error(
              "The signed-in account's organization could not be learned with its own token " +
                `(${failure}), so the reading has no account to go to.`
            )
          }
          const learned = app.normalizeOrgUuid(accounts[0].organizationUuid)
          if (learned !== null && learned !== readingOrganization) {
            throw new Error(
              `The reading's organization (${short(readingOrganization)}) is not the one learned ` +
                `for the signed-in account (${short(learned)}): the session is billed to ` +
                'another organization than the account it is signed in to.'
            )
          }
          return undefined
        },
        context: () =>
          `Learning the signed-in account's organization: ${learning.join(', ') || 'not asked for'}.`
      })
      expect(app.normalizeOrgUuid(accounts[0].organizationUuid)).toBe(readingOrganization)
      expect(payload.accountId).toBe('signed-in')
      expect(payload.isLiveAccount).toBe(true)
      expect(payload.usage.seven_day?.utilization).toBeGreaterThanOrEqual(0)
      expect(payload.rateLimit.sevenDay).not.toBeNull()

      console.log('[code mode usage live]', {
        cli: cliVersion,
        model: MODEL,
        logEntries: entries,
        readings: observations.length,
        // From the time written in the log line to the moment the app had read it.
        readDelaysMs,
        organization: short(readingOrganization),
        weekly: {
          utilizationPercent: reading.snapshot.sevenDay?.utilizationPercent,
          status: reading.snapshot.sevenDay?.status
        },
        fiveHour: reading.snapshot.fiveHour?.utilizationPercent ?? null,
        scoped: Object.keys(reading.snapshot.scoped)
      })

      // 10. A shell command of the session does not see the variable that makes the CLI log
      //     its responses: the launch's environment file takes it out again (T06). Typed into
      //     the session's shell mode once the turn is over and the screen stands still.
      await app.waitForLive({
        what: 'the session to come to rest after the answer',
        timeoutMs: QUIET_WAIT_MS,
        look: async () => {
          await screen.settled()
          failIfEnded('its turn was over')
          return screen.quietFor() >= QUIET_MS ? true : undefined
        },
        context: whatIsKnown
      })
      const shellOutput = join(cwd, SHELL_OUTPUT_FILE)
      app.ptyService.write(SESSION_ID, '!')
      await new Promise((resolve) => setTimeout(resolve, KEY_PAUSE_MS))
      app.ptyService.write(SESSION_ID, SHELL_COMMAND)
      // Enter only once the command is where it belongs: a key sent too early is dropped,
      // and an Enter after it would send whatever is there instead.
      await app.waitForLive({
        what: "the shell command to appear in the session's input",
        timeoutMs: TYPING_WAIT_MS,
        look: async () => {
          await screen.settled()
          failIfEnded('the shell command was typed')
          // Whatever the input row puts between its words (it is not always a space).
          return screen.text().replace(/\s+/g, ' ').includes(SHELL_COMMAND) ? true : undefined
        },
        context: whatIsKnown
      })
      app.ptyService.write(SESSION_ID, '\r')
      const printed = await app.waitForLive({
        what: 'the shell command typed into the session to finish',
        timeoutMs: SHELL_WAIT_MS,
        look: () => {
          failIfEnded('its shell command finished')
          try {
            const text = readFileSync(shellOutput, 'utf8')
            return /exit=\d+\n$/.test(text) ? text : undefined
          } catch {
            return undefined
          }
        },
        context: whatIsKnown
      })
      // `printenv` prints nothing and fails for a variable that is not set.
      expect(printed, '`printenv ANTHROPIC_LOG` in a shell command of the session').toBe('exit=1\n')

      // 11. Close the session as the app does. Once its process has ended nothing of the
      //     launch remains: not its log, not its directory, not its registration.
      failIfEnded('the session was closed')
      app.destroyNodePtyTerminal(SESSION_ID)
      await app.waitForLive({
        what: 'the CLI process to end after its session was closed',
        timeoutMs: EXIT_WAIT_MS,
        look: () => exit ?? undefined
      })
      expect(readdirSync(root), 'files of the session left after it ended').toEqual([])
      expect(existsSync(launchDir)).toBe(false)
      expect(launches.transport(SESSION_ID)).toBeNull()
      expect(source.facts(SESSION_ID)).toBeNull()

      // Off the proxy from start to end.
      expect(proxyRequests, "requests sent to the proxy's address").toBe(0)
    },
    TEST_TIMEOUT_MS
  )
})
