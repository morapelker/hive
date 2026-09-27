/**
 * Serves inline completions for the ticket editors from a model trained on the
 * user's own tickets (see src/shared/ticket-autocomplete/model.ts).
 *
 * Runs in the backend server process next to the database. The model is built
 * on first use (~0.1 s for a few thousand tickets) and kept in memory (a few
 * MB). It keeps learning: at most every `refreshIntervalMs` a suggest call
 * checks a cheap fingerprint of the tickets table after answering, and when
 * the ticket text actually changed the model is rebuilt from scratch. Nothing
 * leaves the machine and nothing is written to disk.
 */
import { createHash } from 'node:crypto'
import {
  TicketAutocompleteModel,
  type TicketAutocompleteModelStats,
  type TicketAutocompleteSuggestion
} from '@shared/ticket-autocomplete/model'
import { createLogger } from './logger'

const log = createLogger({ component: 'TicketAutocomplete' })

export interface TicketAutocompleteCorpusSource {
  /** Changes whenever the corpus may have changed. Must be cheap. */
  fingerprint(): string
  /** Every document to learn from, oldest first. */
  documents(): string[]
}

export interface TicketAutocompleteStatus extends TicketAutocompleteModelStats {
  /** Epoch ms of the last rebuild, null before the first one. */
  builtAt: number | null
  /** Duration of the last rebuild. */
  buildMs: number | null
}

export interface TicketAutocompleteServiceOptions {
  source: TicketAutocompleteCorpusSource
  refreshIntervalMs?: number
  now?: () => number
  /** Runs the background freshness check; tests pass a synchronous one. */
  defer?: (task: () => void) => void
}

const DEFAULT_REFRESH_INTERVAL_MS = 10_000

export class TicketAutocompleteService {
  private readonly source: TicketAutocompleteCorpusSource
  private readonly refreshIntervalMs: number
  private readonly now: () => number
  private readonly defer: (task: () => void) => void

  private model: TicketAutocompleteModel | null = null
  private fingerprint: string | null = null
  private contentHash: string | null = null
  private lastCheckAt = Number.NEGATIVE_INFINITY
  private refreshQueued = false
  private builtAt: number | null = null
  private buildMs: number | null = null

  constructor(options: TicketAutocompleteServiceOptions) {
    this.source = options.source
    this.refreshIntervalMs = options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS
    this.now = options.now ?? Date.now
    this.defer = options.defer ?? ((task) => setImmediate(task))
  }

  suggest(before: string): TicketAutocompleteSuggestion | null {
    if (!this.model) this.refresh()
    else this.queueRefreshIfDue()
    return this.model?.suggest(before) ?? null
  }

  status(): TicketAutocompleteStatus {
    if (!this.model) this.refresh()
    const stats = this.model?.stats ?? { documents: 0, tokens: 0, vocabulary: 0 }
    return { ...stats, builtAt: this.builtAt, buildMs: this.buildMs }
  }

  /** Re-read the corpus if it changed and rebuild the model if its text did. */
  refresh(): void {
    this.lastCheckAt = this.now()
    try {
      const fingerprint = this.source.fingerprint()
      if (this.model && fingerprint === this.fingerprint) return
      this.fingerprint = fingerprint

      const documents = this.source.documents()
      const hash = hashDocuments(documents)
      if (this.model && hash === this.contentHash) return

      const start = performance.now()
      const model = new TicketAutocompleteModel(documents)
      this.buildMs = Math.round(performance.now() - start)
      this.builtAt = this.now()
      this.model = model
      this.contentHash = hash
      log.info('Ticket autocomplete model built', { ...model.stats, buildMs: this.buildMs })
    } catch (error) {
      // Keep serving the previous model; try again on the next interval.
      this.fingerprint = null
      log.warn('Ticket autocomplete refresh failed', {
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  private queueRefreshIfDue(): void {
    if (this.refreshQueued) return
    if (this.now() - this.lastCheckAt < this.refreshIntervalMs) return
    this.refreshQueued = true
    this.defer(() => {
      this.refreshQueued = false
      this.refresh()
    })
  }
}

function hashDocuments(documents: string[]): string {
  const hash = createHash('sha1')
  for (const document of documents) {
    hash.update(document)
    hash.update('\u0000')
  }
  return hash.digest('hex')
}

let liveService: TicketAutocompleteService | null = null

/** The process-wide service, reading tickets from the app database. */
export async function getTicketAutocompleteService(): Promise<TicketAutocompleteService> {
  if (liveService) return liveService
  const { getDatabase } = await import('../db')
  liveService = new TicketAutocompleteService({
    source: {
      fingerprint: () => getDatabase().getTicketAutocompleteFingerprint(),
      documents: () => getDatabase().getTicketAutocompleteCorpus()
    }
  })
  return liveService
}
