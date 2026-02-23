import type { Resolvers } from '../../__generated__/resolvers-types'
import { getLogDir } from '../../../main/services/logger'
import { detectAgentSdks, getAppPaths, getAppVersion } from '../../../main/services/system-info'

export const systemQueryResolvers: Resolvers = {
  Query: {
    systemLogDir: () => getLogDir(),
    systemAppVersion: () => getAppVersion(),
    systemAppPaths: () => getAppPaths(),
    systemDetectAgentSdks: () => detectAgentSdks(),
    systemServerStatus: () => ({
      uptime: Math.floor(process.uptime()),
      connections: 0,
      requestCount: 0,
      locked: false,
      version: getAppVersion()
    })
  }
}
