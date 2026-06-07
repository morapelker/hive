import { GraphQLClient } from 'graphql-request'
import { useSettingsStore, type AppSettings } from '@/stores/useSettingsStore'
import {
  MeDocument,
  RecordPromptIdleDocument,
  RecordPromptStartDocument
} from './operations'
import type {
  GqlHiveEnterpriseMeQuery,
  GqlHiveEnterpriseRecordPromptIdleMutation,
  GqlHiveEnterpriseRecordPromptIdleMutationVariables,
  GqlHiveEnterpriseRecordPromptStartMutation,
  GqlHiveEnterpriseRecordPromptStartMutationVariables
} from './generated'

type TelemetryGateSettings = Pick<AppSettings, 'hiveAuthToken' | 'hiveOrganizationId'>

export function isHiveTelemetryEnabled(settings: TelemetryGateSettings): boolean {
  return Boolean(settings.hiveAuthToken && settings.hiveOrganizationId)
}

function endpointFromSettings(settings: AppSettings): string {
  return `${settings.hiveEnterpriseServerUrl.replace(/\/+$/, '')}/api/graphql`
}

async function requestWithRefresh<TData, TVariables extends Record<string, unknown>>(
  document: string,
  variables?: TVariables,
  tokenOverride?: string
): Promise<TData> {
  const settings = useSettingsStore.getState()
  const authToken = tokenOverride ?? settings.hiveAuthToken
  if (!authToken) throw new Error('Hive Enterprise token is not set')

  const client = new GraphQLClient(endpointFromSettings(settings), {
    headers: {
      authorization: `Bearer ${authToken}`
    }
  })
  const response = await client.rawRequest<TData, TVariables>(document, variables)
  const refreshedToken = response.headers.get('x-hive-refreshed-token')
  // Only persist a refresh when acting on the already-stored token; during initial
  // login the caller is responsible for committing the token after verification.
  if (!tokenOverride && refreshedToken && refreshedToken !== settings.hiveAuthToken) {
    await useSettingsStore.getState().updateSetting('hiveAuthToken', refreshedToken)
  }
  return response.data
}

export async function fetchHiveEnterpriseMe(
  tokenOverride?: string
): Promise<GqlHiveEnterpriseMeQuery['me']> {
  const data = await requestWithRefresh<GqlHiveEnterpriseMeQuery, Record<string, never>>(
    MeDocument,
    undefined,
    tokenOverride
  )
  return data.me
}

export async function recordHivePromptStart(
  input: GqlHiveEnterpriseRecordPromptStartMutationVariables['input']
): Promise<string | null> {
  const settings = useSettingsStore.getState()
  if (!isHiveTelemetryEnabled(settings)) return null
  try {
    const data = await requestWithRefresh<
      GqlHiveEnterpriseRecordPromptStartMutation,
      GqlHiveEnterpriseRecordPromptStartMutationVariables
    >(RecordPromptStartDocument, { input })
    return data.recordPromptStart.promptId ?? null
  } catch (error) {
    console.warn('[HiveEnterprise] recordPromptStart failed:', error)
    return null
  }
}

export async function recordHivePromptIdle(
  input: GqlHiveEnterpriseRecordPromptIdleMutationVariables['input']
): Promise<void> {
  const settings = useSettingsStore.getState()
  if (!isHiveTelemetryEnabled(settings)) return
  try {
    await requestWithRefresh<
      GqlHiveEnterpriseRecordPromptIdleMutation,
      GqlHiveEnterpriseRecordPromptIdleMutationVariables
    >(RecordPromptIdleDocument, { input })
  } catch (error) {
    console.warn('[HiveEnterprise] recordPromptIdle failed:', error)
  }
}

export async function completeHiveEnterpriseLogin(token: string): Promise<void> {
  // Verify the token before persisting anything so a failed lookup can't leave a
  // stored token without an associated identity. Commit token + identity atomically.
  const me = await fetchHiveEnterpriseMe(token)
  await useSettingsStore.getState().updateSettings({
    hiveAuthToken: token,
    hiveLoggedInEmail: me?.email ?? null,
    hiveOrganizationId: me?.organization?.id ?? null,
    hiveOrganizationName: me?.organization?.name ?? null
  })
}
