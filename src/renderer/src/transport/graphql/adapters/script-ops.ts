import { graphqlQuery, graphqlSubscribe } from '../client'
import type { ScriptOpsApi } from '../../types'

// Internal map of active subscriptions for proper cleanup
const activeSubscriptions = new Map<string, () => void>()

export function createScriptOpsAdapter(): ScriptOpsApi {
  return {
    // ─── Working via GraphQL ────────────────────────────────────
    async runSetup(
      commands: string[],
      cwd: string,
      worktreeId: string
    ): Promise<{ success: boolean; error?: string }> {
      const data = await graphqlQuery<{
        scriptRunSetup: { success: boolean; error?: string }
      }>(
        `mutation ($input: ScriptRunInput!) {
          scriptRunSetup(input: $input) { success error }
        }`,
        { input: { commands, cwd, worktreeId } }
      )
      return data.scriptRunSetup
    },

    async runProject(
      commands: string[],
      cwd: string,
      worktreeId: string
    ): Promise<{ success: boolean; pid?: number; error?: string }> {
      const data = await graphqlQuery<{
        scriptRunProject: { success: boolean; pid?: number; error?: string }
      }>(
        `mutation ($input: ScriptRunInput!) {
          scriptRunProject(input: $input) { success pid error }
        }`,
        { input: { commands, cwd, worktreeId } }
      )
      return data.scriptRunProject
    },

    async kill(worktreeId: string): Promise<{ success: boolean; error?: string }> {
      const data = await graphqlQuery<{
        scriptKill: { success: boolean; error?: string }
      }>(
        `mutation ($worktreeId: ID!) {
          scriptKill(worktreeId: $worktreeId) { success error }
        }`,
        { worktreeId }
      )
      return data.scriptKill
    },

    async runArchive(
      commands: string[],
      cwd: string
    ): Promise<{ success: boolean; output: string; error?: string }> {
      const data = await graphqlQuery<{
        scriptRunArchive: { success: boolean; output?: string; error?: string }
      }>(
        `mutation ($commands: [String!]!, $cwd: String!) {
          scriptRunArchive(commands: $commands, cwd: $cwd) { success output error }
        }`,
        { commands, cwd }
      )
      return {
        success: data.scriptRunArchive.success,
        output: data.scriptRunArchive.output ?? '',
        error: data.scriptRunArchive.error
      }
    },

    async getPort(cwd: string): Promise<{ port: number | null }> {
      const data = await graphqlQuery<{ scriptPort: number | null }>(
        `query ($cwd: String!) { scriptPort(cwd: $cwd) }`,
        { cwd }
      )
      return { port: data.scriptPort }
    },

    // ─── Subscriptions ──────────────────────────────────────────
    onOutput(
      channel: string,
      callback: (event: ScriptOutputEvent) => void
    ): () => void {
      // Clean up any existing subscription for this channel
      const existing = activeSubscriptions.get(channel)
      if (existing) existing()

      const worktreeId = channel
      const cleanup = graphqlSubscribe<{
        scriptOutput: { type: string; command?: string; data?: string; exitCode?: number }
      }>(
        `subscription ($worktreeId: ID!, $channel: String!) {
          scriptOutput(worktreeId: $worktreeId, channel: $channel) {
            type command data exitCode
          }
        }`,
        { worktreeId, channel },
        (event) => {
          callback(event.scriptOutput as ScriptOutputEvent)
        }
      )

      activeSubscriptions.set(channel, cleanup)
      return cleanup
    },

    offOutput(channel: string): void {
      const cleanup = activeSubscriptions.get(channel)
      if (cleanup) {
        cleanup()
        activeSubscriptions.delete(channel)
      }
    }
  }
}
