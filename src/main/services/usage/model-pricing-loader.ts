import { createLogger } from '../logger'
import { hasModelPricingTable, setModelPricingTable } from './pricing'

const log = createLogger({ component: 'ModelPricingLoader' })

/**
 * Loads the model price table from Hive Enterprise. The client has no bundled
 * prices and never talks to outside price sources — the server caches the
 * LiteLLM table in MySQL (~1 week TTL, stale-served on refresh failure) and
 * shares it across every client, so prices are fetched from outside at most
 * once per server per week.
 *
 * The table is kept in memory only and re-requested from the server at most
 * every REFRESH_INTERVAL_MS per app run. A failed refresh keeps using the
 * already-loaded table.
 */

const ModelPricesDocument = /* GraphQL */ `
  query HiveModelPrices {
    modelPrices {
      pricesJson
      fetchedAt
    }
  }
`

const REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000

type RequestGraphql = (
  endpoint: string,
  token: string,
  document: string,
  variables: Record<string, unknown>
) => Promise<unknown>

let loadedAt: number | null = null
let inflight: Promise<boolean> | null = null

/**
 * Ensure a price table is loaded, fetching from the server when none is
 * loaded yet or the in-memory copy is due for a refresh. Returns false only
 * when no table could be obtained at all — cost math must not run then.
 */
export function ensureModelPricing(
  context: { endpoint: string; token: string },
  request: RequestGraphql
): Promise<boolean> {
  if (loadedAt !== null && Date.now() - loadedAt < REFRESH_INTERVAL_MS && hasModelPricingTable()) {
    return Promise.resolve(true)
  }
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const data = (await request(context.endpoint, context.token, ModelPricesDocument, {})) as {
        modelPrices?: { pricesJson?: unknown } | null
      } | null
      const pricesJson = data?.modelPrices?.pricesJson
      if (typeof pricesJson !== 'string') {
        throw new Error('server returned no model prices')
      }
      setModelPricingTable(JSON.parse(pricesJson))
      if (!hasModelPricingTable()) throw new Error('server price table is empty')
      loadedAt = Date.now()
      return true
    } catch (error) {
      log.warn('Failed to load model prices from Hive Enterprise', {
        error: error instanceof Error ? error.message : String(error)
      })
      // Keep serving a previously loaded table; retry the refresh next call.
      return hasModelPricingTable()
    } finally {
      inflight = null
    }
  })()
  return inflight
}

export function __resetModelPricingLoaderForTests(): void {
  loadedAt = null
  inflight = null
}
