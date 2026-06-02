import {
  encodeLocalEnvironmentBootstrapArg,
  type LocalEnvironmentBootstrap
} from '@shared/desktop-bridge'
import { getDesktopBackendBootstrap } from './backend-manager'

export const getDesktopPreloadBootstrapArguments = (
  bootstrap: LocalEnvironmentBootstrap | null = getDesktopBackendBootstrap()
): string[] => [encodeLocalEnvironmentBootstrapArg(bootstrap)]
