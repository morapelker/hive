/**
 * One-time migration of legacy `saved_usage_accounts.credentials_json` rows
 * (SQLite-stored Anthropic/OpenAI tokens) into the ccswitch-compatible
 * account stores (Keychain + ~/.claude-switch-backup / ~/.codex/accounts).
 *
 * After migration, `saved_usage_accounts` becomes a usage *cache* — this
 * module blanks its `credentials_json` column so it stops being read as a
 * credentials source elsewhere.
 *
 * This module is intentionally NOT wired into server boot yet; a later
 * phase calls `migrateSavedCredentialsToStores()` during startup.
 */
import { getDatabase } from '../db'
import type { SavedUsageAccount } from '../db/types'
import { addClaudeAccount, listClaudeAccounts } from './account-store-claude'
import { addCodexAccount, listCodexAccounts } from './account-store-codex'
import { parseCodexIdToken } from './jwt-utils'
import { createLogger } from './logger'

const log = createLogger({ component: 'CredentialsMigration' })

const MIGRATION_SETTING_KEY = 'saved_usage_credentials_migrated'

interface StoredAnthropicCredentials {
  accessToken: string
  refreshToken: string
  expiresAt: number
  email: string
}

interface StoredOpenAICredentials {
  accessToken: string
  refreshToken: string
  accountId: string
  idToken: string
  email: string
}

/**
 * Per-row migration outcome. `migrated` and `skipped` (already-managed, or
 * structurally unusable — no email / no idToken / unparseable blob) both mean
 * "safe to blank this row's credentials". A THROW means a transient failure
 * (e.g. a Keychain ACL denial) — the caller must leave the row's credentials
 * intact and not mark the migration done, so the next boot retries.
 */
type RowOutcome = 'migrated' | 'skipped'

async function migrateAnthropicRow(row: SavedUsageAccount): Promise<RowOutcome> {
  let parsed: Partial<StoredAnthropicCredentials>
  try {
    parsed = JSON.parse(row.credentials_json) as Partial<StoredAnthropicCredentials>
  } catch {
    log.warn('Skipping saved Anthropic row with unparseable credentials_json', { id: row.id })
    return 'skipped'
  }

  const email = parsed.email
  if (!email) {
    log.warn('Skipping saved Anthropic row without an email', { id: row.id })
    return 'skipped'
  }

  const managed = await listClaudeAccounts()
  if (managed.some((account) => account.email === email.toLowerCase())) {
    return 'skipped'
  }

  const blobJson = JSON.stringify({
    claudeAiOauth: {
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      expiresAt: parsed.expiresAt,
      scopes: []
    }
  })
  // A throw here (transient Keychain failure) propagates so the row is NOT
  // blanked and the migration is retried on the next boot.
  await addClaudeAccount(email, '', blobJson)
  return 'migrated'
}

async function migrateOpenAIRow(row: SavedUsageAccount): Promise<RowOutcome> {
  let parsed: Partial<StoredOpenAICredentials>
  try {
    parsed = JSON.parse(row.credentials_json) as Partial<StoredOpenAICredentials>
  } catch {
    log.warn('Skipping saved OpenAI row with unparseable credentials_json', { id: row.id })
    return 'skipped'
  }

  if (!parsed.idToken) {
    log.warn('Skipping saved OpenAI row without an idToken', { id: row.id })
    return 'skipped'
  }

  const claims = parseCodexIdToken(parsed.idToken)
  if (!claims.userId || !claims.accountId) {
    log.warn('Skipping saved OpenAI row: id_token has no chatgpt_user_id/chatgpt_account_id', {
      id: row.id
    })
    return 'skipped'
  }

  const accountKey = `${claims.userId}::${claims.accountId}`
  const managed = await listCodexAccounts()
  if (managed.some((account) => account.accountKey === accountKey)) {
    return 'skipped'
  }

  await addCodexAccount(parsed.idToken, parsed.accessToken ?? '', parsed.refreshToken ?? '')
  return 'migrated'
}

/**
 * Migrate every `saved_usage_accounts` row's credentials into the account
 * stores, blanking each row's `credentials_json` ONLY once it has been safely
 * migrated (or deliberately skipped). Idempotent: no-ops immediately once the
 * `saved_usage_credentials_migrated` setting is set. If any row hit a transient
 * error, the setting is left unset so the next boot retries (store adds are
 * idempotent, so already-migrated rows just skip).
 */
export async function migrateSavedCredentialsToStores(): Promise<void> {
  const db = getDatabase()
  if (db.getSetting(MIGRATION_SETTING_KEY)) return

  const anthropicRows = db.getSavedUsageAccountsByProvider('anthropic')
  const openaiRows = db.getSavedUsageAccountsByProvider('openai')

  let hadTransientError = false

  const migrateRows = async (
    rows: SavedUsageAccount[],
    migrateRow: (row: SavedUsageAccount) => Promise<RowOutcome>
  ): Promise<void> => {
    for (const row of rows) {
      if (!row.credentials_json) continue
      try {
        await migrateRow(row)
        // Only blank a row we handled without throwing — a transient failure
        // must NOT destroy the row's only surviving credentials.
        db.clearSavedUsageAccountCredentialsById(row.id)
      } catch (error) {
        hadTransientError = true
        log.warn('Failed to migrate saved credentials; leaving row intact for a retry', {
          id: row.id,
          provider: row.provider,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
  }

  await migrateRows(anthropicRows, migrateAnthropicRow)
  await migrateRows(openaiRows, migrateOpenAIRow)

  // Only mark the one-shot migration done when every row was fully handled;
  // otherwise the next boot retries the rows still carrying credentials.
  if (!hadTransientError) {
    db.setSetting(MIGRATION_SETTING_KEY, new Date().toISOString())
  }
}
