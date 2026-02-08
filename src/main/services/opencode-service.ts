import type { BrowserWindow } from 'electron'
import { createLogger } from './logger'
import { getDatabase } from '../db'

const log = createLogger({ component: 'OpenCodeService' })

// Default model configuration
const DEFAULT_MODEL = {
  providerID: 'anthropic',
  modelID: 'claude-opus-4-5-20251101'
}

const SELECTED_MODEL_DB_KEY = 'selected_model'

// Event types we care about for streaming
export interface StreamEvent {
  type: string
  sessionId: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any
}

// Type for the OpencodeClient from the SDK
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OpencodeClient = any

// Per-directory subscription info
interface DirectorySubscription {
  controller: AbortController
  sessionCount: number
}

interface OpenCodeInstance {
  client: OpencodeClient
  server: {
    url: string
    close(): void
  }
  // Map of OpenCode session IDs to Hive session IDs for routing events
  sessionMap: Map<string, string>
  // Map of OpenCode session IDs to worktree paths
  sessionDirectories: Map<string, string>
  // Map of directory paths to their event subscriptions
  directorySubscriptions: Map<string, DirectorySubscription>
}

// Dynamic import helper for ESM SDK
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadOpenCodeSDK(): Promise<{ createOpencode: any }> {
  // Dynamic import for ESM module
  const sdk = await import('@opencode-ai/sdk')
  return sdk
}

class OpenCodeService {
  // Single server instance (OpenCode handles multiple directories via query params)
  private instance: OpenCodeInstance | null = null
  private mainWindow: BrowserWindow | null = null
  private pendingConnection: Promise<OpenCodeInstance> | null = null

  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window
  }

  /**
   * Get or create the OpenCode instance
   */
  private async getOrCreateInstance(): Promise<OpenCodeInstance> {
    // Check if instance already exists
    if (this.instance) {
      return this.instance
    }

    // Check if connection is already in progress
    if (this.pendingConnection) {
      log.info('Waiting for pending connection')
      return this.pendingConnection
    }

    // Start new connection
    log.info('Starting OpenCode server')

    this.pendingConnection = (async (): Promise<OpenCodeInstance> => {
      try {
        // Load SDK dynamically
        const { createOpencode } = await loadOpenCodeSDK()

        // Start OpenCode server (it will use the opencode config from ~/opencode/)
        const { client, server } = await createOpencode()

        const instance: OpenCodeInstance = {
          client,
          server,
          sessionMap: new Map(),
          sessionDirectories: new Map(),
          directorySubscriptions: new Map()
        }

        this.instance = instance
        return instance
      } finally {
        // Always clean up pending connection
        this.pendingConnection = null
      }
    })()

    return this.pendingConnection
  }

  /**
   * Subscribe to events for a specific directory
   */
  private subscribeToDirectory(instance: OpenCodeInstance, directory: string): void {
    // Check if already subscribed
    if (instance.directorySubscriptions.has(directory)) {
      const sub = instance.directorySubscriptions.get(directory)!
      sub.sessionCount++
      log.info('Incremented subscription count for directory', { directory, count: sub.sessionCount })
      return
    }

    const controller = new AbortController()
    instance.directorySubscriptions.set(directory, {
      controller,
      sessionCount: 1
    })

    log.info('Starting event subscription for directory', { directory })

    // Start consuming events for this directory
    this.consumeDirectoryEvents(instance, directory, controller.signal)
  }

  /**
   * Unsubscribe from events for a directory (decrements count, cancels when 0)
   */
  private unsubscribeFromDirectory(instance: OpenCodeInstance, directory: string): void {
    const sub = instance.directorySubscriptions.get(directory)
    if (!sub) return

    sub.sessionCount--
    log.info('Decremented subscription count for directory', { directory, count: sub.sessionCount })

    if (sub.sessionCount <= 0) {
      log.info('Cancelling event subscription for directory', { directory })
      sub.controller.abort()
      instance.directorySubscriptions.delete(directory)
    }
  }

  /**
   * Consume events for a specific directory
   */
  private async consumeDirectoryEvents(
    instance: OpenCodeInstance,
    directory: string,
    signal: AbortSignal
  ): Promise<void> {
    try {
      const result = await instance.client.event.subscribe({
        signal,
        query: { directory }
      })

      log.info('Event subscription established for directory', { directory })

      // Iterate over the stream - this is REQUIRED for events to flow
      for await (const event of result.stream) {
        this.handleEvent(instance, { data: event })
      }

      log.info('Event stream ended normally for directory', { directory })
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') {
        log.info('Event subscription aborted for directory', { directory })
      } else {
        log.error('Event stream error for directory', { directory, error })
      }
    }
  }

  /**
   * Connect to OpenCode for a worktree (lazy starts server if needed)
   */
  async connect(worktreePath: string, hiveSessionId: string): Promise<{ sessionId: string }> {
    log.info('Connecting to OpenCode', { worktreePath, hiveSessionId })

    const instance = await this.getOrCreateInstance()

    // Create a new OpenCode session for this directory
    try {
      const result = await instance.client.session.create({
        query: { directory: worktreePath }
      })
      const sessionId = result.data?.id

      if (!sessionId) {
        throw new Error('Failed to create OpenCode session: no session ID returned')
      }

      instance.sessionMap.set(sessionId, hiveSessionId)
      instance.sessionDirectories.set(sessionId, worktreePath)

      // Subscribe to events for this directory
      this.subscribeToDirectory(instance, worktreePath)

      log.info('Created OpenCode session', {
        sessionId,
        hiveSessionId,
        worktreePath,
        totalSessions: instance.sessionMap.size
      })

      return { sessionId }
    } catch (error) {
      log.error('Failed to create OpenCode session', { worktreePath, error })
      throw error
    }
  }

  /**
   * Try to reconnect to an existing OpenCode session
   */
  async reconnect(
    worktreePath: string,
    opencodeSessionId: string,
    hiveSessionId: string
  ): Promise<{ success: boolean }> {
    log.info('Attempting to reconnect to OpenCode session', { worktreePath, opencodeSessionId, hiveSessionId })

    try {
      const instance = await this.getOrCreateInstance()

      // Try to get the session
      const result = await instance.client.session.get({
        path: { id: opencodeSessionId },
        query: { directory: worktreePath }
      })

      if (result.data) {
        instance.sessionMap.set(opencodeSessionId, hiveSessionId)
        instance.sessionDirectories.set(opencodeSessionId, worktreePath)

        // Subscribe to events for this directory
        this.subscribeToDirectory(instance, worktreePath)

        log.info('Successfully reconnected to OpenCode session', { opencodeSessionId, hiveSessionId })
        return { success: true }
      }
    } catch (error) {
      log.warn('Failed to reconnect to OpenCode session', { opencodeSessionId, error })
    }

    return { success: false }
  }

  /**
   * Get available models from all configured providers
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getAvailableModels(): Promise<any> {
    log.info('Getting available models')

    const instance = await this.getOrCreateInstance()

    try {
      const result = await instance.client.config.providers()
      const providers = result.data?.providers || []
      log.info('Got available models', { providerCount: providers.length })
      return providers
    } catch (error) {
      log.error('Failed to get available models', { error })
      throw error
    }
  }

  /**
   * Get the selected model from settings DB, or fallback to DEFAULT_MODEL
   */
  private getSelectedModel(): { providerID: string; modelID: string } {
    try {
      const db = getDatabase()
      const value = db.getSetting(SELECTED_MODEL_DB_KEY)
      if (value) {
        const parsed = JSON.parse(value)
        if (parsed.providerID && parsed.modelID) {
          return parsed
        }
      }
    } catch (error) {
      log.warn('Failed to load selected model from DB, using default', { error })
    }
    return DEFAULT_MODEL
  }

  /**
   * Set the selected model in settings DB
   */
  setSelectedModel(model: { providerID: string; modelID: string }): void {
    try {
      const db = getDatabase()
      db.setSetting(SELECTED_MODEL_DB_KEY, JSON.stringify(model))
      log.info('Selected model saved', { model })
    } catch (error) {
      log.error('Failed to save selected model', { error })
      throw error
    }
  }

  /**
   * Send a prompt to an OpenCode session
   */
  async prompt(worktreePath: string, opencodeSessionId: string, message: string): Promise<void> {
    log.info('Sending prompt to OpenCode', { worktreePath, opencodeSessionId, messageLength: message.length })

    if (!this.instance) {
      throw new Error('No OpenCode instance available')
    }

    const model = this.getSelectedModel()
    log.info('Using model for prompt', { model })

    try {
      // Use promptAsync for non-blocking behavior - events will stream the response
      await this.instance.client.session.promptAsync({
        path: { id: opencodeSessionId },
        query: { directory: worktreePath },
        body: {
          model,
          parts: [{ type: 'text', text: message }]
        }
      })

      log.info('Prompt sent successfully', { opencodeSessionId })
    } catch (error) {
      log.error('Failed to send prompt', { opencodeSessionId, error })
      throw error
    }
  }

  /**
   * Get messages from an OpenCode session
   */
  async getMessages(worktreePath: string, opencodeSessionId: string): Promise<unknown[]> {
    if (!this.instance) {
      throw new Error('No OpenCode instance available')
    }

    try {
      const result = await this.instance.client.session.messages({
        path: { id: opencodeSessionId },
        query: { directory: worktreePath }
      })

      return result.data || []
    } catch (error) {
      log.error('Failed to get messages', { opencodeSessionId, error })
      throw error
    }
  }

  /**
   * Disconnect a session (may kill server if last session)
   */
  async disconnect(worktreePath: string, opencodeSessionId: string): Promise<void> {
    log.info('Disconnecting OpenCode session', { worktreePath, opencodeSessionId })

    if (!this.instance) {
      log.warn('No instance found for disconnect')
      return
    }

    // Unsubscribe from directory events
    this.unsubscribeFromDirectory(this.instance, worktreePath)

    this.instance.sessionMap.delete(opencodeSessionId)
    this.instance.sessionDirectories.delete(opencodeSessionId)

    log.info('Session disconnected', {
      opencodeSessionId,
      remainingSessions: this.instance.sessionMap.size
    })

    // Kill server when no more sessions
    if (this.instance.sessionMap.size === 0) {
      log.info('Killing OpenCode server (no more sessions)')
      this.shutdownServer()
    }
  }

  /**
   * Shutdown the OpenCode server
   */
  private shutdownServer(): void {
    if (!this.instance) return

    // Cancel all directory subscriptions
    for (const [directory, sub] of this.instance.directorySubscriptions) {
      log.info('Aborting subscription for directory', { directory })
      sub.controller.abort()
    }
    this.instance.directorySubscriptions.clear()

    // Close the server
    try {
      this.instance.server.close()
    } catch (error) {
      log.warn('Error closing OpenCode server', { error })
    }

    this.instance = null
  }

  /**
   * Handle a single event from OpenCode
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleEvent(instance: OpenCodeInstance, rawEvent: { data: unknown; event?: string }): void {
    // The event data might be a GlobalEvent (with directory/payload) or a direct event
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let event = rawEvent.data as any

    if (!event) {
      return
    }

    // Check if this is a GlobalEvent wrapper (has directory and payload)
    if (event.directory && event.payload) {
      event = event.payload
    }

    const eventType = event.type || rawEvent.event

    // Skip noisy events
    if (eventType === 'server.heartbeat' || eventType === 'server.connected') {
      return
    }

    log.info('Received event from OpenCode', {
      eventType,
      hasProperties: !!event.properties
    })

    // Special handling for session.error - log the full error
    if (eventType === 'session.error') {
      log.error('OpenCode session error', {
        sessionId: event.properties?.sessionID,
        error: event.properties?.error
      })
    }

    if (!eventType) {
      return
    }

    // Extract session ID based on event type structure
    let sessionId: string | undefined

    if (event.properties) {
      if (event.properties.part?.sessionID) {
        sessionId = event.properties.part.sessionID
      } else if (event.properties.info?.sessionID) {
        sessionId = event.properties.info.sessionID
      } else if (event.properties.sessionID) {
        sessionId = event.properties.sessionID
      }
    }

    if (!sessionId) {
      // Skip events without session ID
      return
    }

    // Get the Hive session ID for routing
    const hiveSessionId = instance.sessionMap.get(sessionId)
    if (!hiveSessionId) {
      log.warn('No Hive session found for OpenCode session', { sessionId })
      return
    }

    // Send event to renderer
    const streamEvent: StreamEvent = {
      type: eventType,
      sessionId: hiveSessionId,
      data: event.properties || event
    }

    log.info('Sending stream event to renderer', { eventType, hiveSessionId })
    this.sendToRenderer('opencode:stream', streamEvent)
  }

  /**
   * Send data to the renderer process
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private sendToRenderer(channel: string, data: any): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data)
    } else {
      log.warn('Cannot send to renderer: window not available')
    }
  }

  /**
   * Cleanup the OpenCode instance
   */
  async cleanup(): Promise<void> {
    log.info('Cleaning up OpenCode instance')
    this.shutdownServer()
  }
}

// Export singleton instance
export const openCodeService = new OpenCodeService()
