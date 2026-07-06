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

async function migrateAnthropicRow(row: SavedUsageAccount): Promise<void> {
  const parsed = JSON.parse(row.credentials_json) as Partial<StoredAnthropicCredentials>
  const email = parsed.email
  if (!email) {
    log.warn('Skipping saved Anthropic row without an email', { id: row.id })
    return
  }

  const managed = await listClaudeAccounts()
  if (managed.some((account) => account.email === email.toLowerCase())) {
    return
  }

  const blobJson = JSON.stringify({
    claudeAiOauth: {
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      expiresAt: parsed.expiresAt,
      scopes: []
    }
  })
  await addClaudeAccount(email, '', blobJson)
}

async function migrateOpenAIRow(row: SavedUsageAccount): Promise<void> {
  const parsed = JSON.parse(row.credentials_json) as Partial<StoredOpenAICredentials>
  if (!parsed.idToken) {
    log.warn('Skipping saved OpenAI row without an idToken', { id: row.id })
    return
  }

  const claims = parseCodexIdToken(parsed.idToken)
  if (!claims.userId || !claims.accountId) {
    log.warn('Skipping saved OpenAI row: id_token has no chatgpt_user_id/chatgpt_account_id', {
      id: row.id
    })
    return
  }

  const accountKey = `${claims.userId}::${claims.accountId}`
  const managed = await listCodexAccounts()
  if (managed.some((account) => account.accountKey === accountKey)) {
    return
  }

  await addCodexAccount(parsed.idToken, parsed.accessToken ?? '', parsed.refreshToken ?? '')
}

/**
 * Migrate every `saved_usage_accounts` row's credentials into the account
 * stores, then blank `credentials_json` for all rows. Idempotent: no-ops
 * immediately once the `saved_usage_credentials_migrated` setting is set.
 */
export async function migrateSavedCredentialsToStores(): Promise<void> {
  const db = getDatabase()
  if (db.getSetting(MIGRATION_SETTING_KEY)) return

  const anthropicRows = db.getSavedUsageAccountsByProvider('anthropic')
  const openaiRows = db.getSavedUsageAccountsByProvider('openai')

  for (const row of anthropicRows) {
    if (!row.credentials_json) continue
    try {
      await migrateAnthropicRow(row)
    } catch (error) {
      log.warn('Failed to migrate saved Anthropic credentials', {
        id: row.id,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  for (const row of openaiRows) {
    if (!row.credentials_json) continue
    try {
      await migrateOpenAIRow(row)
    } catch (error) {
      log.warn('Failed to migrate saved OpenAI credentials', {
        id: row.id,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  db.clearSavedUsageAccountCredentials()
  db.setSetting(MIGRATION_SETTING_KEY, new Date().toISOString())
}
