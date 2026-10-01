import type { ServerEvent } from '@shared/rpc/protocol'
import {
  cliToolOutputChannel,
  type CliToolActionResult,
  type CliToolId,
  type CliToolOutputEvent,
  type CliToolsListing
} from '@shared/types/cli-tools'
import { getRendererRpcClient } from './rpc-client'

const OUTPUT_EVENT_TYPES = ['command-start', 'output', 'error', 'done', 'long-running']

const isCliToolOutputEvent = (value: unknown): value is CliToolOutputEvent =>
  typeof value === 'object' &&
  value !== null &&
  'type' in value &&
  typeof value.type === 'string' &&
  OUTPUT_EVENT_TYPES.includes(value.type)

export const cliToolsApi = {
  list: async (projectPath: string): Promise<CliToolsListing> =>
    getRendererRpcClient().request<CliToolsListing>('cliToolsOps.list', { path: projectPath }),
  install: async (toolId: CliToolId, projectPath: string): Promise<CliToolActionResult> =>
    getRendererRpcClient().request<CliToolActionResult>('cliToolsOps.install', {
      toolId,
      path: projectPath
    }),
  installSkill: async (toolId: CliToolId, projectPath: string): Promise<CliToolActionResult> =>
    getRendererRpcClient().request<CliToolActionResult>('cliToolsOps.installSkill', {
      toolId,
      path: projectPath
    }),
  /** Output streamed while `install` / `installSkill` run for the tool. */
  onOutput: (toolId: CliToolId, callback: (event: CliToolOutputEvent) => void): (() => void) =>
    getRendererRpcClient().subscribe(cliToolOutputChannel(toolId), (event: ServerEvent) => {
      if (isCliToolOutputEvent(event.payload)) callback(event.payload)
    })
}
