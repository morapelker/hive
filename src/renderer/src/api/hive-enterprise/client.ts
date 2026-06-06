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
  variables?: TVariables
): Promise<TData> {
  const settings = useSettingsStore.getState()
  if (!settings.hiveAuthToken) throw new Error('Hive Enterprise token is not set')

  const client = new GraphQLClient(endpointFromSettings(settings), {
    headers: {
      authorization: `Bearer ${settings.hiveAuthToken}`
    }
  })
  const response = await client.rawRequest<TData, TVariables>(document, variables)
  const refreshedToken = response.headers.get('x-hive-refreshed-token')
  if (refreshedToken && refreshedToken !== settings.hiveAuthToken) {
    await useSettingsStore.getState().updateSetting('hiveAuthToken', refreshedToken)
  }
  return response.data
}

export async function fetchHiveEnterpriseMe(): Promise<GqlHiveEnterpriseMeQuery['me']> {
  const data = await requestWithRefresh<GqlHiveEnterpriseMeQuery, Record<string, never>>(MeDocument)
  return data.me
}

export async function recordHivePromptStart(
  input: GqlHiveEnterpriseRecordPromptStartMutationVariables['input']
): Promise<void> {
  const settings = useSettingsStore.getState()
  if (!isHiveTelemetryEnabled(settings)) return
  try {
    await requestWithRefresh<
      GqlHiveEnterpriseRecordPromptStartMutation,
      GqlHiveEnterpriseRecordPromptStartMutationVariables
    >(RecordPromptStartDocument, { input })
  } catch (error) {
    console.warn('[HiveEnterprise] recordPromptStart failed:', error)
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
  await useSettingsStore.getState().updateSetting('hiveAuthToken', token)
  const me = await fetchHiveEnterpriseMe()
  await Promise.all([
    useSettingsStore.getState().updateSetting('hiveLoggedInEmail', me?.email ?? null),
    useSettingsStore.getState().updateSetting('hiveOrganizationId', me?.organization?.id ?? null),
    useSettingsStore
      .getState()
      .updateSetting('hiveOrganizationName', me?.organization?.name ?? null)
  ])
}
