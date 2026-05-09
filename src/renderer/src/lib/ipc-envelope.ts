import type { Envelope } from '@shared/types/ipc-envelope'

export function unwrapEnvelope<A>(envelope: Envelope<A>): A {
  if (envelope.success) return envelope.value
  throw new Error(envelope.error)
}
