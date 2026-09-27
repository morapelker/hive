/**
 * Ticket autocomplete model.
 *
 * A tiny, fully local language model over the user's own ticket text. It is a
 * suffix-array "infinite-gram" model: the whole learned corpus is kept as one
 * token array, a sorted array of suffix positions makes "every place I typed
 * these last few words" a binary search, and the words that followed those
 * places are the prediction. Longer contexts are tried first and the model
 * backs off to shorter ones only when the long context has too little data.
 *
 * Why not a neural model: the corpus is a few thousand short documents by one
 * author, phrased very repetitively. A count-based model captures that
 * verbatim, learns instantly (rebuild is a sort), needs no download, no native
 * module and a few megabytes of memory, and answers in microseconds.
 *
 * Pure TypeScript with no runtime dependencies so it can be unit-tested and
 * evaluated with plain Node (see scripts/ticket-autocomplete-eval.ts).
 */

/** Token id that separates documents and marks the start of each one. */
const BOUNDARY = 0
/** Id for a token never seen in the corpus. Matches nothing. */
const UNKNOWN = -2
/** Compared as "smaller than any token" for suffixes that run off the end. */
const END = -1

/**
 * Only the tail of the text before the caret matters (the model matches at
 * most `maxContext` tokens), so long documents are cut to this many chars.
 */
const TAIL_CHARS = 1500

/** Words are runs of non-whitespace; a newline is its own token. */
const TOKEN_RE = /\n|[^\s]+/g

export function tokenize(text: string): string[] {
  return text.match(TOKEN_RE) ?? []
}

export interface TicketAutocompleteSuggestion {
  /** Text to insert at the caret. */
  text: string
  /** Share of past occurrences that continued with the first predicted token (0..1). */
  confidence: number
  /** Number of past occurrences backing the first predicted token. */
  support: number
  /** Number of context tokens that were matched for the first prediction. */
  contextLength: number
}

export interface TicketAutocompleteModelOptions {
  /** Longest context (in tokens) the model matches. Default 6. */
  maxContext?: number
  /** Confidence gates; defaults to DEFAULT_THRESHOLDS. */
  thresholds?: Partial<TicketAutocompleteThresholds>
}

export interface SuggestOptions {
  /** Upper bound on predicted tokens (words and newlines). Default 12. */
  maxTokens?: number
  /** Stop the suggestion before a newline. Default true. */
  stopAtNewline?: boolean
}

export interface TicketAutocompleteModelStats {
  documents: number
  tokens: number
  vocabulary: number
}

interface Candidate {
  /** Lower-cased token id (the decision is case-insensitive). */
  id: number
  /** Most frequent surface form among the matches. */
  surface: string
  /** Occurrences of this token after the context. */
  count: number
  /** All occurrences of the context (including ones that ended the document). */
  total: number
}

interface Step {
  candidate: Candidate
  contextLength: number
}

/**
 * How sure the model must be before it shows anything. "Share" is the
 * fraction of past occurrences of the context that continued with the
 * predicted word; "support" is how many times that happened.
 */
export interface TicketAutocompleteThresholds {
  /** Completing a word from a single typed letter. */
  prefixShareOneChar: number
  /** Completing a word from two or more typed letters. */
  prefixShare: number
  /** Predicting the next word right after a space. */
  nextWordShare: number
  /** Each further word appended to a suggestion. */
  continuationShare: number
  /** Minimum support with a short (under 4 tokens) context. */
  minSupport: number
  /** A context seen this often with no clear winner is truly ambiguous: stop, don't back off. */
  ambiguousAfter: number
}

/**
 * Tuned with scripts/ticket-autocomplete-eval.ts on ~4,000 real tickets
 * (train on the oldest 90%, type the newest 10%): about 28% of keystrokes
 * saved with about 45% of shown suggestions accepted whole. Looser gates save
 * a little more but show roughly twice as many wrong suggestions.
 */
export const DEFAULT_THRESHOLDS: TicketAutocompleteThresholds = {
  prefixShareOneChar: 0.7,
  prefixShare: 0.5,
  nextWordShare: 0.7,
  continuationShare: 0.8,
  minSupport: 3,
  ambiguousAfter: 5
}

/** Long contexts are specific enough that a single past occurrence counts. */
function minSupportFor(contextLength: number, t: TicketAutocompleteThresholds): number {
  return contextLength >= 4 ? 1 : t.minSupport
}

/**
 * Gate for the first predicted token. A prefix (the partially typed word)
 * narrows the candidates, so it may be more lenient; a bare next-word
 * prediction needs to be well supported and clearly the majority.
 */
function acceptsFirst(
  c: Candidate,
  contextLength: number,
  prefixLength: number,
  t: TicketAutocompleteThresholds
): boolean {
  const share = c.count / c.total
  if (prefixLength > 0) {
    if (c.count < t.minSupport) return false
    return share >= (prefixLength === 1 ? t.prefixShareOneChar : t.prefixShare)
  }
  if (contextLength === 0) return false
  return c.count >= minSupportFor(contextLength, t) && share >= t.nextWordShare
}

/** Gate for every token after the first; errors compound, so be stricter. */
function acceptsNext(
  c: Candidate,
  contextLength: number,
  t: TicketAutocompleteThresholds
): boolean {
  return c.count >= minSupportFor(contextLength, t) && c.count / c.total >= t.continuationShare
}

export class TicketAutocompleteModel {
  private readonly maxContext: number
  private readonly thresholds: TicketAutocompleteThresholds
  /** Case-folded id per corpus position. */
  private readonly ids: Int32Array
  /** Surface-form id per corpus position. */
  private readonly surfaces: Int32Array
  /** Suffix positions sorted by the tokens that start there. */
  private readonly suffixes: Int32Array
  private readonly vocab = new Map<string, number>()
  private readonly surfaceVocab = new Map<string, number>()
  private readonly surfaceForms: string[] = []
  private readonly surfaceToId: number[] = []
  /** Case-folded form per id. */
  private readonly lowerForms: string[] = ['']
  /** Unigram index for completing a word with no usable context. */
  private readonly unigramForms: string[]
  private readonly unigramIds: Int32Array
  private readonly unigramCounts: Int32Array
  /** Most frequent surface id per case-folded id. */
  private readonly preferredSurface: Int32Array
  private readonly documents: number

  constructor(documents: Iterable<string>, options: TicketAutocompleteModelOptions = {}) {
    this.maxContext = Math.max(1, options.maxContext ?? 6)
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...options.thresholds }
    // Reserve id 0 for the boundary in both vocabularies.
    this.vocab.set('', BOUNDARY)
    this.surfaceVocab.set('', BOUNDARY)
    this.surfaceForms.push('')
    this.surfaceToId.push(BOUNDARY)

    const ids: number[] = []
    const surfaces: number[] = []
    let documentCount = 0
    for (const document of documents) {
      const tokens = tokenize(document)
      if (tokens.length === 0) continue
      documentCount += 1
      ids.push(BOUNDARY)
      surfaces.push(BOUNDARY)
      for (const token of tokens) {
        const surfaceId = this.internSurface(token)
        ids.push(this.surfaceToId[surfaceId])
        surfaces.push(surfaceId)
      }
    }
    ids.push(BOUNDARY)
    surfaces.push(BOUNDARY)

    this.documents = documentCount
    this.ids = Int32Array.from(ids)
    this.surfaces = Int32Array.from(surfaces)
    this.suffixes = this.buildSuffixArray()

    // Unigram counts, the preferred spelling of each word, and a sorted index
    // of case-folded forms for prefix lookups.
    const idCounts = new Int32Array(this.vocab.size)
    const surfaceCounts = new Int32Array(this.surfaceForms.length)
    for (let i = 0; i < this.ids.length; i++) {
      idCounts[this.ids[i]] += 1
      surfaceCounts[this.surfaces[i]] += 1
    }
    this.preferredSurface = new Int32Array(this.vocab.size).fill(-1)
    for (let s = 1; s < this.surfaceForms.length; s++) {
      const id = this.surfaceToId[s]
      const current = this.preferredSurface[id]
      if (current < 0 || surfaceCounts[s] > surfaceCounts[current]) this.preferredSurface[id] = s
    }
    const order = Array.from({ length: this.vocab.size - 1 }, (_, i) => i + 1).sort((a, b) =>
      this.lowerForms[a] < this.lowerForms[b] ? -1 : this.lowerForms[a] > this.lowerForms[b] ? 1 : 0
    )
    this.unigramForms = order.map((id) => this.lowerForms[id])
    this.unigramIds = Int32Array.from(order)
    this.unigramCounts = Int32Array.from(order, (id) => idCounts[id])
  }

  get stats(): TicketAutocompleteModelStats {
    return {
      documents: this.documents,
      tokens: Math.max(0, this.ids.length - this.documents - 1),
      vocabulary: Math.max(0, this.vocab.size - 1)
    }
  }

  /**
   * Predict what follows the caret. `before` is the text from the start of the
   * document up to the caret. Returns null when nothing is confident enough.
   */
  suggest(before: string, options: SuggestOptions = {}): TicketAutocompleteSuggestion | null {
    const maxTokens = Math.max(1, options.maxTokens ?? 12)
    const stopAtNewline = options.stopAtNewline ?? true

    const truncated = before.length > TAIL_CHARS
    const tail = truncated ? before.slice(before.length - TAIL_CHARS) : before
    const tokens = tokenize(tail)
    // The cut may have split the first word; it is only context, so drop it.
    if (truncated) tokens.shift()
    const caretAfterWord = tail.length > 0 && !/\s/.test(tail[tail.length - 1])
    if (caretAfterWord && tokens.length === 0) return null
    const prefix = caretAfterWord ? tokens.pop()! : ''
    const prefixLower = prefix.toLowerCase()

    // Context: document start (when it is in view), then the typed words.
    // Anything up to and including the last unknown word can never match.
    let context: number[] = truncated ? [] : [BOUNDARY]
    for (const token of tokens) context.push(this.vocab.get(token.toLowerCase()) ?? UNKNOWN)
    const lastUnknown = context.lastIndexOf(UNKNOWN)
    if (lastUnknown >= 0) context = context.slice(lastUnknown + 1)
    if (context.length > this.maxContext) context = context.slice(context.length - this.maxContext)

    const first = this.predictFirst(context, prefixLower)
    if (!first) return null

    const predicted: string[] = [first.candidate.surface]
    context = [...context, first.candidate.id]
    for (let n = 1; n < maxTokens; n++) {
      if (context.length > this.maxContext)
        context = context.slice(context.length - this.maxContext)
      const next = this.predictNext(context)
      if (!next) break
      if (stopAtNewline && next.candidate.surface === '\n') break
      predicted.push(next.candidate.surface)
      context.push(next.candidate.id)
    }
    if (stopAtNewline) {
      while (predicted.length > 1 && predicted[predicted.length - 1] === '\n') predicted.pop()
    }

    const text = renderTokens(predicted, prefix.length, before)
    if (text.length === 0) return null
    return {
      text,
      confidence: first.candidate.count / first.candidate.total,
      support: first.candidate.count,
      contextLength: first.contextLength
    }
  }

  private predictFirst(context: number[], prefixLower: string): Step | null {
    const shortest = prefixLower.length > 0 ? 0 : 1
    for (let k = context.length; k >= shortest; k--) {
      const c = this.bestAfter(context.slice(context.length - k), prefixLower)
      if (!c) continue
      if (acceptsFirst(c, k, prefixLower.length, this.thresholds))
        return { candidate: c, contextLength: k }
      if (c.total >= this.thresholds.ambiguousAfter) return null
    }
    return null
  }

  private predictNext(context: number[]): Step | null {
    for (let k = context.length; k >= 1; k--) {
      const c = this.bestAfter(context.slice(context.length - k), '')
      if (!c) continue
      if (acceptsNext(c, k, this.thresholds)) return { candidate: c, contextLength: k }
      if (c.total >= this.thresholds.ambiguousAfter) return null
    }
    return null
  }

  /**
   * Most frequent token following `context` in the corpus, optionally limited
   * to tokens starting with `prefixLower`. Null when the context never occurs
   * or nothing matches the prefix.
   */
  private bestAfter(context: number[], prefixLower: string): Candidate | null {
    const k = context.length
    if (k === 0) return prefixLower.length > 0 ? this.bestWithPrefix(prefixLower) : null
    const [lo, hi] = this.range(context)
    if (lo >= hi) return null

    const byId = new Map<number, number>()
    const bySurface = new Map<number, number>()
    let total = 0
    for (let i = lo; i < hi; i++) {
      const q = this.suffixes[i] + k
      if (q >= this.ids.length) continue
      total += 1
      const id = this.ids[q]
      if (id === BOUNDARY) continue // the document ended here
      if (prefixLower.length > 0 && !this.lowerForms[id].startsWith(prefixLower)) continue
      byId.set(id, (byId.get(id) ?? 0) + 1)
      const s = this.surfaces[q]
      bySurface.set(s, (bySurface.get(s) ?? 0) + 1)
    }
    if (byId.size === 0) return null

    let bestId = -1
    let bestCount = 0
    for (const [id, count] of byId) {
      if (count > bestCount) {
        bestId = id
        bestCount = count
      }
    }
    let bestSurface = -1
    let bestSurfaceCount = 0
    for (const [s, count] of bySurface) {
      if (this.surfaceToId[s] === bestId && count > bestSurfaceCount) {
        bestSurface = s
        bestSurfaceCount = count
      }
    }
    // With a prefix, only the matching tokens count as the population: the
    // user has already ruled the others out by typing the prefix.
    const population = prefixLower.length > 0 ? sum(byId.values()) : total
    return {
      id: bestId,
      surface: this.surfaceForms[bestSurface],
      count: bestCount,
      total: population
    }
  }

  /** Most frequent word in the whole corpus that starts with `prefixLower`. */
  private bestWithPrefix(prefixLower: string): Candidate | null {
    const forms = this.unigramForms
    let lo = 0
    let hi = forms.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (forms[mid] < prefixLower) lo = mid + 1
      else hi = mid
    }
    let bestIndex = -1
    let population = 0
    for (let i = lo; i < forms.length && forms[i].startsWith(prefixLower); i++) {
      population += this.unigramCounts[i]
      if (bestIndex < 0 || this.unigramCounts[i] > this.unigramCounts[bestIndex]) bestIndex = i
    }
    if (bestIndex < 0) return null
    const id = this.unigramIds[bestIndex]
    return {
      id,
      surface: this.surfaceForms[this.preferredSurface[id]],
      count: this.unigramCounts[bestIndex],
      total: population
    }
  }

  /** [lo, hi) slice of the suffix array whose suffixes start with `context`. */
  private range(context: number[]): [number, number] {
    const k = context.length
    const cmp = (position: number): number => {
      for (let i = 0; i < k; i++) {
        const q = position + i
        const a = q < this.ids.length ? this.ids[q] : END
        if (a < context[i]) return -1
        if (a > context[i]) return 1
      }
      return 0
    }
    let lo = 0
    let hi = this.suffixes.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (cmp(this.suffixes[mid]) < 0) lo = mid + 1
      else hi = mid
    }
    const start = lo
    hi = this.suffixes.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (cmp(this.suffixes[mid]) <= 0) lo = mid + 1
      else hi = mid
    }
    return [start, lo]
  }

  private internSurface(token: string): number {
    let surfaceId = this.surfaceVocab.get(token)
    if (surfaceId !== undefined) return surfaceId
    const lower = token.toLowerCase()
    let id = this.vocab.get(lower)
    if (id === undefined) {
      id = this.vocab.size
      this.vocab.set(lower, id)
      this.lowerForms.push(lower)
    }
    surfaceId = this.surfaceForms.length
    this.surfaceVocab.set(token, surfaceId)
    this.surfaceForms.push(token)
    this.surfaceToId.push(id)
    return surfaceId
  }

  /**
   * Suffix positions sorted by their first `maxContext + 1` tokens. Lookups
   * never compare deeper than that, so a bounded comparison is enough and
   * keeps the sort linear-ish on repetitive text.
   */
  private buildSuffixArray(): Int32Array {
    const ids = this.ids
    const n = ids.length
    const depth = this.maxContext + 1
    const positions = new Int32Array(n)
    for (let i = 0; i < n; i++) positions[i] = i
    positions.sort((a, b) => {
      for (let i = 0; i < depth; i++) {
        const x = a + i < n ? ids[a + i] : END
        const y = b + i < n ? ids[b + i] : END
        if (x !== y) return x - y
      }
      return a - b
    })
    return positions
  }
}

/**
 * Join predicted tokens into the text to insert at the caret. Words are
 * separated by one space; newlines carry no spaces. The first word continues
 * the partially typed prefix when there is one.
 */
function renderTokens(tokens: string[], prefixLength: number, before: string): string {
  let out = ''
  let previous =
    prefixLength > 0 ? 'word' : before.endsWith('\n') || before.length === 0 ? 'newline' : 'space'
  tokens.forEach((token, index) => {
    if (token === '\n') {
      out += '\n'
      previous = 'newline'
      return
    }
    if (index === 0 && prefixLength > 0) {
      out += token.slice(prefixLength)
    } else {
      if (previous === 'word') out += ' '
      out += token
    }
    previous = 'word'
  })
  return out
}

function sum(values: Iterable<number>): number {
  let total = 0
  for (const v of values) total += v
  return total
}
