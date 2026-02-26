import { PostHog } from 'posthog-node'
import { app } from 'electron'
import { randomUUID } from 'crypto'
import { getDatabase } from '../db'
import { createLogger } from './logger'

const log = createLogger({ component: 'Telemetry' })

const POSTHOG_API_KEY = '<project-api-key>' // TODO: user provides their key
const POSTHOG_HOST = 'https://us.i.posthog.com'

class TelemetryService {
  private static instance: TelemetryService | null = null
  private client: PostHog | null = null
  private distinctId: string | null = null
  private enabled = true

  private constructor() {
    // Private constructor for singleton pattern
  }

  static getInstance(): TelemetryService {
    if (!TelemetryService.instance) {
      TelemetryService.instance = new TelemetryService()
    }
    return TelemetryService.instance
  }

  init(): void {
    const db = getDatabase()

    // Load or generate distinct ID
    let distinctId = db.getSetting('telemetry_distinct_id')
    if (!distinctId) {
      distinctId = randomUUID()
      db.setSetting('telemetry_distinct_id', distinctId)
      log.info('Generated new telemetry distinct ID')
    }
    this.distinctId = distinctId

    // Load enabled state (absent = enabled, opt-out model)
    const enabledSetting = db.getSetting('telemetry_enabled')
    this.enabled = enabledSetting !== 'false'

    if (this.enabled) {
      this.createClient()
      log.info('Telemetry initialized', { enabled: this.enabled })
    } else {
      log.info('Telemetry is disabled')
    }
  }

  track(event: string, properties?: Record<string, unknown>): void {
    if (!this.enabled || !this.client || !this.distinctId) return

    this.client.capture({
      distinctId: this.distinctId,
      event,
      properties: {
        app_version: app.getVersion(),
        platform: process.platform,
        ...properties
      }
    })
  }

  identify(properties?: Record<string, unknown>): void {
    if (!this.enabled || !this.client || !this.distinctId) return

    this.client.identify({
      distinctId: this.distinctId,
      properties: {
        app_version: app.getVersion(),
        platform: process.platform,
        ...properties
      }
    })
  }

  async setEnabled(enabled: boolean): Promise<void> {
    const db = getDatabase()

    if (enabled) {
      this.enabled = true
      db.setSetting('telemetry_enabled', 'true')
      this.createClient()
      log.info('Telemetry enabled')
    } else {
      // Track the opt-out event before shutting down
      this.track('telemetry_disabled')
      this.enabled = false
      db.setSetting('telemetry_enabled', 'false')
      await this.shutdown()
      this.client = null
      log.info('Telemetry disabled')
    }
  }

  isEnabled(): boolean {
    return this.enabled
  }

  async shutdown(): Promise<void> {
    if (this.client) {
      try {
        await this.client.shutdown()
      } catch (err) {
        log.warn('Error shutting down PostHog client', {
          error: err instanceof Error ? err.message : String(err)
        })
      }
    }
  }

  private createClient(): void {
    this.client = new PostHog(POSTHOG_API_KEY, {
      host: POSTHOG_HOST,
      flushAt: 20,
      flushInterval: 30000
    })
  }
}

export const telemetryService = TelemetryService.getInstance()
