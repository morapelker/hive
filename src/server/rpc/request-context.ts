// The request-scoped identity of an RPC call, kept in an AsyncLocalStorage so a domain deep in
// the call (data projects scoping their connections per renderer, the document flow stamping
// who asked) can read it without threading it through every signature. Hive's server has one
// desktop renderer and no paired devices or peer Macs, so the context is usually absent (a
// loopback call) or a desktop principal: `kind: 'device'` exists only so the domains ported from
// Tedooo Code, which refuse devices, keep their checks.
import { AsyncLocalStorage } from 'node:async_hooks'

export type AuthPrincipal =
  | { readonly kind: 'desktop' }
  | {
      readonly kind: 'device'
      readonly deviceId: string
      readonly name: string
      readonly scope: string
    }

export interface RpcRequestContext {
  readonly clientId: string | null
  readonly principal: AuthPrincipal | null
  readonly remoteAddress?: string | null
}

export const rpcRequestContext = new AsyncLocalStorage<RpcRequestContext>()

export const getRpcRequestContext = (): RpcRequestContext | undefined =>
  rpcRequestContext.getStore()

export const runWithRpcRequestContext = <T>(context: RpcRequestContext, fn: () => T): T =>
  rpcRequestContext.run(context, fn)
