import type { VoiceDictionaryEntry } from '../types/voice'

/**
 * Deterministic whole-word rewriting of dictionary aliases to their canonical
 * spelling, ported from Wispelker's DictionaryReplacer:
 *
 * - the word itself is an implicit alias (case-insensitive unless
 *   `caseSensitive`), so plain entries normalise casing ("claude" → "Claude");
 * - `soundsLike` aliases are always case-insensitive;
 * - matches are whole words: letters, marks, digits and "_" on either side
 *   block a match, punctuation and hyphens are boundaries;
 * - multi-word aliases match across any whitespace;
 * - possessives ("moor's", "MOOR’S") keep their apostrophe and become "Mor's";
 * - the longest alias wins at a position, ties keep entry order, and a
 *   duplicate alias belongs to the first entry that declared it;
 * - a span that already contains a canonical spelling as a whole token is
 *   never rewritten, so applying the replacer twice is a no-op (no chaining).
 */

interface Rule {
  readonly regex: RegExp
  readonly word: string
  readonly aliasLength: number
  readonly order: number
}

const BOUNDARY = /[\p{L}\p{M}\p{N}_]/u

function normalize(value: string): string {
  return value.normalize('NFC').split(/\s+/u).filter(Boolean).join(' ')
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
}

export class DictionaryReplacer {
  private readonly rules: Rule[]
  private readonly canonicalWords: Set<string>

  constructor(entries: readonly VoiceDictionaryEntry[]) {
    const rules: Rule[] = []
    const seenAliases = new Set<string>()
    const canonical = new Set<string>()

    for (const entry of entries) {
      const word = normalize(entry.word)
      if (!word) continue
      canonical.add(word)

      const aliases: Array<{ alias: string; caseInsensitive: boolean }> = [
        { alias: word, caseInsensitive: !entry.caseSensitive },
        ...entry.soundsLike.map((alias) => ({ alias: normalize(alias), caseInsensitive: true }))
      ]

      for (const { alias, caseInsensitive } of aliases) {
        if (!alias) continue
        const key = caseInsensitive ? `i:${alias.toLowerCase()}` : `s:${alias}`
        if (seenAliases.has(key)) continue
        seenAliases.add(key)

        const core = alias.split(' ').map(escapeRegex).join('\\s+')
        // Sticky (y) so the rule is tested exactly at the scan position; the
        // possessive group and the trailing boundary lookahead mirror the
        // reference regex; the leading boundary is checked by the scanner.
        const regex = new RegExp(
          `(?:${core})((?:'|’)[sS])?(?![\\p{L}\\p{M}\\p{N}_])`,
          ['y', 'u', caseInsensitive ? 'i' : ''].join('')
        )
        rules.push({ regex, word, aliasLength: Array.from(alias).length, order: rules.length })
      }
    }

    rules.sort((a, b) => b.aliasLength - a.aliasLength || a.order - b.order)
    this.rules = rules
    this.canonicalWords = canonical
  }

  get isEmpty(): boolean {
    return this.rules.length === 0
  }

  apply(text: string): string {
    if (this.rules.length === 0 || text.length === 0) return text
    const input = text.normalize('NFC')
    let result = ''
    let cursor = 0
    let index = 0
    let replaced = false

    while (index < input.length) {
      // Leading boundary: the previous character must not be a word character.
      if (index > 0) {
        const previous = input[index - 1]
        if (BOUNDARY.test(previous)) {
          index++
          continue
        }
      }

      let matched = false
      for (const rule of this.rules) {
        rule.regex.lastIndex = index
        const match = rule.regex.exec(input)
        if (!match) continue
        matched = true
        const fullSpan = match[0]
        const possessive = match[1] ?? ''
        const span = fullSpan.slice(0, fullSpan.length - possessive.length)
        const end = index + fullSpan.length

        // A span that already carries a canonical spelling is left alone so
        // replacements never chain ("git Hub" must not become "GitHub") —
        // unless that canonical token is part of this rule's own replacement
        // ("Claude code" → "Claude Code" with both "Claude" and "Claude Code").
        const replacementTokens = new Set(rule.word.split(/\s+/u))
        const alreadyCanonical =
          rule.word !== span &&
          span
            .split(/\s+/u)
            .some((token) => this.canonicalWords.has(token) && !replacementTokens.has(token))
        if (alreadyCanonical) {
          // Leave the span untouched (copied verbatim later) and continue after it.
          index = end
          break
        }

        result += input.slice(cursor, index) + rule.word
        if (possessive) {
          result += `${possessive[0]}s`
        }
        cursor = end
        index = end
        replaced = true
        break
      }

      if (!matched) index++
    }

    if (!replaced) return text
    result += input.slice(cursor)
    return result
  }
}
