import {
  isDesktopCommandResult,
  makeDesktopCommandRequest,
  type DiscordClaudeCliPlanReplyPayload,
  type DiscordClaudeCliQuestionRejectPayload,
  type DiscordClaudeCliQuestionReplyPayload,
  type DiscordClaudeCliReplyResult
} from '@shared/desktop-command'

type DiscordClaudeCliCommandName =
  | 'discordClaudeCliQuestionReply'
  | 'discordClaudeCliQuestionReject'
  | 'discordClaudeCliPlanReply'

type DiscordClaudeCliCommandPayload =
  | DiscordClaudeCliQuestionReplyPayload
  | DiscordClaudeCliQuestionRejectPayload
  | DiscordClaudeCliPlanReplyPayload

type ProcessWithIpc = NodeJS.Process & {
  send?: (message: unknown, callback?: (error: Error | null) => void) => boolean
}

function makeRequest(
  id: string,
  command: DiscordClaudeCliCommandName,
  payload: DiscordClaudeCliCommandPayload
) {
  if (command === 'discordClaudeCliQuestionReply') {
    return makeDesktopCommandRequest(id, command, payload as DiscordClaudeCliQuestionReplyPayload)
  }
  if (command === 'discordClaudeCliQuestionReject') {
    return makeDesktopCommandRequest(id, command, payload as DiscordClaudeCliQuestionRejectPayload)
  }
  return makeDesktopCommandRequest(id, command, payload as DiscordClaudeCliPlanReplyPayload)
}

/**
 * Forward a Discord-held Claude CLI reply from the backend server process to
 * the Electron main process, where the PTY + hook server (and thus the held
 * hook response) live. Returns null when not running as a desktop backend
 * child (no IPC channel), so callers can fall through to in-process handling.
 */
export async function requestDiscordClaudeCliCommand(
  command: DiscordClaudeCliCommandName,
  payload: DiscordClaudeCliCommandPayload
): Promise<DiscordClaudeCliReplyResult | null> {
  if (process.env.HIVE_SERVER_MODE !== 'desktop' || !process.env.HIVE_DESKTOP_BOOTSTRAP_TOKEN) {
    return null
  }
  const ipcProcess = process as ProcessWithIpc
  const send = ipcProcess.send
  if (typeof send !== 'function') return null

  const id = `discord-claude-cli-${Date.now()}-${Math.random().toString(36).slice(2)}`
  return await new Promise<DiscordClaudeCliReplyResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`${command} timed out`))
    }, 5_000)
    const cleanup = (): void => {
      clearTimeout(timeout)
      process.off('message', onMessage)
    }
    const onMessage = (message: unknown): void => {
      if (!isDesktopCommandResult(message) || message.id !== id) return
      cleanup()
      if (!message.ok) {
        reject(new Error(message.error))
        return
      }
      resolve((message.value ?? { success: true }) as DiscordClaudeCliReplyResult)
    }

    process.on('message', onMessage)
    const request = makeRequest(id, command, payload)
    send.call(process, request, (error) => {
      if (!error) return
      cleanup()
      reject(error)
    })
  })
}
