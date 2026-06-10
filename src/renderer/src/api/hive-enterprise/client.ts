import { GraphQLClient } from 'graphql-request'
import { useSettingsStore, type AppSettings } from '@/stores/useSettingsStore'
import {
  MeDocument,
  RecordPromptIdleDocument,
  RecordPromptStartDocument,
  RecordQuestionsAnsweredDocument
} from './operations'
import type {
  GqlHiveEnterpriseMeQuery,
  GqlHiveEnterpriseRecordPromptIdleMutation,
  GqlHiveEnterpriseRecordPromptIdleMutationVariables,
  GqlHiveEnterpriseRecordPromptStartMutation,
  GqlHiveEnterpriseRecordPromptStartMutationVariables,
  GqlHiveEnterpriseRecordQuestionsAnsweredMutation,
  GqlHiveEnterpriseRecordQuestionsAnsweredMutationVariables
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
  const payload = settings.hiveOrganizationStorePrompts === false ? { ...input, prompt: '' } : input
  try {
    const data = await requestWithRefresh<
      GqlHiveEnterpriseRecordPromptStartMutation,
      GqlHiveEnterpriseRecordPromptStartMutationVariables
    >(RecordPromptStartDocument, { input: payload })
    await reconcileOrgSettings(data.recordPromptStart)
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
    const data = await requestWithRefresh<
      GqlHiveEnterpriseRecordPromptIdleMutation,
      GqlHiveEnterpriseRecordPromptIdleMutationVariables
    >(RecordPromptIdleDocument, { input })
    await reconcileOrgSettings(data.recordPromptIdle)
  } catch (error) {
    console.warn('[HiveEnterprise] recordPromptIdle failed:', error)
  }
}

export async function recordHiveQuestionsAnswered(
  input: GqlHiveEnterpriseRecordQuestionsAnsweredMutationVariables['input']
): Promise<void> {
  const settings = useSettingsStore.getState()
  if (!isHiveTelemetryEnabled(settings)) return
  if (settings.hiveOrganizationRecordQuestions === false) return
  try {
    const data = await requestWithRefresh<
      GqlHiveEnterpriseRecordQuestionsAnsweredMutation,
      GqlHiveEnterpriseRecordQuestionsAnsweredMutationVariables
    >(RecordQuestionsAnsweredDocument, { input })
    await reconcileOrgSettings(data.recordQuestionsAnswered)
  } catch (error) {
    console.warn('[HiveEnterprise] recordQuestionsAnswered failed:', error)
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
    hiveOrganizationName: me?.organization?.name ?? null,
    hiveOrganizationStorePrompts: me?.organization?.storePrompts ?? true,
    hiveOrganizationRecordQuestions: me?.organization?.recordQuestions ?? true
  })
}

// Every telemetry mutation echoes the org settings back, so each response is a
// chance to converge the local cache without an extra round-trip.
async function reconcileOrgSettings(result: {
  storePrompts?: boolean | null
  recordQuestions?: boolean | null
}): Promise<void> {
  const state = useSettingsStore.getState()
  const updates: Partial<AppSettings> = {}
  if (
    typeof result.storePrompts === 'boolean' &&
    result.storePrompts !== state.hiveOrganizationStorePrompts
  ) {
    updates.hiveOrganizationStorePrompts = result.storePrompts
  }
  if (
    typeof result.recordQuestions === 'boolean' &&
    result.recordQuestions !== state.hiveOrganizationRecordQuestions
  ) {
    updates.hiveOrganizationRecordQuestions = result.recordQuestions
  }
  if (Object.keys(updates).length > 0) {
    await useSettingsStore.getState().updateSettings(updates)
  }
}

export async function refreshHiveEnterpriseOrg(): Promise<void> {
  const settings = useSettingsStore.getState()
  if (!isHiveTelemetryEnabled(settings)) return
  try {
    const me = await fetchHiveEnterpriseMe()
    await useSettingsStore.getState().updateSettings({
      hiveLoggedInEmail: me?.email ?? null,
      hiveOrganizationId: me?.organization?.id ?? null,
      hiveOrganizationName: me?.organization?.name ?? null,
      hiveOrganizationStorePrompts: me?.organization?.storePrompts ?? true,
      hiveOrganizationRecordQuestions: me?.organization?.recordQuestions ?? true
    })
  } catch (error) {
    console.warn('[HiveEnterprise] org refresh failed:', error)
  }
}
