// CodeMirror adapter for the pure Mongo completion (mongo-completion.ts). Each editor passes a
// data getter (collections, fields, server version — read lazily so a schema refresh needs no
// editor reconfiguration) and, for the query bar / stage / dialog editors, a synthetic prefix
// that puts the editor's text inside the right call: the filter bar is analysed as
// `db.getCollection('orders').find(` + text, a $group stage body as
// `db.getCollection('orders').aggregate([{ $group: ` + text, and so on.

import { snippetCompletion, type Completion, type CompletionSource } from '@codemirror/autocomplete'
import {
  analyzeMongoCompletion,
  mongoCompletionItems,
  shouldOfferWhileTyping,
  type MongoCompletionData,
  type MongoCompletionItem
} from './mongo-completion'

function toCompletion(item: MongoCompletionItem): Completion {
  const base: Completion = {
    label: item.label,
    type: item.type,
    ...(item.detail ? { detail: item.detail } : {}),
    ...(item.info ? { info: item.info } : {}),
    ...(item.boost !== undefined ? { boost: item.boost } : {})
  }
  if (item.snippet) return snippetCompletion(item.snippet, base)
  return item.apply !== undefined ? { ...base, apply: item.apply } : base
}

export function createMongoCompletionSource(
  getData: () => MongoCompletionData,
  getPrefix?: () => string
): CompletionSource {
  return (context) => {
    const head = getPrefix?.() ?? ''
    const before = head + context.state.sliceDoc(0, context.pos)
    const site = analyzeMongoCompletion(before)
    if (site.kind === 'none') return null
    if (!context.explicit && !shouldOfferWhileTyping(site, before)) return null
    const items = mongoCompletionItems(site, getData())
    if (items.length === 0) return null
    return {
      from: Math.max(0, site.from - head.length),
      options: items.map(toCompletion),
      validFor: /^[\w$.-]*$/
    }
  }
}
