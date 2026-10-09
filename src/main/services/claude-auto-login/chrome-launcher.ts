/**
 * Launches the user's installed Google Chrome as a *separate* browser with a
 * throwaway profile, wired for CDP over a pipe.
 *
 * A fresh `--user-data-dir` is what makes the sign-in start from scratch: no
 * remembered claude.ai account, no "Choose an account" screen, and nothing
 * from the user's everyday profile is touched. It is also what lets a second
 * Chrome process start while the user's own Chrome is running — and since
 * Chrome 136 remote debugging is refused on the default profile anyway.
 *
 * Headed on purpose: claude.ai sits behind Cloudflare, which challenged
 * headless Chromium on the very first request in testing while a visible real
 * Chrome passed. The window is also where the user finishes by hand when the
 * automation hits something it cannot drive.
 */
import { spawn, type ChildProcess } from 'child_process'
import { access } from 'fs/promises'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Readable, Writable } from 'stream'

/** Candidate browsers, most preferred first. All are Chromium-based and speak CDP. */
export const CHROME_CANDIDATES: readonly string[] = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  `${process.env.HOME ?? ''}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
]

/** The consent page disables "Authorize" in a small window; give it room. */
export const CHROME_WINDOW_SIZE = { width: 1100, height: 860 }

export async function findChromeBinary(
  candidates: readonly string[] = CHROME_CANDIDATES
): Promise<string | null> {
  for (const candidate of candidates) {
    if (!candidate.startsWith('/')) continue
    try {
      await access(candidate)
      return candidate
    } catch {
      // not installed here
    }
  }
  return null
}

/** Pure: the Chrome command line for a given profile dir and start URL. */
export function buildChromeArgs(userDataDir: string, url: string): string[] {
  return [
    '--remote-debugging-pipe',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-session-crashed-bubble',
    // A new profile would otherwise prompt for Keychain access to seed its cookie key.
    '--use-mock-keychain',
    '--disable-features=TranslateUI',
    // The debugging pipe makes Chrome report `navigator.webdriver = true`, which
    // claude.ai's bot checks read; this keeps the page looking like a normal browser.
    '--disable-blink-features=AutomationControlled',
    `--window-size=${CHROME_WINDOW_SIZE.width},${CHROME_WINDOW_SIZE.height}`,
    '--new-window',
    url
  ]
}

export interface LaunchedChrome {
  process: ChildProcess
  /** We write CDP requests here (Chrome's fd 3). */
  cdpWrite: Writable
  /** Chrome writes CDP responses/events here (its fd 4). */
  cdpRead: Readable
  userDataDir: string
  /** Resolves when the browser process has exited; the profile dir is removed by then. */
  exited: Promise<void>
  /** Asks Chrome to quit; force-kills if it lingers. */
  kill: () => Promise<void>
}

export interface LaunchChromeOptions {
  binary?: string
  /** Test seam. */
  spawnImpl?: typeof spawn
}

export async function launchChrome(
  url: string,
  options: LaunchChromeOptions = {}
): Promise<LaunchedChrome> {
  const binary = options.binary ?? (await findChromeBinary())
  if (!binary) {
    throw new Error(
      'Google Chrome is not installed — automated sign-in needs Chrome (or another Chromium browser) in /Applications'
    )
  }

  const userDataDir = await mkdtemp(join(tmpdir(), 'tedooo-claude-login-'))
  const spawnImpl = options.spawnImpl ?? spawn
  const child = spawnImpl(binary, buildChromeArgs(userDataDir, url), {
    // stdin/stdout ignored; stderr piped (Chrome is chatty but it helps debugging);
    // fd 3 and 4 are the CDP pipe ends.
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
    detached: false
  })

  const cdpWrite = child.stdio[3] as Writable | null
  const cdpRead = child.stdio[4] as Readable | null
  if (!cdpWrite || !cdpRead) {
    child.kill('SIGKILL')
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {})
    throw new Error('Could not open the DevTools pipe to Chrome')
  }
  child.stderr?.on('data', () => {}) // keep the pipe drained

  let exitedResolve: () => void = () => {}
  const exited = new Promise<void>((resolve) => {
    exitedResolve = resolve
  })
  let hasExited = false
  const onExit = (): void => {
    if (hasExited) return
    hasExited = true
    void rm(userDataDir, { recursive: true, force: true })
      .catch(() => {})
      .finally(() => exitedResolve())
  }
  child.once('exit', onExit)
  child.once('error', onExit)

  const kill = async (): Promise<void> => {
    if (hasExited) return exited
    child.kill('SIGTERM')
    const forceTimer = setTimeout(() => {
      if (!hasExited) child.kill('SIGKILL')
    }, 3000)
    forceTimer.unref()
    await exited
    clearTimeout(forceTimer)
  }

  return { process: child, cdpWrite, cdpRead, userDataDir, exited, kill }
}
