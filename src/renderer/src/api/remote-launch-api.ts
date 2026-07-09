import type { ServerEvent } from '@shared/rpc/protocol'
import {
  REMOTE_LAUNCH_STEPS,
  remoteLaunchProgressChannel,
  type RemoteLaunchKillResult,
  type RemoteLaunchPreflightParams,
  type RemoteLaunchPreflightResult,
  type RemoteLaunchProgressEvent,
  type RemoteLaunchStartParams,
  type RemoteLaunchStartResult,
  type RemoteLaunchStopParams
} from '@shared/types/remote-launch'
import { getRendererRpcClient } from './rpc-client'
import type { BackendTarget } from './environment'

const REMOTE_LAUNCH_STEP_SET = new Set<string>(REMOTE_LAUNCH_STEPS)
const REMOTE_LAUNCH_STATUS_SET = new Set(['running', 'done', 'error'])

const isRemoteLaunchProgressEvent = (value: unknown): value is RemoteLaunchProgressEvent => {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (typeof record.step !== 'string' || !REMOTE_LAUNCH_STEP_SET.has(record.step)) return false
  if (typeof record.status !== 'string' || !REMOTE_LAUNCH_STATUS_SET.has(record.status)) {
    return false
  }
  if ('error' in record && record.error !== undefined && typeof record.error !== 'string') {
    return false
  }
  if ('detail' in record && record.detail !== undefined && typeof record.detail !== 'string') {
    return false
  }
  return true
}

export const remoteLaunchApi = {
  preflight: async (params: RemoteLaunchPreflightParams): Promise<RemoteLaunchPreflightResult> =>
    getRendererRpcClient().request<RemoteLaunchPreflightResult>(
      'remoteLaunchOps.preflight',
      params
    ),
  start: async (params: RemoteLaunchStartParams): Promise<RemoteLaunchStartResult> =>
    getRendererRpcClient().request<RemoteLaunchStartResult>('remoteLaunchOps.start', params),
  stop: async (params: RemoteLaunchStopParams): Promise<RemoteLaunchKillResult> =>
    getRendererRpcClient().request<RemoteLaunchKillResult>('remoteLaunchOps.stop', params),
  onProgress: (launchId: string, cb: (e: RemoteLaunchProgressEvent) => void): (() => void) =>
    getRendererRpcClient().subscribe(
      remoteLaunchProgressChannel(launchId),
      (event: ServerEvent) => {
        if (isRemoteLaunchProgressEvent(event.payload)) cb(event.payload)
      }
    )
}

/**
 * Renderer-side copy of `targetFromSettings` in
 * src/main/services/teleport-remote-client.ts — same trim/normalize/`/ws`
 * subpath-preserving semantics, but returning a full `BackendTarget` (with
 * `source`) so it can be handed straight to a `HiveClient` for attach-dialog
 * use (Task 8).
 */
export function remoteTargetFromUrl(url: string, bootstrapToken: string): BackendTarget {
  const httpUrl = new URL(url)
  httpUrl.hash = ''
  httpUrl.search = ''
  httpUrl.pathname = httpUrl.pathname.replace(/\/+$/, '')
  const httpBaseUrl = httpUrl.toString().replace(/\/+$/, '')

  const wsUrl = new URL(httpBaseUrl)
  wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:'
  // Append '/ws' to the configured base path rather than replacing it, so
  // sub-path deployments (e.g. https://host/hive) connect to the right
  // endpoint. Root URLs (empty pathname) still resolve to '/ws'. Mirrors
  // targetFromSettings exactly.
  wsUrl.pathname = `${wsUrl.pathname.replace(/\/+$/, '')}/ws`

  return {
    httpBaseUrl,
    wsBaseUrl: wsUrl.toString().replace(/\/+$/, ''),
    bootstrapToken,
    source: 'desktop'
  }
}
