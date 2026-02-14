import { createLogger } from './logger'

const log = createLogger({ component: 'ClaudeSDKLoader' })

interface ClaudeSDK {
  query: typeof import('@anthropic-ai/claude-agent-sdk').query
}

let cachedSDK: ClaudeSDK | null = null

/**
 * Dynamically import the Claude Code SDK (ESM-only package).
 * Result is cached after first successful load.
 */
export async function loadClaudeSDK(): Promise<ClaudeSDK> {
  if (cachedSDK) return cachedSDK

  try {
    log.info('Loading Claude Code SDK')
    const sdk = await import('@anthropic-ai/claude-agent-sdk')
    cachedSDK = { query: sdk.query }
    log.info('Claude Code SDK loaded successfully')
    return cachedSDK
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error('Failed to load Claude Code SDK', undefined, { error: message })
    throw new Error(
      `Claude Code SDK could not be loaded: ${message}. ` +
        'Ensure @anthropic-ai/claude-agent-sdk is installed.'
    )
  }
}
