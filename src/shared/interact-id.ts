/**
 * InteractId encoder compatible with hive-enterprise.
 *
 * Internal ids are `{ulid}-{type}`; GraphQL accepts `{base58(ulid)}_{type}`.
 */

export type InteractType = 'user' | 'org' | 'invite' | 'prompt'

export const INTERACT_TYPES: readonly InteractType[] = ['user', 'org', 'invite', 'prompt']

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const ULID_LENGTH = 26
const ULID_MAX = 32n ** BigInt(ULID_LENGTH)
const BASE58_BODY_RE = /^[1-9A-HJ-NP-Za-km-z]+$/
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/

function isInteractType(value: string): value is InteractType {
  return (INTERACT_TYPES as readonly string[]).includes(value)
}

function ulidToBigInt(ulid: string): bigint {
  let n = 0n
  for (const ch of ulid) {
    const idx = CROCKFORD.indexOf(ch)
    if (idx === -1) throw new Error(`Invalid ULID character: ${ch}`)
    n = n * 32n + BigInt(idx)
  }
  return n
}

function bigIntToUlid(n: bigint): string {
  let value = n
  let out = ''
  for (let i = 0; i < ULID_LENGTH; i++) {
    out = CROCKFORD[Number(value % 32n)] + out
    value /= 32n
  }
  return out
}

function bigIntToBase58(n: bigint): string {
  if (n === 0n) return BASE58[0]
  let value = n
  let out = ''
  while (value > 0n) {
    out = BASE58[Number(value % 58n)] + out
    value /= 58n
  }
  return out
}

function base58ToBigInt(s: string): bigint {
  let n = 0n
  for (const ch of s) {
    const idx = BASE58.indexOf(ch)
    if (idx === -1) throw new Error(`Invalid base58 character: ${ch}`)
    n = n * 58n + BigInt(idx)
  }
  return n
}

export function ulidToExternalBody(ulid: string): string {
  return bigIntToBase58(ulidToBigInt(ulid.toUpperCase()))
}

export function externalBodyToUlid(body: string): string {
  const n = base58ToBigInt(body)
  if (n >= ULID_MAX) throw new Error('InteractId body is out of range')
  return bigIntToUlid(n)
}

export function encodeInteractId(internal: string): string {
  const sep = internal.lastIndexOf('-')
  if (sep === -1) throw new Error(`InteractId is missing a type suffix: ${internal}`)
  const ulidPart = internal.slice(0, sep)
  const type = internal.slice(sep + 1)
  if (!isInteractType(type)) throw new Error(`Unknown InteractId type: ${type}`)
  if (!ULID_RE.test(ulidPart)) throw new Error(`Invalid ULID in InteractId: ${internal}`)
  return `${ulidToExternalBody(ulidPart)}_${type}`
}

export function decodeInteractId(external: string, expectedType?: InteractType): string {
  const sep = external.lastIndexOf('_')
  if (sep === -1) throw new Error(`InteractId is missing a type suffix: ${external}`)
  const body = external.slice(0, sep)
  const type = external.slice(sep + 1)
  if (!isInteractType(type)) throw new Error(`Unknown InteractId type: ${type}`)
  if (expectedType && type !== expectedType) {
    throw new Error(`Expected a ${expectedType} id but got a ${type} id`)
  }
  if (!BASE58_BODY_RE.test(body)) throw new Error(`Invalid InteractId body: ${body}`)
  return `${externalBodyToUlid(body)}-${type}`
}
