export const WINDOW_FOCUSED_CHANNEL = 'app:windowFocused'

/** Published after a shared account link is imported (deep link or paste). */
export const SHARED_ACCOUNT_IMPORTED_CHANNEL = 'accounts:sharedAccountImported'

export interface SharedAccountImportedPayload {
  provider: 'anthropic' | 'openai'
  email: string
}
