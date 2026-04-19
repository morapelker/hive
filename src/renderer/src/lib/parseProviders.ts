export interface ModelInfo {
  id: string
  name?: string
  providerID: string
  variants?: Record<string, Record<string, unknown>>
}

export interface ProviderModels {
  providerID: string
  providerName: string
  models: ModelInfo[]
}

function toProviderList(data: unknown): unknown[] {
  if (Array.isArray(data)) return data
  if (typeof data !== 'object' || data === null) return []

  const record = data as { providers?: unknown }
  return Array.isArray(record.providers) ? record.providers : []
}

export function parseProviders(data: unknown): ProviderModels[] {
  const providers = toProviderList(data)
  const result: ProviderModels[] = []

  for (const provider of providers) {
    if (typeof provider !== 'object' || provider === null) continue

    const providerRecord = provider as {
      id?: unknown
      name?: unknown
      models?: unknown
    }
    const providerID = typeof providerRecord.id === 'string' ? providerRecord.id : 'unknown'
    const modelsRecord =
      typeof providerRecord.models === 'object' && providerRecord.models !== null
        ? (providerRecord.models as Record<string, unknown>)
        : {}

    const models: ModelInfo[] = []
    for (const [modelID, modelData] of Object.entries(modelsRecord)) {
      if (typeof modelData !== 'object' || modelData === null) continue

      const modelRecord = modelData as {
        id?: unknown
        name?: unknown
        variants?: unknown
      }
      const variants =
        typeof modelRecord.variants === 'object' && modelRecord.variants !== null
          ? (modelRecord.variants as Record<string, Record<string, unknown>>)
          : undefined

      models.push({
        id: typeof modelRecord.id === 'string' ? modelRecord.id : modelID,
        name: typeof modelRecord.name === 'string' ? modelRecord.name : undefined,
        providerID,
        variants
      })
    }

    if (models.length === 0) continue

    result.push({
      providerID,
      providerName:
        typeof providerRecord.name === 'string' && providerRecord.name.trim().length > 0
          ? providerRecord.name
          : providerID.charAt(0).toUpperCase() + providerID.slice(1),
      models
    })
  }

  return result
}

export function getModelDisplayName(model: Pick<ModelInfo, 'id' | 'name'>): string {
  return model.name || model.id
}

export function getModelVariantKeys(model: Pick<ModelInfo, 'variants'>): string[] {
  if (!model.variants) return []
  return Object.keys(model.variants)
}

export function findModelInfo(
  providers: ProviderModels[],
  providerID: string,
  modelID: string
): ModelInfo | null {
  for (const provider of providers) {
    if (provider.providerID !== providerID) continue

    const match = provider.models.find((model) => model.id === modelID)
    if (match) return match
  }

  return null
}

export function getFirstModelInfo(providers: ProviderModels[]): ModelInfo | null {
  for (const provider of providers) {
    const firstModel = provider.models[0]
    if (firstModel) return firstModel
  }

  return null
}
