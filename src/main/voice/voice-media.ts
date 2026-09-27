import { spawn } from 'child_process'
import { app } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { createLogger } from '../services/logger'

const log = createLogger({ component: 'VoiceMedia' })

const TEST_TIMEOUT_MS = 3_000
const COMMAND_TIMEOUT_MS = 1_500
/** MediaRemote command ids — never the toggle (2), which could start playback. */
const MR_COMMAND_PLAY = '0'
const MR_COMMAND_PAUSE = '1'

interface AdapterPaths {
  readonly script: string
  readonly framework: string
  readonly testClient: string
}

interface NowPlaying {
  readonly playing: boolean | null
  readonly bundleIdentifier: string | null
}

/**
 * Pause whatever is playing (Music, Spotify, a browser video…) while the user
 * dictates and resume it afterwards — only if we paused it and the user did not
 * resume it themselves in between. Ported from Wispelker's MediaController.
 *
 * macOS 15.4+ blocks direct MediaRemote reads for third-party apps, so both
 * detection and commands go through the vendored mediaremote-adapter run by
 * `/usr/bin/perl` (an Apple binary that passes the entitlement check).
 * Operations are strictly serialised so rapid record/stop cycles cannot
 * reorder a pause behind its resume. Anything unexpected degrades to a no-op;
 * recording is never delayed or blocked by media handling.
 */
export class VoiceMediaController {
  private functional: boolean | null = null
  private pausedBundleId: string | null = null
  private chain: Promise<void> = Promise.resolve()

  get isSupported(): boolean {
    return process.platform === 'darwin'
  }

  /** Run the adapter self-test once, off the critical path. */
  prepare(): Promise<void> {
    return this.enqueue(() => this.ensurePrepared())
  }

  recordingWillStart(): Promise<void> {
    return this.enqueue(async () => {
      this.pausedBundleId = null
      await this.ensurePrepared()
      if (!this.functional) return
      const state = await this.nowPlaying()
      if (!state || state.playing !== true || !state.bundleIdentifier) return
      await this.send(MR_COMMAND_PAUSE)
      this.pausedBundleId = state.bundleIdentifier
      log.info('Paused playback', { bundleId: state.bundleIdentifier })
    })
  }

  recordingDidStop(): Promise<void> {
    return this.enqueue(async () => {
      const bundleId = this.pausedBundleId
      if (!bundleId) return
      this.pausedBundleId = null
      const state = await this.nowPlaying()
      if (!state || state.playing !== false || state.bundleIdentifier !== bundleId) return
      await this.send(MR_COMMAND_PLAY)
      log.info('Resumed playback', { bundleId })
    })
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    if (!this.isSupported) return Promise.resolve()
    const next = this.chain.then(operation).catch((error: unknown) => {
      log.warn('media operation failed', { error: String(error) })
    })
    this.chain = next
    return next
  }

  private async ensurePrepared(): Promise<void> {
    if (this.functional !== null) return
    const paths = resolveAdapterPaths()
    if (!paths) {
      this.functional = false
      log.warn('mediaremote-adapter not bundled; media pause disabled')
      return
    }
    const result = await this.run(
      [paths.script, paths.framework, paths.testClient, 'test'],
      TEST_TIMEOUT_MS
    )
    this.functional = result?.exitCode === 0
    if (!this.functional) {
      log.warn('mediaremote-adapter test failed; media pause disabled', {
        exitCode: result?.exitCode ?? null
      })
    }
  }

  private async nowPlaying(): Promise<NowPlaying | null> {
    const paths = resolveAdapterPaths()
    if (!paths) return null
    const result = await this.run(
      [paths.script, paths.framework, 'get', '--no-artwork'],
      COMMAND_TIMEOUT_MS
    )
    if (!result || result.exitCode !== 0) return null
    try {
      const parsed = JSON.parse(result.stdout) as unknown
      if (!parsed || typeof parsed !== 'object') return null
      const record = parsed as Record<string, unknown>
      return {
        playing: typeof record.playing === 'boolean' ? record.playing : null,
        bundleIdentifier:
          typeof record.bundleIdentifier === 'string' ? record.bundleIdentifier : null
      }
    } catch {
      return null
    }
  }

  private async send(command: string): Promise<void> {
    const paths = resolveAdapterPaths()
    if (!paths) return
    await this.run([paths.script, paths.framework, 'send', command], COMMAND_TIMEOUT_MS)
  }

  private run(
    args: string[],
    timeoutMs: number
  ): Promise<{ exitCode: number | null; stdout: string } | null> {
    return new Promise((resolve) => {
      let settled = false
      const finish = (value: { exitCode: number | null; stdout: string } | null): void => {
        if (settled) return
        settled = true
        resolve(value)
      }
      let child: ReturnType<typeof spawn>
      try {
        child = spawn('/usr/bin/perl', args, { stdio: ['ignore', 'pipe', 'ignore'] })
      } catch {
        finish(null)
        return
      }
      let stdout = ''
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
      })
      const timer = setTimeout(() => {
        try {
          child.kill('SIGTERM')
        } catch {
          // ignore
        }
        finish(null)
      }, timeoutMs)
      child.on('error', () => {
        clearTimeout(timer)
        finish(null)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        finish({ exitCode: code, stdout })
      })
    })
  }
}

let cachedPaths: AdapterPaths | null | undefined

function resolveAdapterPaths(): AdapterPaths | null {
  if (cachedPaths !== undefined) return cachedPaths
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'mediaremote-adapter')]
    : [
        join(app.getAppPath(), 'resources', 'mediaremote-adapter'),
        join(app.getAppPath(), '..', 'hive', 'resources', 'mediaremote-adapter')
      ]
  for (const dir of candidates) {
    const script = join(dir, 'mediaremote-adapter.pl')
    const framework = join(dir, 'MediaRemoteAdapter.framework')
    const testClient = join(dir, 'MediaRemoteAdapterTestClient')
    if (existsSync(script) && existsSync(framework) && existsSync(testClient)) {
      cachedPaths = { script, framework, testClient }
      return cachedPaths
    }
  }
  cachedPaths = null
  return null
}

export const voiceMedia = new VoiceMediaController()
