import { createLogger } from './logger'

const log = createLogger({ component: 'ClaudeSDKLoader' })

type ClaudeAgentSdkModule = typeof import('@anthropic-ai/claude-agent-sdk')

interface ClaudeSDK {
  query: ClaudeAgentSdkModule['query']
  /**
   * In-process MCP servers (tools that run inside this process, e.g. the database assistant's
   * schema tools). Optional because test doubles of the SDK often export `query` alone.
   */
  createSdkMcpServer?: ClaudeAgentSdkModule['createSdkMcpServer']
  tool?: ClaudeAgentSdkModule['tool']
}

let cachedSDK: ClaudeSDK | null = null

/**
 * Reads an optional export without throwing: vitest's factory mocks throw on access to an
 * export the factory did not define, and only `query` is required by every caller.
 */
function optionalExport<K extends keyof ClaudeAgentSdkModule>(
  sdk: ClaudeAgentSdkModule,
  name: K
): ClaudeAgentSdkModule[K] | undefined {
  try {
    return sdk[name]
  } catch {
    return undefined
  }
}

/**
 * Dynamically import the Claude Code SDK (ESM-only package).
 * Result is cached after first successful load.
 */
export async function loadClaudeSDK(): Promise<ClaudeSDK> {
  if (cachedSDK) return cachedSDK

  try {
    log.info('Loading Claude Code SDK')
    const sdk = await import('@anthropic-ai/claude-agent-sdk')
    cachedSDK = {
      query: sdk.query,
      createSdkMcpServer: optionalExport(sdk, 'createSdkMcpServer'),
      tool: optionalExport(sdk, 'tool')
    }
    log.info('Claude Code SDK loaded successfully')
    return cachedSDK
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error('Failed to load Claude Code SDK', error instanceof Error ? error : new Error(message))
    throw new Error(
      `Claude Code SDK could not be loaded: ${message}. ` +
        'Ensure @anthropic-ai/claude-agent-sdk is installed.'
    )
  }
}
