/**
 * Discriminated envelope used at the IPC boundary for migrated channels.
 * `errorCode` is the Effect error's `_tag`; `error` is a human-readable message;
 * `details` is the serializable error payload (issues, paths, etc.).
 */
export type Envelope<A> =
  | { readonly success: true; readonly value: A }
  | {
      readonly success: false
      readonly errorCode: string
      readonly error: string
      readonly details?: unknown
    }
