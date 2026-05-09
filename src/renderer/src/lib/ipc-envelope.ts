import type { Envelope } from '@shared/types/ipc-envelope'

export function unwrapEnvelope<A>(envelope: Envelope<A>): A {
  if (envelope.success) return envelope.value
  throw new Error(envelope.error)
}

export type UnwrappedEnvelopeApi<T> = T extends object ? any : never

export function unwrapEnvelopeApi<T extends object>(api: T | (() => T)): UnwrappedEnvelopeApi<T> {
  const resolve = (): Record<PropertyKey, unknown> => {
    const value = typeof api === 'function' ? (api as () => T)() : api
    return value as Record<PropertyKey, unknown>
  }

  return new Proxy(
    {},
    {
      get(_target, prop) {
        const value = Reflect.get(resolve(), prop)

        if (typeof value === 'function') {
          return async (...args: unknown[]) => unwrapEnvelope(await value(...args))
        }

        if (value && typeof value === 'object') {
          return unwrapEnvelopeApi(() => Reflect.get(resolve(), prop) as object)
        }

        return value
      }
    }
  ) as UnwrappedEnvelopeApi<T>
}
