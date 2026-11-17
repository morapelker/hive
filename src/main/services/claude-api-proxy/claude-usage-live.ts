/**
 * The app's one live usage updater, and the way to hand it an observation.
 *
 * The updater (`claude-usage-live-updater.ts`) turns a usage observation into
 * an updated account row and a `usage:claudeLive` event. It used to be built
 * by the proxy on start and thrown away on close, so it did not exist when the
 * proxy was skipped and nothing but the proxy could reach it. It now lives
 * here, for as long as the app runs and whatever the proxy does: the proxy is
 * one source of observations among others.
 *
 * One instance on purpose. What it remembers (which account a credential
 * belongs to, the burst it is holding back for an account, what it already
 * logged) only works when every source goes through the same one, and a
 * proxy that stops and starts again must neither lose the reading that was
 * being held back nor publish one twice.
 */
import { getDatabase } from '../../db'
import { publishDesktopBackendEvent } from '../../desktop/backend-event-publisher'
import {
  addClaudeAccount,
  isClaudeAccountManaged,
  listClaudeAccountTokenFingerprints,
  readClaudeAccountIndexUpdatedAt,
  readClaudeLiveIdentityCached,
  readClaudeLiveRawBlob,
  readClaudeLiveTokenFingerprint,
  rememberClaudeAccountUuid
} from '../account-store-claude'
import { createLogger } from '../logger'
import { ClaudeUsageLiveUpdater, type ClaudeUsageObservation } from './claude-usage-live-updater'

const log = createLogger({ component: 'ClaudeUsageLive' })

let updater: ClaudeUsageLiveUpdater | null = null
let organizationsNeededHandler: (() => void) | null = null

function buildUpdater(): ClaudeUsageLiveUpdater {
  return new ClaudeUsageLiveUpdater({
    listManagedAccounts: (options) => listClaudeAccountTokenFingerprints(options),
    // Consulted on every update: served from a stat-keyed cache so the large
    // identity file is only re-parsed when it actually changed.
    readLiveIdentity: readClaudeLiveIdentityCached,
    readLiveTokenFingerprint: readClaudeLiveTokenFingerprint,
    isAccountManaged: isClaudeAccountManaged,
    ensureLiveAccountManaged: async (email, uuid) => {
      const rawBlob = await readClaudeLiveRawBlob()
      if (!rawBlob) return false
      await addClaudeAccount(email, uuid, rawBlob)
      return true
    },
    rememberAccountUuid: rememberClaudeAccountUuid,
    readUsageRow: (email) => getDatabase().getSavedUsageAccountByProviderEmail('anthropic', email),
    writeLiveUsage: (email, usage) => {
      const db = getDatabase()
      const row =
        db.getSavedUsageAccountByProviderEmail('anthropic', email) ??
        db.upsertSavedUsageAccount({ provider: 'anthropic', email, credentials_json: '' })
      return db.updateSavedUsageAccountLiveUsage(row.id, JSON.stringify(usage)) ?? row
    },
    publish: (channel, payload) => publishDesktopBackendEvent(channel, payload),
    listAccountOrganizations: () =>
      getDatabase()
        .getSavedUsageAccountOrganizations('anthropic')
        .map((account) => ({ email: account.email, organizationUuid: account.org_uuid })),
    // Account switches run in the server process; the index they stamp is the
    // one record of them this process can read.
    readLastAccountSwitchAt: () => readClaudeAccountIndexUpdatedAt(),
    requestOrganizations: () => organizationsNeededHandler?.(),
    // What a proxied response teaches: the organization its credential's
    // account is billed to. The updater calls this only for a new value.
    storeAccountOrganization: (accountId, organizationUuid) => {
      getDatabase().setSavedUsageAccountOrgUuid(accountId, organizationUuid)
    },
    log
  })
}

/**
 * The updater every source feeds. Built on first use (it touches the database
 * and the account store only when an observation arrives) and then kept.
 */
export function getClaudeUsageLiveUpdater(): ClaudeUsageLiveUpdater {
  if (updater === null) updater = buildUpdater()
  return updater
}

/**
 * Hand the live updater a usage observation from anywhere in the main
 * process. It does not need the proxy to be running, or to have ever started.
 *
 * The observation says what was read (`snapshot`, from
 * `parseUnifiedRateLimitHeaders`), when the response was seen (`observedAt`,
 * epoch ms: the time of the response, not the time of this call) and what
 * identifies the account that was billed: the credential's fingerprint, or,
 * for a source that cannot see the credential, `organizationUuid` alone (with
 * `credentialFingerprint: null` and `accountUuid: null`). From there it is
 * treated like one the proxy saw: attributed, merged into that account's row,
 * published on `usage:claudeLive`, coalesced with the other readings for the
 * same account. One that cannot be attributed is dropped, never guessed; one
 * whose organization no account is mapped to yet waits up to 60 seconds for
 * the mapping first.
 *
 * Returns at once; the update is applied in the background and its failures
 * are logged, not thrown.
 */
export function submitClaudeUsageObservation(observation: ClaudeUsageObservation): void {
  getClaudeUsageLiveUpdater().observe(observation)
}

/**
 * Who learns organizations. The updater calls `handler` when a reading names
 * an organization no managed account is mapped to: organizations should then
 * be learned for the accounts that have none. It is called at most once a
 * minute per unknown organization and must return at once (start the work,
 * do not await it). The reading is held for 60 seconds meanwhile; call
 * `notifyClaudeOrganizationsLearned()` once something was stored. Null
 * disconnects. One handler at a time.
 *
 * The updater also learns on its own, from proxied traffic: a response whose
 * credential placed it stores the organization it names for that account.
 * That only reaches accounts that send proxied requests; this handler is for
 * the others.
 */
export function setClaudeOrganizationsNeededHandler(handler: (() => void) | null): void {
  organizationsNeededHandler = handler
}

/**
 * An account's organization was just stored: apply the readings that were
 * waiting for it now. Optional (held readings are also re-checked every
 * second), cheap, and safe to call when nothing is waiting.
 */
export function notifyClaudeOrganizationsLearned(): void {
  updater?.organizationsLearned()
}

/**
 * App shutdown: drop the readings still held back for a burst or waiting for
 * an organization, so nothing is written to a database that is closing.
 */
export function disposeClaudeUsageLiveUpdater(): void {
  updater?.dispose()
}

/** Tests only: forget the updater and everything it remembers. */
export function __resetClaudeUsageLiveUpdaterForTests(): void {
  updater?.dispose()
  updater = null
  organizationsNeededHandler = null
}
