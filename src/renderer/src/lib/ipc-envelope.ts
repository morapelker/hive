import type { Envelope } from '@shared/types/ipc-envelope'
import { getLegacyApiOverride } from '@/api/legacy-api-overrides'

export function unwrapEnvelope<A>(envelope: Envelope<A> | A): A {
  if (envelope && typeof envelope === 'object') {
    if ('success' in envelope && envelope.success === true && 'value' in envelope) {
      return envelope.value as A
    }

    if (
      'success' in envelope &&
      envelope.success === false &&
      'errorCode' in envelope &&
      'error' in envelope
    ) {
      throw new Error(String(envelope.error))
    }
  }

  return envelope as A
}

export type UnwrappedEnvelopeApi<T> = T extends (...args: infer Args) => Promise<Envelope<infer A>>
  ? (...args: Args) => Promise<A>
  : T extends (...args: infer Args) => infer R
    ? (...args: Args) => R
    : T extends object
      ? { [K in keyof T]: UnwrappedEnvelopeApi<T[K]> }
      : T

export function unwrapEnvelopeApi<T extends object>(api: T | (() => T)): UnwrappedEnvelopeApi<T> {
  const resolve = (): Record<PropertyKey, unknown> => {
    const value = typeof api === 'function' ? (api as () => T)() : api
    if (!value || typeof value !== 'object') return {}
    return value as Record<PropertyKey, unknown>
  }

  return new Proxy(
    {},
    {
      get(_target, prop) {
        const owner = resolve()
        const override = getLegacyApiOverride(owner, prop)
        const value = override.found ? override.value : Reflect.get(owner, prop)

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
