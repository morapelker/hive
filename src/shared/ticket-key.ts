// Jira-like ticket keys: `<PREFIX>-<number>` (TD-12).
//
// The prefix is derived once per database from the signed-in organisation's email domain
// (mor@tedooo.com -> "tedooo" -> "TD") and stored in the `settings` table under
// TICKET_KEY_PREFIX_SETTING; every ticket row carries the prefix it was stamped with and its
// running number, allocated from the `ticket_counters` table when the row is inserted. Numbers
// are one machine-wide sequence across all projects and are never reused. Markdown-backed
// boards have no ticket rows and therefore no keys (both fields null).

/** `settings.key` under which the derived prefix is stored (first organisation to sign in wins). */
export const TICKET_KEY_PREFIX_SETTING = 'ticket_key_prefix'

/** The prefix when nothing usable can be derived (empty label, digits only). */
export const FALLBACK_TICKET_KEY_PREFIX = 'TK'

/** Everything the key rendering needs; `KanbanTicket` satisfies it. */
export interface TicketKeyFields {
  ticket_prefix: string | null
  ticket_number: number | null
}

/** `TD-12`, or null when either half is missing (markdown cards, rows from an older build). */
export function formatTicketKey(
  prefix: string | null | undefined,
  number: number | null | undefined
): string | null {
  if (!prefix || typeof number !== 'number' || !Number.isFinite(number) || number < 1) return null
  return `${prefix}-${number}`
}

export function ticketKeyOf(ticket: TicketKeyFields | null | undefined): string | null {
  if (!ticket) return null
  return formatTicketKey(ticket.ticket_prefix, ticket.ticket_number)
}

/** `TD-12 · Title` when the ticket has a key, the bare title otherwise (toasts, notifications). */
export function ticketTitleWithKey(
  ticket: (TicketKeyFields & { title: string }) | null | undefined,
  fallbackTitle = 'A ticket'
): string {
  const title = ticket?.title.trim() || fallbackTitle
  const key = ticketKeyOf(ticket)
  return key ? `${key} · ${title}` : title
}

const VOWELS = new Set(['a', 'e', 'i', 'o', 'u'])
const MAX_PREFIX_LENGTH = 3

/**
 * A 2–3 letter uppercase prefix from a name or domain label, deterministic and never empty.
 *
 * - Several words (`my-startup`, `Tedooo Labs`): the initials of the first three words.
 * - One word: its first letter, then each following consonant not already used, up to three
 *   letters — `tedooo` -> TD, `google` -> GL, `shopify` -> SHP, `acme` -> ACM.
 * - Too short (`ab`, `x`, `aaa`): the remaining letters are added, repeats allowed, then `X`.
 * - Digits are dropped unless nothing else is left (`123go` -> GO, `99` -> T99).
 * - Empty input -> FALLBACK_TICKET_KEY_PREFIX.
 *
 * The result always matches /^[A-Z][A-Z0-9]{1,2}$/.
 */
export function deriveTicketKeyPrefix(label: string | null | undefined): string {
  const words = (label ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0)
  if (words.length === 0) return FALLBACK_TICKET_KEY_PREFIX

  if (words.length >= 2) {
    const initials = words
      .slice(0, MAX_PREFIX_LENGTH)
      .map((word) => word[0])
      .join('')
      .replace(/^[0-9]+/, '')
    if (initials.length >= 2) return initials.toUpperCase()
  }

  const word = words.join('')
  const letters = word.replace(/[0-9]/g, '') || word
  let key = letters[0]
  for (let i = 1; i < letters.length && key.length < MAX_PREFIX_LENGTH; i += 1) {
    const ch = letters[i]
    if (VOWELS.has(ch) || key.includes(ch)) continue
    key += ch
  }
  if (key.length < 2) {
    for (let i = 1; i < letters.length && key.length < 2; i += 1) {
      if (!key.includes(letters[i])) key += letters[i]
    }
  }
  if (key.length < 2) {
    for (let i = 1; i < letters.length && key.length < 2; i += 1) key += letters[i]
  }
  while (key.length < 2) key += 'x'
  if (/^[0-9]/.test(key)) key = `t${key}`.slice(0, MAX_PREFIX_LENGTH)
  return key.toUpperCase()
}

/** Public mail providers: their domain says nothing about the organisation. */
const FREE_MAIL_LABELS = new Set([
  'gmail',
  'googlemail',
  'yahoo',
  'ymail',
  'hotmail',
  'outlook',
  'live',
  'msn',
  'icloud',
  'me',
  'mac',
  'proton',
  'protonmail',
  'pm',
  'aol',
  'gmx',
  'mail',
  'email',
  'yandex',
  'zoho',
  'fastmail',
  'hey',
  'tutanota',
  'tuta'
])

/** Second-level public suffixes under a two-letter country code (`co.uk`, `com.au`). */
const SECOND_LEVEL_SUFFIXES = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu', 'ltd', 'plc'])

/**
 * The organisation label of an email domain: the registrable label before the public suffix.
 * `mor@tedooo.com` -> `tedooo`, `x@mail.my-startup.io` -> `my-startup`, `a@bbc.co.uk` -> `bbc`.
 * Null for a malformed address or a public mail provider.
 */
export function organisationLabelOfEmail(email: string | null | undefined): string | null {
  const at = (email ?? '').lastIndexOf('@')
  if (at < 0) return null
  // One normalised domain for every check below: the backend's value arrives verbatim.
  const labels = email!
    .slice(at + 1)
    .trim()
    .toLowerCase()
    .split('.')
    .filter((label) => label.length > 0)
  if (labels.length < 2) return labels[0] ?? null
  const tld = labels.pop()!
  if (labels.length >= 2 && tld.length === 2 && SECOND_LEVEL_SUFFIXES.has(labels[labels.length - 1])) {
    labels.pop()
  }
  const label = labels[labels.length - 1] ?? null
  if (!label || FREE_MAIL_LABELS.has(label)) return null
  return label
}

/**
 * The prefix for a signed-in session: from the email's organisation label, else from the
 * organisation's name (personal mail accounts), else null when neither is known.
 */
export function ticketKeyPrefixFromSession(
  email: string | null | undefined,
  orgName: string | null | undefined
): string | null {
  const label = organisationLabelOfEmail(email)
  if (label) return deriveTicketKeyPrefix(label)
  if (orgName && orgName.trim().length > 0) return deriveTicketKeyPrefix(orgName)
  return null
}
