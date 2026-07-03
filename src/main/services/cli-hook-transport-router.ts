import type { ServerResponse } from 'node:http'
import type { ClaudeHookBody, CliHookRouteContext } from './cli-hook-hold-core'
import { claudeCliDiscordBridge } from './claude-cli-discord-bridge'
import { claudeCliTelegramBridge } from './claude-cli-telegram-bridge'

export interface CliHookTransport {
  name: string
  isRegistered(sessionId: string): boolean
  onHook(
    sessionId: string,
    body: ClaudeHookBody,
    res: ServerResponse,
    ctx?: CliHookRouteContext
  ): boolean
  notifySessionIdle(sessionId: string, lastAssistantMessage?: string): void
  cancelAll(): void
}

export class CliHookTransportRouter {
  private readonly transports: CliHookTransport[]

  constructor(transports: CliHookTransport[]) {
    this.transports = transports
  }

  routeHook(
    sessionId: string,
    body: ClaudeHookBody,
    res: ServerResponse,
    ctx?: CliHookRouteContext
  ): boolean {
    const transport = this.transports.find((candidate) => candidate.isRegistered(sessionId))
    return transport?.onHook(sessionId, body, res, ctx) ?? false
  }

  notifySessionIdle(sessionId: string, lastAssistantMessage?: string): void {
    const transport = this.transports.find((candidate) => candidate.isRegistered(sessionId))
    transport?.notifySessionIdle(sessionId, lastAssistantMessage)
  }

  cancelAll(): void {
    for (const transport of this.transports) {
      transport.cancelAll()
    }
  }
}

export const cliHookTransportRouter = new CliHookTransportRouter([
  claudeCliDiscordBridge,
  claudeCliTelegramBridge
])
