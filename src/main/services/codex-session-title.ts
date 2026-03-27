import { homedir } from 'node:os'

import { CodexAppServerManager, type CodexManagerEvent } from './codex-app-server-manager'
import { createLogger } from './logger'

const log = createLogger({ component: 'CodexSessionTitle' })

const TITLE_DEVELOPER_INSTRUCTIONS = `You are a title generator. You output ONLY a thread title. Nothing else.

<task>
Generate a brief title that would help the user find this conversation later.

Follow all rules in <rules>
Use the <examples> so you know what a good title looks like.
Your output must be:
- A single line
- ≤50 characters
- No explanations
</task>

<rules>
- you MUST use the same language as the user message you are summarizing
- Title must be grammatically correct and read naturally - no word salad
- Never include tool names in the title (e.g. "read tool", "bash tool", "edit tool")
- Focus on the main topic or question the user needs to retrieve
- Vary your phrasing - avoid repetitive patterns like always starting with "Analyzing"
- When a file is mentioned, focus on WHAT the user wants to do WITH the file, not just that they shared it
- Keep exact: technical terms, numbers, filenames, HTTP codes
- Remove: the, this, my, a, an
- Never assume tech stack
- Never use tools
- NEVER respond to questions, just generate a title for the conversation
- The title should NEVER include "summarizing" or "generating" when generating a title
- DO NOT SAY YOU CANNOT GENERATE A TITLE OR COMPLAIN ABOUT THE INPUT
- Always output something meaningful, even if the input is minimal.
- If the user message is short or conversational (e.g. "hello", "lol", "what's up", "hey"):
  → create a title that reflects the user's tone or intent (such as Greeting, Quick check-in, Light chat, Intro message, etc.)
</rules>

<examples>
"debug 500 errors in production" → Debugging production 500 errors
"refactor user service" → Refactoring user service
"why is app.js failing" → app.js failure investigation
"implement rate limiting" → Rate limiting implementation
"how do I connect postgres to my API" → Postgres API connection
"best practices for React hooks" → React hooks best practices
"@src/auth.ts can you add refresh token support" → Auth refresh token support
"@utils/parser.ts this is broken" → Parser bug fix
"look at @config.json" → Config review
"@App.tsx add dark mode toggle" → Dark mode toggle in App
</examples>`

const TITLE_TIMEOUT_MS = 15_000
const MAX_MESSAGE_LENGTH = 2000
const MAX_TITLE_LENGTH = 100
const TITLE_TRUNCATE_LENGTH = 97
const MAX_RETRIES = 2
const TITLE_MODEL = 'gpt-5.4'
const TITLE_PROMPT_PREFIX = 'Generate a title for this conversation:\n'

function postProcessTitle(raw: string): string | null {
  const stripped = raw.replace(/<think>[\s\S]*?<\/think>/g, '')
  const lines = stripped.split('\n').map((line) => line.trim())
  const title = lines.find((line) => line.length > 0) ?? ''

  if (!title) return null

  if (title.length > MAX_TITLE_LENGTH) {
    return title.slice(0, TITLE_TRUNCATE_LENGTH) + '...'
  }

  return title
}

function extractAssistantText(snapshot: unknown): string {
  if (!snapshot || typeof snapshot !== 'object') return ''

  const obj = snapshot as Record<string, unknown>
  const thread = (obj.thread as Record<string, unknown> | undefined) ?? obj
  const turns = Array.isArray(thread.turns) ? (thread.turns as unknown[]) : []

  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]
    if (!turn || typeof turn !== 'object') continue

    const turnObj = turn as Record<string, unknown>
    const outputText = typeof turnObj.outputText === 'string' ? turnObj.outputText : ''
    if (outputText.trim()) return outputText

    const output = Array.isArray(turnObj.output) ? turnObj.output : []
    for (const item of output) {
      if (!item || typeof item !== 'object') continue
      const itemObj = item as Record<string, unknown>
      if (itemObj.type === 'text' && typeof itemObj.text === 'string' && itemObj.text.trim()) {
        return itemObj.text
      }
    }

    const items = Array.isArray(turnObj.items) ? turnObj.items : []
    for (let j = items.length - 1; j >= 0; j--) {
      const item = items[j]
      if (!item || typeof item !== 'object') continue
      const itemObj = item as Record<string, unknown>
      const itemType = typeof itemObj.type === 'string' ? itemObj.type : ''
      if (
        (itemType === 'agentMessage' || itemType === 'plan') &&
        typeof itemObj.text === 'string' &&
        itemObj.text.trim()
      ) {
        return itemObj.text
      }
    }
  }

  return ''
}

function waitForTurnCompletion(
  manager: CodexAppServerManager,
  threadId: string,
  timeoutMs = TITLE_TIMEOUT_MS
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('Title generation turn timed out'))
    }, timeoutMs)

    const onEvent = (event: CodexManagerEvent) => {
      if (event.threadId !== threadId) return

      if (event.method === 'turn/completed') {
        cleanup()
        resolve()
        return
      }

      const isFatal =
        event.method === 'process/error' ||
        event.method === 'session/exited' ||
        event.method === 'session/closed'

      if (isFatal) {
        cleanup()
        reject(new Error(event.message ?? 'Codex title session exited unexpectedly'))
      }
    }

    const cleanup = () => {
      clearTimeout(timer)
      manager.removeListener('event', onEvent)
    }

    manager.on('event', onEvent)
  })
}

export async function generateCodexSessionTitle(
  message: string,
  worktreePath?: string
): Promise<string | null> {
  const truncatedMessage =
    message.length > MAX_MESSAGE_LENGTH ? message.slice(0, MAX_MESSAGE_LENGTH) + '...' : message

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const manager = new CodexAppServerManager()
    let threadId: string | null = null

    try {
      const session = await manager.startSession({
        cwd: worktreePath || homedir(),
        model: TITLE_MODEL
      })

      threadId = session.threadId
      if (!threadId) {
        throw new Error('Title session started without a thread id')
      }

      await manager.sendTurn(threadId, {
        model: TITLE_MODEL,
        reasoningEffort: 'low',
        developerInstructions: TITLE_DEVELOPER_INSTRUCTIONS,
        input: [
          { type: 'text', text: TITLE_PROMPT_PREFIX },
          { type: 'text', text: truncatedMessage }
        ]
      })

      await waitForTurnCompletion(manager, threadId)
      const snapshot = await manager.readThread(threadId)
      const title = postProcessTitle(extractAssistantText(snapshot))
      if (title) {
        log.info('generateCodexSessionTitle: generated', { title, attempt })
        return title
      }

      log.warn('generateCodexSessionTitle: empty title from Codex', { attempt })
    } catch (err) {
      log.warn('generateCodexSessionTitle: attempt failed', {
        attempt,
        error: err instanceof Error ? err.message : String(err)
      })
    } finally {
      if (threadId) {
        manager.stopSession(threadId)
      } else {
        manager.stopAll()
      }
      manager.removeAllListeners()
    }
  }

  log.warn('generateCodexSessionTitle: all attempts exhausted')
  return null
}

export const __testing__ = {
  extractAssistantText,
  postProcessTitle
}
