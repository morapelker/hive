import { EventEmitter } from 'node:events'
import type { ServerResponse } from 'node:http'
import type { OpenCodeStreamEvent } from '@shared/types/opencode'
import { DISCORD_CLAUDE_CLI_EVENT_CHANNEL } from '@shared/discord-events'
import { agentEventBus } from './agent-event-bus'
import { publishDesktopBackendEvent } from '../desktop/backend-event-publisher'
import { getDatabase } from '../db'
import type { DatabaseService } from '../db/database'
import { isDiscordModeEnabled } from './discord-config'
import {
  CliHookHoldCore,
  type ClaudeHookBody,
  type CliHookRouteContext
} from './cli-hook-hold-core'

// How long a session's "does Discord own this session?" DB answer is reused
// before re-querying. Hooks fire on every tool use, so the lookup must not hit
// SQLite each time; the TTL bounds how long a Discord enable/disable flip takes
// to affect an already-running session.
const OWNERSHIP_CACHE_TTL_MS = 3000

class ClaudeCliDiscordBridge {
  readonly name = 'discord'
  private readonly emitter = new EventEmitter()
  private db: DatabaseService | null = null
  private ownershipCache = new Map<string, { owned: boolean; expiresAt: number }>()
  // Sessions registered by the dynamic ownership check (vs an explicit
  // register() call); these are revoked when Discord mode turns off.
  private readonly autoRegistered = new Set<string>()
  private readonly core = new CliHookHoldCore({
    name: 'Discord',
    emitShared: (event) => {
      agentEventBus.publish(event)
      this.relayToBackend(event)
    },
    emitTransport: (event) => {
      this.emitter.emit('event', event)
      this.relayToBackend(event)
    }
  })

  constructor() {
    this.emitter.setMaxListeners(0)
  }

  setDatabase(db: DatabaseService | null): void {
    this.db = db
    this.ownershipCache.clear()
  }

  register(sessionId: string): void {
    this.core.register(sessionId)
  }

  isRegistered(sessionId: string): boolean {
    // Sessions started outside Discord (app UI, kanban tickets) are owned
    // dynamically: any claude-cli session whose worktree has a provisioned
    // Discord channel routes its hooks here while Discord mode is enabled.
    const owned = this.isDiscordOwnedSession(sessionId)
    if (owned) {
      if (!this.core.isRegistered(sessionId)) {
        this.core.register(sessionId)
        this.autoRegistered.add(sessionId)
      }
      return true
    }
    if (this.autoRegistered.has(sessionId)) {
      this.autoRegistered.delete(sessionId)
      this.core.cancelSession(sessionId)
      return false
    }
    return this.core.isRegistered(sessionId)
  }

  subscribe(listener: (event: OpenCodeStreamEvent) => void): () => void {
    this.emitter.on('event', listener)
    return () => this.emitter.off('event', listener)
  }

  onHook(
    sessionId: string,
    body: ClaudeHookBody,
    res: ServerResponse,
    ctx?: CliHookRouteContext
  ): boolean {
    return this.core.onHook(sessionId, body, res, ctx)
  }

  notifySessionIdle(sessionId: string, lastAssistantMessage?: string): void {
    this.core.emitSessionIdle(sessionId, lastAssistantMessage)
  }

  hasPendingQuestion(requestId: string): boolean {
    return this.core.hasPendingQuestion(requestId)
  }

  hasPendingPlan(requestId: string): boolean {
    return this.core.hasPendingPlan(requestId)
  }

  hasPendingPlanForSession(sessionId: string): boolean {
    return this.core.hasPendingPlanForSession(sessionId)
  }

  resolveQuestion(requestId: string, answers: string[][]): void {
    this.core.resolveQuestion(requestId, answers)
  }

  rejectQuestion(requestId: string): void {
    this.core.rejectQuestion(requestId)
  }

  resolvePlan(requestId: string, approve: boolean, feedback?: string): void {
    this.core.resolvePlan(requestId, approve, feedback)
  }

  cancelSession(sessionId: string): void {
    this.core.cancelSession(sessionId)
    this.ownershipCache.delete(sessionId)
    this.autoRegistered.delete(sessionId)
  }

  cancelAll(): void {
    this.core.cancelAll()
    this.ownershipCache.clear()
    this.autoRegistered.clear()
  }

  private relayToBackend(event: OpenCodeStreamEvent): void {
    // No-op in the backend server process (no desktop backend attached); in the
    // Electron main process this hands the event to the server child, where the
    // Discord session bridge posts to channels.
    void publishDesktopBackendEvent(DISCORD_CLAUDE_CLI_EVENT_CHANNEL, event)
  }

  private isDiscordOwnedSession(sessionId: string): boolean {
    const cached = this.ownershipCache.get(sessionId)
    if (cached && cached.expiresAt > Date.now()) return cached.owned

    let owned = false
    try {
      const db = this.getDb()
      const session = db.getSession(sessionId)
      if (session?.agent_sdk === 'claude-code-cli' && session.worktree_id) {
        owned =
          !!db.getDiscordChannelResourceByWorktree(session.worktree_id) &&
          isDiscordModeEnabled(db)
      }
    } catch {
      owned = false
    }

    this.ownershipCache.set(sessionId, { owned, expiresAt: Date.now() + OWNERSHIP_CACHE_TTL_MS })
    return owned
  }

  private getDb(): DatabaseService {
    if (!this.db) {
      this.db = getDatabase()
    }
    return this.db
  }
}

export const claudeCliDiscordBridge = new ClaudeCliDiscordBridge()
