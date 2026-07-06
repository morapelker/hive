import { randomUUID } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'

import { DatabaseService } from '../../db/database'

describe('saved_usage_accounts case-insensitive email handling', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  const createService = (): DatabaseService => {
    const dir = mkdtempSync(join(tmpdir(), 'hive-saved-usage-accounts-'))
    tempDirs.push(dir)
    const service = new DatabaseService(join(dir, 'hive.db'))
    service.init()
    return service
  }

  /** Insert a row directly via raw SQL, bypassing upsertSavedUsageAccount's
   * own lowercasing, to model a legacy mixed-case row pre-dating normalization. */
  function insertLegacyRow(
    service: DatabaseService,
    overrides: { provider: string; email: string }
  ): string {
    const db = service.getRawDb()
    const id = randomUUID()
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO saved_usage_accounts (
         id, provider, email, credentials_json, last_usage_json, last_fetched_at,
         status, last_error, created_at, updated_at
       ) VALUES (?, ?, ?, '', NULL, NULL, 'ok', NULL, ?, ?)`
    ).run(id, overrides.provider, overrides.email, now, now)
    return id
  }

  it('getSavedUsageAccountByProviderEmail matches an existing row regardless of casing', () => {
    const service = createService()
    const id = insertLegacyRow(service, { provider: 'anthropic', email: 'Mixed-Case@Example.com' })

    expect(service.getSavedUsageAccountByProviderEmail('anthropic', 'mixed-case@example.com')?.id).toBe(
      id
    )
    expect(service.getSavedUsageAccountByProviderEmail('anthropic', 'MIXED-CASE@EXAMPLE.COM')?.id).toBe(
      id
    )
    expect(service.getSavedUsageAccountByProviderEmail('anthropic', 'Mixed-Case@Example.com')?.id).toBe(
      id
    )
  })

  it('upserting a case-variant email updates the same legacy row instead of inserting a duplicate', () => {
    const service = createService()
    const legacyId = insertLegacyRow(service, {
      provider: 'anthropic',
      email: 'Legacy-User@Example.com'
    })

    const result = service.upsertSavedUsageAccount({
      provider: 'anthropic',
      email: 'legacy-user@example.com',
      credentials_json: '',
      last_usage_json: JSON.stringify({ hello: 'world' }),
      status: 'ok',
      last_error: null
    })

    expect(result.id).toBe(legacyId)
    expect(service.getSavedUsageAccountsByProvider('anthropic')).toHaveLength(1)

    // Both casings resolve to the single, now-updated row.
    const byLower = service.getSavedUsageAccountByProviderEmail('anthropic', 'legacy-user@example.com')
    const byMixed = service.getSavedUsageAccountByProviderEmail('anthropic', 'Legacy-User@Example.com')
    expect(byLower?.id).toBe(legacyId)
    expect(byMixed?.id).toBe(legacyId)
    expect(byLower?.last_usage_json).toBe(JSON.stringify({ hello: 'world' }))
  })

  it('a brand-new upsert normalizes the email to lowercase', () => {
    const service = createService()

    const result = service.upsertSavedUsageAccount({
      provider: 'openai',
      email: 'New-User@Example.com',
      credentials_json: ''
    })

    expect(result.email).toBe('new-user@example.com')
    expect(service.getSavedUsageAccountsByProvider('openai')).toHaveLength(1)
  })

  it('repeated upserts of the same case-variant email never create a second row', () => {
    const service = createService()

    service.upsertSavedUsageAccount({ provider: 'anthropic', email: 'A@B.com', credentials_json: '' })
    service.upsertSavedUsageAccount({ provider: 'anthropic', email: 'a@b.com', credentials_json: '' })
    service.upsertSavedUsageAccount({ provider: 'anthropic', email: 'A@B.COM', credentials_json: '' })

    expect(service.getSavedUsageAccountsByProvider('anthropic')).toHaveLength(1)
  })
})
