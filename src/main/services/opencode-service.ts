import type { BrowserWindow } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { createLogger } from './logger'
import { notificationService } from './notification-service'
import { getDatabase } from '../db'
import { CITY_NAMES } from './city-names'
import { canonicalizeBranchName, createGitService } from './git-service'

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
  childSessionId?: string
  /** session.status event payload -- only present when type === 'session.status' */
  statusPayload?: {
    type: 'idle' | 'busy' | 'retry'
    attempt?: number
    message?: string
    next?: number
  }
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
  // Map of directory-scoped OpenCode session keys to Hive session IDs for routing events
  sessionMap: Map<string, string>
  // Map of directory-scoped OpenCode session keys to worktree paths
  sessionDirectories: Map<string, string>
  // Map of directory paths to their event subscriptions
  directorySubscriptions: Map<string, DirectorySubscription>
  // Map of directory-scoped child/subagent OpenCode session keys to parent OpenCode session IDs
  childToParentMap: Map<string, string>
}

// Dynamic import helper for ESM SDK
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadOpenCodeSDK(): Promise<{ createOpencode: any; createOpencodeClient: any }> {
  // Dynamic import for ESM module
  const sdk = await import('@opencode-ai/sdk')
  return sdk
}

/**
 * Spawn `opencode serve` without forcing a port, letting it auto-assign one.
 * Parses the listening URL from stdout.
 */
function spawnOpenCodeServer(
  options: { hostname?: string; timeout?: number; signal?: AbortSignal } = {}
): Promise<{ url: string; close(): void }> {
  const hostname = options.hostname ?? '127.0.0.1'
  const timeout = options.timeout ?? 10000

  const args = ['serve', `--hostname=${hostname}`]
  const proc: ChildProcess = spawn('opencode', args, {
    signal: options.signal,
    env: { ...process.env }
  })

  const url = new Promise<string>((resolve, reject) => {
    const id = setTimeout(() => {
      reject(new Error(`Timeout waiting for opencode server to start after ${timeout}ms`))
    }, timeout)

    let output = ''
    proc.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString()
      const lines = output.split('\n')
      for (const line of lines) {
        if (line.startsWith('opencode server listening')) {
          const match = line.match(/on\s+(https?:\/\/[^\s]+)/)
          if (!match) {
            clearTimeout(id)
            reject(new Error(`Failed to parse server url from output: ${line}`))
            return
          }
          clearTimeout(id)
          resolve(match[1])
          return
        }
      }
    })

    proc.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })

    proc.on('exit', (code) => {
      clearTimeout(id)
      let msg = `opencode server exited with code ${code}`
      if (output.trim()) {
        msg += `\nServer output: ${output}`
      }
      reject(new Error(msg))
    })

    proc.on('error', (error) => {
      clearTimeout(id)
      reject(error)
    })

    if (options.signal) {
      options.signal.addEventListener('abort', () => {
        clearTimeout(id)
        reject(new Error('Aborted'))
      })
    }
  })

  return url.then((resolvedUrl) => ({
    url: resolvedUrl,
    close() {
      proc.kill()
    }
  }))
}

class OpenCodeService {
  // Single server instance (OpenCode handles multiple directories via query params)
  private instance: OpenCodeInstance | null = null
  private mainWindow: BrowserWindow | null = null
  private pendingConnection: Promise<OpenCodeInstance> | null = null
  // Last prompt text per Hive session — used to detect SDK echoes of user
  // messages when the event payload lacks a role field.
  private lastPromptBySession: Map<string, string> = new Map()

  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window
  }

  private getSessionMapKey(directory: string, opencodeSessionId: string): string {
    return `${directory}::${opencodeSessionId}`
  }

  private getChildParentKey(directory: string, childSessionId: string): string {
    return `${directory}::${childSessionId}`
  }

  private setSessionMapping(
    instance: OpenCodeInstance,
    directory: string,
    opencodeSessionId: string,
    hiveSessionId: string
  ): void {
    const key = this.getSessionMapKey(directory, opencodeSessionId)
    instance.sessionMap.set(key, hiveSessionId)
    instance.sessionDirectories.set(key, directory)
  }

  private migrateLegacySessionMapping(
    instance: OpenCodeInstance,
    directory: string,
    opencodeSessionId: string
  ): void {
    // Legacy mapping keyed only by opencodeSessionId (pre-directory scoping).
    const legacyMapped = instance.sessionMap.get(opencodeSessionId)
    if (legacyMapped !== undefined) {
      this.setSessionMapping(instance, directory, opencodeSessionId, legacyMapped)
      instance.sessionMap.delete(opencodeSessionId)
    }

    const legacyDirectory = instance.sessionDirectories.get(opencodeSessionId)
    if (legacyDirectory !== undefined) {
      instance.sessionDirectories.delete(opencodeSessionId)
    }
  }

  private getMappedHiveSessionId(
    instance: OpenCodeInstance,
    opencodeSessionId: string,
    directory?: string
  ): string | undefined {
    if (directory) {
      const scoped = instance.sessionMap.get(this.getSessionMapKey(directory, opencodeSessionId))
      if (scoped) return scoped
    }

    const legacy = instance.sessionMap.get(opencodeSessionId)
    if (legacy) return legacy

    if (!directory) return undefined

    // Compatibility fallback for mixed-state maps.
    const scopedSuffix = `::${opencodeSessionId}`
    for (const [key, hiveSessionId] of instance.sessionMap.entries()) {
      if (key.endsWith(scopedSuffix)) {
        return hiveSessionId
      }
    }

    return undefined
  }

  private toIsoTimestamp(value: unknown): string | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return new Date(value).toISOString()
    }
    if (typeof value !== 'string') return undefined

    const asNumber = Number(value)
    if (Number.isFinite(asNumber)) {
      return new Date(asNumber).toISOString()
    }

    const asDate = Date.parse(value)
    if (Number.isNaN(asDate)) return undefined
    return new Date(asDate).toISOString()
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private parseJsonArray(value: string | null): any[] {
    if (!value) return []
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private buildTextContentFromParts(parts: any[]): string {
    return parts
      .filter((part) => part?.type === 'text')
      .map((part) => (typeof part.text === 'string' ? part.text : ''))
      .join('')
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private extractEventMessageRole(eventData: any): string | undefined {
    return (
      eventData?.message?.role ??
      eventData?.info?.role ??
      eventData?.part?.role ??
      eventData?.role ??
      eventData?.properties?.message?.role ??
      eventData?.properties?.info?.role ??
      eventData?.properties?.part?.role ??
      eventData?.properties?.role ??
      eventData?.metadata?.role ??
      eventData?.content?.role
    )
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private extractEventMessageId(eventData: any): string | null {
    const messageId =
      eventData?.message?.id ??
      eventData?.info?.messageID ??
      eventData?.info?.messageId ??
      eventData?.info?.id ??
      eventData?.part?.messageID ??
      eventData?.part?.messageId ??
      eventData?.part?.message_id ??
      eventData?.properties?.message?.id ??
      eventData?.properties?.info?.messageID ??
      eventData?.properties?.info?.messageId ??
      eventData?.properties?.info?.id ??
      eventData?.properties?.part?.messageID ??
      eventData?.properties?.part?.messageId ??
      eventData?.properties?.part?.message_id

    return typeof messageId === 'string' && messageId.length > 0 ? messageId : null
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private mergeUpdatedPart(existingParts: any[], part: any, delta?: string): any[] {
    const nextParts = [...existingParts]
    const identity = part?.id ?? part?.callID
    const existingIndex = nextParts.findIndex((p) => {
      if (identity === undefined || identity === null) return false
      return (p?.id ?? p?.callID) === identity
    })

    if (existingIndex >= 0) {
      // Preserve text accumulation when SDK sends delta updates for the same part.
      if (part?.type === 'text' && typeof delta === 'string' && delta.length > 0) {
        const previousText =
          typeof nextParts[existingIndex]?.text === 'string' ? nextParts[existingIndex].text : ''
        nextParts[existingIndex] = {
          ...part,
          text: previousText + delta
        }
      } else {
        nextParts[existingIndex] = part
      }
      return nextParts
    }

    // New part in timeline.
    if (
      part?.type === 'text' &&
      typeof delta === 'string' &&
      delta.length > 0 &&
      typeof part?.text !== 'string'
    ) {
      nextParts.push({ ...part, text: delta })
    } else {
      nextParts.push(part)
    }

    return nextParts
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private persistStreamEvent(hiveSessionId: string, eventType: string, eventData: any): void {
    try {
      const db = getDatabase()
      const role = this.extractEventMessageRole(eventData)
      const messageId = this.extractEventMessageId(eventData)

      if (eventType === 'message.part.updated') {
        const part = eventData?.part
        // Skip only explicit user echoes; the SDK often omits the role
        // field on streaming payloads, so undefined role == assistant.
        if (role === 'user') return
        if (!part || !messageId) return

        // Content-based echo detection: if the incoming text matches the
        // prompt we just sent, it's an SDK echo of the user message.
        const lastPrompt = this.lastPromptBySession.get(hiveSessionId)
        if (lastPrompt && part.type === 'text') {
          const incoming = (eventData?.delta || part.text || '').trimEnd()
          if (incoming.length > 0 && lastPrompt.startsWith(incoming)) {
            return // echo — skip persistence
          }
          // First non-matching text means the real assistant response started
          this.lastPromptBySession.delete(hiveSessionId)
        }

        const existing = db.getSessionMessageByOpenCodeId(hiveSessionId, messageId)
        const existingParts = this.parseJsonArray(existing?.opencode_parts_json ?? null)
        const existingTimeline = this.parseJsonArray(existing?.opencode_timeline_json ?? null)
        const nextParts = this.mergeUpdatedPart(existingParts, part, eventData?.delta)
        const nextTimeline = [
          ...existingTimeline,
          {
            type: 'message.part.updated',
            delta: eventData?.delta,
            part
          }
        ]

        db.upsertSessionMessageByOpenCodeId({
          session_id: hiveSessionId,
          role: 'assistant',
          opencode_message_id: messageId,
          content: this.buildTextContentFromParts(nextParts),
          opencode_message_json: existing?.opencode_message_json ?? null,
          opencode_parts_json: JSON.stringify(nextParts),
          opencode_timeline_json: JSON.stringify(nextTimeline)
        })
        return
      }

      if (eventType === 'message.updated') {
        const info = eventData?.info
        // Skip only explicit user echoes (see message.part.updated above).
        if (role === 'user') return
        if (!messageId) return

        // Content-based echo detection for message.updated
        const lastPromptForUpdate = this.lastPromptBySession.get(hiveSessionId)
        if (lastPromptForUpdate) {
          const msgParts = Array.isArray(eventData?.parts) ? eventData.parts : []
          const textContent = msgParts
            .filter((p: { type?: string }) => p?.type === 'text')
            .map((p: { text?: string }) => p?.text || '')
            .join('')
            .trimEnd()
          if (textContent.length > 0 && lastPromptForUpdate.startsWith(textContent)) {
            return // echo — skip persistence
          }
        }

        const existing = db.getSessionMessageByOpenCodeId(hiveSessionId, messageId)
        const existingParts = this.parseJsonArray(existing?.opencode_parts_json ?? null)
        const existingTimeline = this.parseJsonArray(existing?.opencode_timeline_json ?? null)
        const messageParts = Array.isArray(eventData?.parts) ? eventData.parts : existingParts
        const nextTimeline = [
          ...existingTimeline,
          {
            type: 'message.updated',
            info
          }
        ]

        db.upsertSessionMessageByOpenCodeId({
          session_id: hiveSessionId,
          role: 'assistant',
          opencode_message_id: messageId,
          content: this.buildTextContentFromParts(messageParts),
          opencode_message_json: JSON.stringify(info),
          opencode_parts_json: JSON.stringify(messageParts),
          opencode_timeline_json: JSON.stringify(nextTimeline),
          created_at: this.toIsoTimestamp(info?.time?.created)
        })
      }
    } catch (error) {
      log.warn('Failed to persist stream event', { hiveSessionId, eventType, error })
    }
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
        // Load SDK dynamically (we only need the client, we spawn the server ourselves)
        const { createOpencodeClient } = await loadOpenCodeSDK()

        // Spawn opencode serve without --port so it auto-assigns an available port
        const server = await spawnOpenCodeServer()
        log.info('OpenCode server started', { url: server.url })

        // Create the SDK client pointing at the auto-assigned URL
        const client = createOpencodeClient({ baseUrl: server.url })

        const instance: OpenCodeInstance = {
          client,
          server,
          sessionMap: new Map(),
          sessionDirectories: new Map(),
          directorySubscriptions: new Map(),
          childToParentMap: new Map()
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
      log.info('Incremented subscription count for directory', {
        directory,
        count: sub.sessionCount
      })
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
        await this.handleEvent(instance, { data: event }, directory)
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

      this.setSessionMapping(instance, worktreePath, sessionId, hiveSessionId)

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
   * Query the current status of an OpenCode session (idle/busy/retry).
   * Returns undefined if the status could not be determined.
   */
  private async querySessionStatus(
    instance: OpenCodeInstance,
    worktreePath: string,
    opencodeSessionId: string
  ): Promise<'idle' | 'busy' | 'retry' | undefined> {
    try {
      const result = await instance.client.session.status({
        query: { directory: worktreePath }
      })
      // result.data is { [sessionId]: SessionStatus }
      const statusMap = result.data as Record<string, { type: string }> | undefined
      if (statusMap && statusMap[opencodeSessionId]) {
        return statusMap[opencodeSessionId].type as 'idle' | 'busy' | 'retry'
      }
    } catch (error) {
      log.warn('Failed to query session status', { opencodeSessionId, error })
    }
    return undefined
  }

  /**
   * Try to reconnect to an existing OpenCode session
   */
  async reconnect(
    worktreePath: string,
    opencodeSessionId: string,
    hiveSessionId: string
  ): Promise<{ success: boolean; sessionStatus?: 'idle' | 'busy' | 'retry' }> {
    log.info('Attempting to reconnect to OpenCode session', {
      worktreePath,
      opencodeSessionId,
      hiveSessionId
    })

    try {
      const instance = await this.getOrCreateInstance()
      const scopedKey = this.getSessionMapKey(worktreePath, opencodeSessionId)
      this.migrateLegacySessionMapping(instance, worktreePath, opencodeSessionId)

      // If session is already registered (e.g., user switched projects and back),
      // just update the Hive session mapping. Skip subscription to avoid count leak.
      if (instance.sessionMap.has(scopedKey)) {
        instance.sessionMap.set(scopedKey, hiveSessionId)
        log.info('Session already registered, updated mapping', {
          opencodeSessionId,
          hiveSessionId
        })
        const sessionStatus = await this.querySessionStatus(
          instance,
          worktreePath,
          opencodeSessionId
        )
        return { success: true, sessionStatus }
      }

      // Try to get the session
      const result = await instance.client.session.get({
        path: { id: opencodeSessionId },
        query: { directory: worktreePath }
      })

      if (result.data) {
        this.setSessionMapping(instance, worktreePath, opencodeSessionId, hiveSessionId)

        // Subscribe to events for this directory
        this.subscribeToDirectory(instance, worktreePath)

        const sessionStatus = await this.querySessionStatus(
          instance,
          worktreePath,
          opencodeSessionId
        )
        log.info('Successfully reconnected to OpenCode session', {
          opencodeSessionId,
          hiveSessionId,
          sessionStatus
        })
        return { success: true, sessionStatus }
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
   * Get model info (name, context limit) for a specific model
   */
  async getModelInfo(
    _worktreePath: string,
    modelId: string
  ): Promise<{
    id: string
    name: string
    limit: { context: number; input?: number; output: number }
  } | null> {
    log.info('Getting model info', { modelId })

    const instance = await this.getOrCreateInstance()

    try {
      const result = await instance.client.config.providers()
      const providers = result.data?.providers || []

      for (const provider of providers) {
        const models = provider.models || {}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const model = models[modelId] as any
        if (model) {
          return {
            id: modelId,
            name: model.name || modelId,
            limit: {
              context: model.limit?.context || 0,
              input: model.limit?.input,
              output: model.limit?.output || 0
            }
          }
        }
      }

      log.warn('Model not found in any provider', { modelId })
      return null
    } catch (error) {
      log.error('Failed to get model info', { modelId, error })
      throw error
    }
  }

  /**
   * Get the selected model from settings DB, or fallback to DEFAULT_MODEL
   */
  private getSelectedModel(): { providerID: string; modelID: string; variant?: string } {
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
  setSelectedModel(model: { providerID: string; modelID: string; variant?: string }): void {
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
   * Send a prompt to an OpenCode session.
   * Accepts either a parts array (text + file parts) or a plain string for backward compatibility.
   */
  async prompt(
    worktreePath: string,
    opencodeSessionId: string,
    messageOrParts:
      | string
      | Array<
          | { type: 'text'; text: string }
          | { type: 'file'; mime: string; url: string; filename?: string }
        >
  ): Promise<void> {
    const parts =
      typeof messageOrParts === 'string'
        ? [{ type: 'text' as const, text: messageOrParts }]
        : messageOrParts

    log.info('Sending prompt to OpenCode', {
      worktreePath,
      opencodeSessionId,
      partsCount: parts.length
    })

    if (!this.instance) {
      throw new Error('No OpenCode instance available')
    }

    // Store prompt text so persistStreamEvent can detect echoed user messages.
    const hiveId = this.getMappedHiveSessionId(this.instance, opencodeSessionId, worktreePath)
    if (hiveId) {
      const textContent = parts
        .filter((p) => p.type === 'text')
        .map((p) => ('text' in p ? p.text : ''))
        .join('')
      if (textContent.length > 0) {
        this.lastPromptBySession.set(hiveId, textContent)
      }
    }

    const { variant, ...model } = this.getSelectedModel()
    log.info('Using model for prompt', { model, variant })

    try {
      // Use promptAsync for non-blocking behavior - events will stream the response
      await this.instance.client.session.promptAsync({
        path: { id: opencodeSessionId },
        query: { directory: worktreePath },
        body: {
          model,
          variant,
          parts
        }
      })

      log.info('Prompt sent successfully', { opencodeSessionId })
    } catch (error) {
      log.error('Failed to send prompt', { opencodeSessionId, error })
      throw error
    }
  }

  /**
   * Abort a streaming session
   */
  async abort(worktreePath: string, opencodeSessionId: string): Promise<boolean> {
    if (!this.instance?.client) {
      throw new Error('No OpenCode instance for worktree')
    }

    const result = await this.instance.client.session.abort({
      path: { id: opencodeSessionId },
      query: { directory: worktreePath }
    })

    return result.data === true
  }

  /**
   * Reply to a pending question from the AI
   * Uses direct HTTP since v1 SDK lacks the question namespace (available in v2)
   */
  async questionReply(
    requestId: string,
    answers: string[][],
    worktreePath?: string
  ): Promise<void> {
    const instance = await this.getOrCreateInstance()
    const url = new URL(`/question/${encodeURIComponent(requestId)}/reply`, instance.server.url)
    if (worktreePath) url.searchParams.set('directory', worktreePath)
    const resp = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers })
    })
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new Error(`Question reply failed (${resp.status}): ${text}`)
    }
  }

  /**
   * Reject/dismiss a pending question from the AI
   * Uses direct HTTP since v1 SDK lacks the question namespace (available in v2)
   */
  async questionReject(requestId: string, worktreePath?: string): Promise<void> {
    const instance = await this.getOrCreateInstance()
    const url = new URL(`/question/${encodeURIComponent(requestId)}/reject`, instance.server.url)
    if (worktreePath) url.searchParams.set('directory', worktreePath)
    const resp = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    })
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new Error(`Question reject failed (${resp.status}): ${text}`)
    }
  }

  /**
   * Reply to a pending permission request from the AI
   * Uses direct HTTP since v1 SDK lacks the permission namespace
   */
  async permissionReply(
    requestId: string,
    reply: 'once' | 'always' | 'reject',
    worktreePath?: string,
    message?: string
  ): Promise<void> {
    const instance = await this.getOrCreateInstance()
    const url = new URL(`/permission/${encodeURIComponent(requestId)}/reply`, instance.server.url)
    if (worktreePath) url.searchParams.set('directory', worktreePath)
    const body: Record<string, string> = { reply }
    if (message) body.message = message
    const resp = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new Error(`Permission reply failed (${resp.status}): ${text}`)
    }
  }

  /**
   * List pending permission requests
   * Uses direct HTTP since v1 SDK lacks the permission namespace
   */
  async permissionList(worktreePath?: string): Promise<unknown[]> {
    const instance = await this.getOrCreateInstance()
    const url = new URL('/permission', instance.server.url)
    if (worktreePath) url.searchParams.set('directory', worktreePath)
    const resp = await fetch(url.toString(), {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    })
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new Error(`Permission list failed (${resp.status}): ${text}`)
    }
    const data = await resp.json()
    return Array.isArray(data) ? data : (data?.data ?? [])
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

    const scopedKey = this.getSessionMapKey(worktreePath, opencodeSessionId)
    this.instance.sessionMap.delete(scopedKey)
    this.instance.sessionDirectories.delete(scopedKey)
    // Legacy cleanup
    this.instance.sessionMap.delete(opencodeSessionId)
    this.instance.sessionDirectories.delete(opencodeSessionId)

    // Clean up child-to-parent mappings that reference this parent
    for (const [childId, parentId] of this.instance.childToParentMap) {
      if (parentId === opencodeSessionId) {
        this.instance.childToParentMap.delete(childId)
      }
    }

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
    this.instance.childToParentMap.clear()

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
  private async handleEvent(
    instance: OpenCodeInstance,
    rawEvent: { data: unknown; event?: string },
    directory?: string
  ): Promise<void> {
    // The event data might be a GlobalEvent (with directory/payload) or a direct event
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let event = rawEvent.data as any

    if (!event) {
      return
    }

    // Capture directory from GlobalEvent wrapper before unwrapping
    let eventDirectory = directory
    if (event.directory && event.payload) {
      eventDirectory = event.directory
      event = event.payload
    }

    const eventType = event.type || rawEvent.event

    // Skip noisy events
    if (eventType === 'server.heartbeat' || eventType === 'server.connected') {
      return
    }

    // Log errors, skip logging for routine events
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
      } else if (event.properties.info?.id) {
        // session.created/updated/deleted use properties.info (a Session object with `id`)
        sessionId = event.properties.info.id
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

    // Get the Hive session ID for routing — check parent session if this is a child/subagent
    const directHiveId = this.getMappedHiveSessionId(instance, sessionId, eventDirectory)
    let hiveSessionId = directHiveId

    if (!hiveSessionId) {
      const parentId = await this.resolveParentSession(instance, sessionId, eventDirectory)
      if (parentId) {
        hiveSessionId = this.getMappedHiveSessionId(instance, parentId, eventDirectory)
      }
    }

    if (!hiveSessionId) {
      log.warn('No Hive session found for OpenCode session', { sessionId })
      return
    }

    // Detect child/subagent events: no direct mapping but resolved through parent
    const isChildEvent = !directHiveId && !!hiveSessionId

    // Log session lifecycle events and trigger notification when unfocused
    if (eventType === 'session.idle') {
      log.info('Forwarding session.idle to renderer', {
        opencodeSessionId: sessionId,
        hiveSessionId,
        isChildEvent
      })
      // Only notify for parent session completion, not child/subagent sessions
      if (!isChildEvent) {
        this.maybeNotifySessionComplete(hiveSessionId)
      }
    }

    // Handle session.updated events — persist title to DB before forwarding to renderer
    // The SDK event structure is: { properties: { info: Session } } where Session has { id, title, ... }
    if (eventType === 'session.updated') {
      const sessionInfo = event.properties?.info
      const sessionTitle = sessionInfo?.title || event.properties?.title
      if (hiveSessionId && sessionTitle) {
        try {
          const db = getDatabase()
          db.updateSession(hiveSessionId, { name: sessionTitle })

          // Auto-rename branch if still a city name (one-time only)
          // Skip placeholder titles like "New session - 2026-02-10T15:26:38.962Z"
          // — only rename when we get a real AI-generated title
          const isPlaceholderTitle = /^New session\s*-/i.test(sessionTitle)
          const worktree = db.getWorktreeBySessionId(hiveSessionId)
          if (worktree && !worktree.branch_renamed && !isPlaceholderTitle) {
            const isCityName = CITY_NAMES.some(
              (city) => city.toLowerCase() === worktree.branch_name.toLowerCase()
            )
            if (isCityName) {
              const baseBranch = canonicalizeBranchName(sessionTitle)
              if (baseBranch && baseBranch !== worktree.branch_name.toLowerCase()) {
                try {
                  const gitService = createGitService(worktree.path)

                  // Find an available branch name, appending -2, -3, etc. if needed
                  let targetBranch = baseBranch
                  const exists = await gitService.branchExists(targetBranch)
                  if (exists) {
                    let found = false
                    for (let i = 2; i <= 10; i++) {
                      const candidate = `${baseBranch}-${i}`
                      if (!(await gitService.branchExists(candidate))) {
                        targetBranch = candidate
                        found = true
                        break
                      }
                    }
                    if (!found) {
                      // All suffixes taken — give up but stop retrying
                      db.updateWorktree(worktree.id, { branch_renamed: 1 })
                      log.warn('Auto-rename: all branch name variants taken', {
                        baseBranch,
                        worktreeId: worktree.id
                      })
                      // fall through without renaming
                      targetBranch = ''
                    }
                  }

                  if (targetBranch) {
                    const renameResult = await gitService.renameBranch(
                      worktree.path,
                      worktree.branch_name,
                      targetBranch
                    )
                    if (renameResult.success) {
                      db.updateWorktree(worktree.id, {
                        name: targetBranch,
                        branch_name: targetBranch,
                        branch_renamed: 1
                      })
                      // Notify renderer to update the sidebar
                      this.sendToRenderer('worktree:branchRenamed', {
                        worktreeId: worktree.id,
                        newBranch: targetBranch
                      })
                      log.info('Auto-renamed branch from city name', {
                        worktreeId: worktree.id,
                        oldBranch: worktree.branch_name,
                        newBranch: targetBranch
                      })
                    } else {
                      // Hard failure (e.g. permissions) — stop retrying
                      db.updateWorktree(worktree.id, { branch_renamed: 1 })
                      log.warn('Failed to auto-rename branch', {
                        error: renameResult.error
                      })
                    }
                  }
                } catch (err) {
                  // Unexpected error — stop retrying
                  db.updateWorktree(worktree.id, { branch_renamed: 1 })
                  log.warn('Failed to auto-rename branch', { err })
                }
              }
            }
          }
        } catch (err) {
          log.warn('Failed to persist session title from server', { err })
        }
      }
    }

    // Only persist events from the parent session as top-level messages.
    // Child/subagent events will be rendered inside SubtaskCards, not as standalone messages.
    if (!isChildEvent) {
      this.persistStreamEvent(hiveSessionId, eventType, event.properties || event)
    }

    // Send event to renderer
    const streamEvent: StreamEvent = {
      type: eventType,
      sessionId: hiveSessionId,
      data: event.properties || event,
      ...(isChildEvent ? { childSessionId: sessionId } : {}),
      ...(eventType === 'session.status' && event.properties?.status
        ? { statusPayload: event.properties.status }
        : {})
    }

    this.sendToRenderer('opencode:stream', streamEvent)
  }

  /**
   * Resolve a child/subagent session ID to its parent session ID.
   * Checks the cache first, then queries the SDK.
   */
  private async resolveParentSession(
    instance: OpenCodeInstance,
    childSessionId: string,
    directory?: string
  ): Promise<string | undefined> {
    if (!directory) return undefined

    const key = this.getChildParentKey(directory, childSessionId)
    // Check cache first (empty string = known non-child, skip lookup)
    const cached = instance.childToParentMap.get(key)
    if (cached !== undefined) {
      return cached || undefined
    }

    try {
      const result = await instance.client.session.get({
        path: { id: childSessionId },
        query: { directory }
      })

      const parentID = result.data?.parentID
      if (parentID) {
        instance.childToParentMap.set(key, parentID)
        log.info('Resolved child session to parent', { childSessionId, parentSessionId: parentID })
        return parentID
      }

      // Not a child session — cache to avoid repeated lookups
      instance.childToParentMap.set(key, '')
      return undefined
    } catch (error) {
      log.warn('Failed to resolve parent session', { childSessionId, error })
      return undefined
    }
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
   * Show a native notification when a session completes while the app window is unfocused
   */
  private maybeNotifySessionComplete(hiveSessionId: string): void {
    try {
      // Only notify when the window is not focused
      if (!this.mainWindow || this.mainWindow.isDestroyed() || this.mainWindow.isFocused()) {
        return
      }

      const db = getDatabase()
      const session = db.getSession(hiveSessionId)
      if (!session) {
        log.warn('Cannot notify: session not found', { hiveSessionId })
        return
      }

      const project = db.getProject(session.project_id)
      if (!project) {
        log.warn('Cannot notify: project not found', { projectId: session.project_id })
        return
      }

      notificationService.showSessionComplete({
        projectName: project.name,
        sessionName: session.name || 'Untitled',
        projectId: session.project_id,
        worktreeId: session.worktree_id || '',
        sessionId: hiveSessionId
      })
    } catch (error) {
      log.warn('Failed to show session completion notification', { hiveSessionId, error })
    }
  }

  /**
   * List available slash commands from the OpenCode SDK
   */
  async listCommands(worktreePath: string): Promise<
    Array<{
      name: string
      description?: string
      template: string
      agent?: string
      model?: string
      source?: string
      subtask?: boolean
      hints?: string[]
    }>
  > {
    const instance = await this.getOrCreateInstance()

    try {
      const result = await instance.client.command.list({
        query: { directory: worktreePath }
      })
      return result.data || []
    } catch (error) {
      log.warn('Failed to list commands', { worktreePath, error })
      return []
    }
  }

  /**
   * Send a slash command to a session via the SDK command endpoint
   */
  async sendCommand(
    worktreePath: string,
    opencodeSessionId: string,
    command: string,
    args: string
  ): Promise<void> {
    if (!this.instance) {
      throw new Error('No OpenCode instance available')
    }
    const { variant, ...model } = this.getSelectedModel()
    await this.instance.client.session.command({
      path: { id: opencodeSessionId },
      query: { directory: worktreePath },
      body: {
        command,
        arguments: args,
        model: `${model.providerID}/${model.modelID}`,
        variant
      }
    })
  }

  /**
   * Rename a session's title via the OpenCode PATCH API
   */
  async renameSession(
    opencodeSessionId: string,
    title: string,
    worktreePath?: string
  ): Promise<void> {
    const instance = await this.getOrCreateInstance()
    await instance.client.session.patch({
      path: { sessionID: opencodeSessionId },
      query: worktreePath ? { directory: worktreePath } : undefined,
      body: { title }
    })
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
