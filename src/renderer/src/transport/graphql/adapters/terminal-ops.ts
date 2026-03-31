import { graphqlQuery, graphqlMutate, graphqlSubscribe } from '../client'
import { notAvailableInWeb } from '../../stubs/electron-only'
import type { TerminalOpsApi } from '../../types'

export function createTerminalOpsAdapter(): TerminalOpsApi {
  return {
    // ─── Working via GraphQL ────────────────────────────────────
    async create(
      worktreeId: string,
      cwd: string,
      shell?: string
    ): Promise<{ success: boolean; cols?: number; rows?: number; error?: string }> {
      const data = await graphqlQuery<{
        terminalCreate: { success: boolean; cols?: number; rows?: number; error?: string }
      }>(
        `mutation ($worktreeId: ID!, $cwd: String!, $shell: String) {
          terminalCreate(worktreeId: $worktreeId, cwd: $cwd, shell: $shell) {
            success cols rows error
          }
        }`,
        { worktreeId, cwd, shell }
      )
      return data.terminalCreate
    },

    write(worktreeId: string, data: string): void {
      // Fire-and-forget over WebSocket for lower latency
      graphqlMutate(
        `mutation ($worktreeId: ID!, $data: String!) {
          terminalWrite(worktreeId: $worktreeId, data: $data)
        }`,
        { worktreeId, data }
      )
    },

    async resize(worktreeId: string, cols: number, rows: number): Promise<void> {
      await graphqlQuery<{ terminalResize: boolean }>(
        `mutation ($worktreeId: ID!, $cols: Int!, $rows: Int!) {
          terminalResize(worktreeId: $worktreeId, cols: $cols, rows: $rows)
        }`,
        { worktreeId, cols, rows }
      )
    },

    async destroy(worktreeId: string): Promise<void> {
      await graphqlQuery<{ terminalDestroy: boolean }>(
        `mutation ($worktreeId: ID!) {
          terminalDestroy(worktreeId: $worktreeId)
        }`,
        { worktreeId }
      )
    },

    async getConfig(): Promise<GhosttyTerminalConfig> {
      return {
        fontFamily: 'monospace',
        fontSize: 14
      }
    },

    onData(worktreeId: string, callback: (data: string) => void): () => void {
      const subId = `[sub_${Date.now()}_${Math.random().toString(36).substr(2, 4)}]`
      console.log(`[TERMINAL_OPS onData] ${subId} CREATING subscription for worktreeId=${worktreeId}`)
      const cleanup = graphqlSubscribe<{ terminalData: { worktreeId: string; data: string } }>(
        `subscription ($worktreeId: ID!) {
          terminalData(worktreeId: $worktreeId) { worktreeId data }
        }`,
        { worktreeId },
        (event) => {
          console.log(`[TERMINAL_OPS onData] ${subId} RECEIVED data length=${event.terminalData.data.length}`)
          callback(event.terminalData.data)
        }
      )
      return () => {
        console.log(`[TERMINAL_OPS onData] ${subId} CLEANUP called for worktreeId=${worktreeId}`)
        cleanup()
      }
    },

    onExit(worktreeId: string, callback: (code: number) => void): () => void {
      const subId = `[exitSub_${Date.now()}_${Math.random().toString(36).substr(2, 4)}]`
      console.log(`[TERMINAL_OPS onExit] ${subId} CREATING subscription for worktreeId=${worktreeId}`)
      const cleanup = graphqlSubscribe<{ terminalExit: { worktreeId: string; code: number } }>(
        `subscription ($worktreeId: ID!) {
          terminalExit(worktreeId: $worktreeId) { worktreeId code }
        }`,
        { worktreeId },
        (event) => {
          console.log(`[TERMINAL_OPS onExit] ${subId} RECEIVED exit code=${event.terminalExit.code}`)
          callback(event.terminalExit.code)
        }
      )
      return () => {
        console.log(`[TERMINAL_OPS onExit] ${subId} CLEANUP called for worktreeId=${worktreeId}`)
        cleanup()
      }
    },

    // ─── Ghostty stubs (not available in web mode) ──────────────
    ghosttyInit: async () => ({ success: false, error: 'Not available in web mode' }),

    ghosttyIsAvailable: async () => ({ available: false, initialized: false, platform: 'web' }),

    ghosttyCreateSurface: notAvailableInWeb('ghosttyCreateSurface') as unknown as (
      worktreeId: string,
      rect: { x: number; y: number; w: number; h: number },
      opts?: { cwd?: string; shell?: string; scaleFactor?: number; fontSize?: number }
    ) => Promise<{ success: boolean; surfaceId?: number; error?: string }>,

    ghosttySetFrame: notAvailableInWeb('ghosttySetFrame') as unknown as (
      worktreeId: string,
      rect: { x: number; y: number; w: number; h: number }
    ) => Promise<void>,

    ghosttySetSize: notAvailableInWeb('ghosttySetSize') as unknown as (
      worktreeId: string,
      width: number,
      height: number
    ) => Promise<void>,

    ghosttyKeyEvent: notAvailableInWeb('ghosttyKeyEvent') as unknown as (
      worktreeId: string,
      event: {
        action: number
        keycode: number
        mods: number
        consumedMods?: number
        text?: string
        unshiftedCodepoint?: number
        composing?: boolean
      }
    ) => Promise<boolean>,

    ghosttyMouseButton: notAvailableInWeb('ghosttyMouseButton') as unknown as (
      worktreeId: string,
      state: number,
      button: number,
      mods: number
    ) => Promise<void>,

    ghosttyMousePos: notAvailableInWeb('ghosttyMousePos') as unknown as (
      worktreeId: string,
      x: number,
      y: number,
      mods: number
    ) => Promise<void>,

    ghosttyMouseScroll: notAvailableInWeb('ghosttyMouseScroll') as unknown as (
      worktreeId: string,
      dx: number,
      dy: number,
      mods: number
    ) => Promise<void>,

    ghosttySetFocus: notAvailableInWeb('ghosttySetFocus') as unknown as (
      worktreeId: string,
      focused: boolean
    ) => Promise<void>,

    ghosttyPasteText: notAvailableInWeb('ghosttyPasteText') as unknown as (
      worktreeId: string,
      text: string
    ) => Promise<void>,

    ghosttyDestroySurface: notAvailableInWeb('ghosttyDestroySurface') as unknown as (
      worktreeId: string
    ) => Promise<void>,

    ghosttyShutdown: notAvailableInWeb('ghosttyShutdown') as unknown as () => Promise<void>
  }
}
