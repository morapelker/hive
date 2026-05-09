import type { Envelope } from '@shared/types/ipc-envelope'

export function unwrapEnvelope<A>(envelope: Envelope<A>): A {
  if (envelope.success) return envelope.value
  throw new Error(envelope.error)
}

export function envelopeError(envelope: Envelope<unknown>, fallback: string): string {
  return envelope.success ? fallback : envelope.error || fallback
}
