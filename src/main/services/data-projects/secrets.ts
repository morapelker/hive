// Data-project credentials (DataSecretsStore, contracts.ts), in the server child.
//
// At rest a project's secrets are ONE JSON blob encrypted by Electron safeStorage in the main
// process (desktop commands `dataSecretEncrypt` / `dataSecretDecrypt`), stored as
// `v1:<base64>` in `data_projects.secret_ciphertext`. Plaintext lives only in this process's
// memory, per project:
//
//   'decrypted'  a copy of what the ciphertext holds (cached after the first connect, or after
//                `store`), dropped by `invalidate` / `forget`
//   'session'    secrets that were never persisted: no vault reachable (browser / Docker
//                server, safeStorage unavailable, Keychain prompt timed out) or the user chose
//                "this session only". Lost on restart; the UI asks again ('unavailable').
//
// Rules: plaintext is never written to the app DB, the log, an error message or an RPC
// response; a failed or timed-out encryption degrades to 'session' (never to plaintext); a
// failed decryption marks that ciphertext unusable for this run so the UI asks for the
// password instead of retrying the Keychain on every click (a timeout is retried, since the
// user may simply not have answered the prompt yet).

import { RpcRouteError } from '../../../shared/rpc/errors'
import {
  DATA_SECRET_CIPHERTEXT_PREFIX,
  makeDesktopCommandRequest
} from '../../../shared/desktop-command'
import {
  DATA_ERROR_CODES,
  type DataProject,
  type DataSecrets,
  type DataSecretState
} from '../../../shared/data-projects/types'
import { getDatabase } from '../../db'
import type { DataProjectRecord, DataSecretsStore } from './contracts'
import {
  DataDesktopCommandError,
  processDesktopRequester,
  type DataDesktopCommandRequester
} from './desktop-requester'

/**
 * The first safeStorage call of a run can wait on a macOS Keychain prompt ("hive wants to use
 * your confidential information..."); give the user time to answer before degrading.
 */
export const DATA_SECRET_TIMEOUT_MS = 60_000
const AVAILABILITY_TIMEOUT_MS = 5_000

const SECRET_KEYS = ['password', 'sshPassword', 'sshPassphrase'] as const

/** The store plus what the RPC domain and the engine need beyond the contract. */
export interface DataSecretsVault extends DataSecretsStore {
  /**
   * Drops the cached decrypted copy and any "could not decrypt" mark (session-only secrets are
   * kept: they exist nowhere else). The next `resolve` decrypts again.
   */
  invalidate(dataProjectId: string): void
  /** Session-only secrets held in memory for a project, or null. Never decrypts. */
  sessionSecretsOf(dataProjectId: string): DataSecrets | null
  /** Whether safeStorage is reachable and usable right now (settings / wizard hint). */
  isVaultAvailable(): Promise<boolean>
}

export interface DataSecretsStoreDeps {
  readonly requester?: DataDesktopCommandRequester
  /** Reads the record (secret_ciphertext / secret_state) for `resolve`. */
  readonly getRecord?: (dataProjectId: string) => DataProjectRecord | null
  readonly timeoutMs?: number
}

interface MemoryEntry {
  readonly secrets: DataSecrets
  readonly source: 'decrypted' | 'session'
}

/** Keeps only non-empty string secrets (an empty password means "none"). */
export const normalizeDataSecrets = (secrets: DataSecrets | null | undefined): DataSecrets => {
  const normalized: DataSecrets = {}
  if (!secrets) return normalized
  for (const key of SECRET_KEYS) {
    const value = secrets[key]
    if (typeof value === 'string' && value.length > 0) normalized[key] = value
  }
  return normalized
}

const hasSecrets = (secrets: DataSecrets): boolean => SECRET_KEYS.some((key) => key in secrets)

/** Parses decrypted JSON; anything that is not the expected shape is treated as undecryptable. */
const parseSecretsJson = (plaintext: string): DataSecrets | null => {
  try {
    const parsed: unknown = JSON.parse(plaintext)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    for (const key of SECRET_KEYS) {
      if (record[key] !== undefined && typeof record[key] !== 'string') return null
    }
    return normalizeDataSecrets(record as DataSecrets)
  } catch {
    return null
  }
}

const credentialsRequired = (dataProjectId: string, message: string): RpcRouteError =>
  new RpcRouteError(DATA_ERROR_CODES.credentialsRequired, message, { dataProjectId })

const defaultGetRecord = (dataProjectId: string): DataProjectRecord | null =>
  getDatabase().getDataProject(dataProjectId)

export const createDataSecretsStore = (deps: DataSecretsStoreDeps = {}): DataSecretsVault => {
  const requester = deps.requester ?? processDesktopRequester
  const getRecord = deps.getRecord ?? defaultGetRecord
  const timeoutMs = deps.timeoutMs ?? DATA_SECRET_TIMEOUT_MS

  const memory = new Map<string, MemoryEntry>()
  /** Ciphertexts that failed to decrypt this run, per project. */
  const undecryptable = new Map<string, string>()
  /** One decrypt per project at a time; concurrent connects share it. */
  const inFlight = new Map<string, Promise<DataSecrets>>()
  /** Bumped on every write so a decrypt that finishes after a store/forget cannot win. */
  const generations = new Map<string, number>()

  const bump = (id: string): number => {
    const next = (generations.get(id) ?? 0) + 1
    generations.set(id, next)
    return next
  }

  const encrypt = async (secrets: DataSecrets): Promise<string | null> => {
    if (!requester.available()) return null
    try {
      const value = await requester.request(
        (requestId) =>
          makeDesktopCommandRequest(requestId, 'dataSecretEncrypt', {
            plaintext: JSON.stringify(secrets)
          }),
        { timeoutMs }
      )
      const ciphertext = (value as { ciphertext?: unknown } | null)?.ciphertext
      return typeof ciphertext === 'string' && ciphertext.startsWith(DATA_SECRET_CIPHERTEXT_PREFIX)
        ? ciphertext
        : null
    } catch {
      // Vault unavailable, Keychain denied or the prompt timed out: memory only.
      return null
    }
  }

  const decrypt = async (dataProjectId: string, ciphertext: string): Promise<DataSecrets> => {
    const generation = generations.get(dataProjectId) ?? 0
    if (!requester.available()) {
      undecryptable.set(dataProjectId, ciphertext)
      throw credentialsRequired(
        dataProjectId,
        'The saved password cannot be read here (no secure storage). Enter it again.'
      )
    }
    let plaintext: unknown
    try {
      const value = await requester.request(
        (requestId) => makeDesktopCommandRequest(requestId, 'dataSecretDecrypt', { ciphertext }),
        { timeoutMs }
      )
      plaintext = (value as { plaintext?: unknown } | null)?.plaintext
    } catch (error) {
      if (!(error instanceof DataDesktopCommandError) || error.kind !== 'timeout') {
        undecryptable.set(dataProjectId, ciphertext)
      }
      throw credentialsRequired(
        dataProjectId,
        error instanceof DataDesktopCommandError && error.kind === 'timeout'
          ? 'Secure storage did not answer in time. Allow access in the Keychain prompt, or enter the password.'
          : 'The saved password could not be decrypted on this Mac. Enter it again.'
      )
    }
    const secrets = typeof plaintext === 'string' ? parseSecretsJson(plaintext) : null
    if (!secrets) {
      undecryptable.set(dataProjectId, ciphertext)
      throw credentialsRequired(
        dataProjectId,
        'The saved password could not be decrypted on this Mac. Enter it again.'
      )
    }
    if ((generations.get(dataProjectId) ?? 0) === generation) {
      memory.set(dataProjectId, { secrets, source: 'decrypted' })
      undecryptable.delete(dataProjectId)
    }
    return { ...secrets }
  }

  const vault: DataSecretsVault = {
    async store(dataProjectId, secrets) {
      const normalized = normalizeDataSecrets(secrets)
      bump(dataProjectId)
      inFlight.delete(dataProjectId)
      undecryptable.delete(dataProjectId)
      if (!hasSecrets(normalized)) {
        memory.delete(dataProjectId)
        return { ciphertext: null, state: 'none' }
      }
      const ciphertext = await encrypt(normalized)
      memory.set(dataProjectId, {
        secrets: normalized,
        source: ciphertext ? 'decrypted' : 'session'
      })
      return ciphertext ? { ciphertext, state: 'stored' } : { ciphertext: null, state: 'session' }
    },

    async resolve(dataProjectId) {
      const cached = memory.get(dataProjectId)
      if (cached) return { ...cached.secrets }
      const record = getRecord(dataProjectId)
      if (!record) {
        throw new RpcRouteError(DATA_ERROR_CODES.notFound, 'Data project not found', {
          dataProjectId
        })
      }
      const ciphertext = record.secretCiphertext
      if (ciphertext) {
        if (undecryptable.get(dataProjectId) === ciphertext) {
          throw credentialsRequired(
            dataProjectId,
            'The saved password could not be decrypted on this Mac. Enter it again.'
          )
        }
        const pending = inFlight.get(dataProjectId)
        if (pending) return { ...(await pending) }
        const run = decrypt(dataProjectId, ciphertext).finally(() => {
          if (inFlight.get(dataProjectId) === run) inFlight.delete(dataProjectId)
        })
        inFlight.set(dataProjectId, run)
        return { ...(await run) }
      }
      if (record.secretState === 'stored' || record.secretState === 'session') {
        throw credentialsRequired(
          dataProjectId,
          'The password for this connection is not available in this session. Enter it again.'
        )
      }
      return {}
    },

    remember(dataProjectId, secrets) {
      const normalized = normalizeDataSecrets(secrets)
      bump(dataProjectId)
      inFlight.delete(dataProjectId)
      if (hasSecrets(normalized))
        memory.set(dataProjectId, { secrets: normalized, source: 'session' })
      else memory.delete(dataProjectId)
    },

    forget(dataProjectId) {
      bump(dataProjectId)
      memory.delete(dataProjectId)
      undecryptable.delete(dataProjectId)
      inFlight.delete(dataProjectId)
    },

    invalidate(dataProjectId) {
      bump(dataProjectId)
      inFlight.delete(dataProjectId)
      undecryptable.delete(dataProjectId)
      if (memory.get(dataProjectId)?.source === 'decrypted') memory.delete(dataProjectId)
    },

    stateOf(record): DataSecretState {
      const cached = memory.get(record.id)
      if (cached?.source === 'session') return 'session'
      if (record.secretCiphertext) {
        return undecryptable.get(record.id) === record.secretCiphertext ? 'unavailable' : 'stored'
      }
      if (cached) return 'session'
      if (record.secretState === 'stored' || record.secretState === 'session') return 'unavailable'
      return 'none'
    },

    knownSecrets(dataProjectId) {
      const cached = memory.get(dataProjectId)
      if (!cached) return []
      return SECRET_KEYS.map((key) => cached.secrets[key]).filter(
        (value): value is string => typeof value === 'string' && value.length > 0
      )
    },

    sessionSecretsOf(dataProjectId) {
      const cached = memory.get(dataProjectId)
      return cached?.source === 'session' ? { ...cached.secrets } : null
    },

    async isVaultAvailable() {
      if (!requester.available()) return false
      try {
        const value = await requester.request(
          (requestId) => makeDesktopCommandRequest(requestId, 'dataSecretAvailable'),
          { timeoutMs: AVAILABILITY_TIMEOUT_MS }
        )
        return (value as { available?: unknown } | null)?.available === true
      } catch {
        return false
      }
    }
  }
  return vault
}

let singleton: DataSecretsVault | null = null

/** The process-wide store (server child): RPC domain, engine, assistant all share it. */
export const getDataSecretsStore = (): DataSecretsVault => {
  if (!singleton) singleton = createDataSecretsStore()
  return singleton
}

/** Tests only: swap (or reset with null) the process-wide store. */
export const setDataSecretsStoreForTests = (store: DataSecretsVault | null): void => {
  singleton = store
}

/** Record → renderer DTO: drops the ciphertext and resolves the live secret state. */
export const toDataProjectDto = (
  record: DataProjectRecord,
  store: Pick<DataSecretsStore, 'stateOf'> = getDataSecretsStore()
): DataProject => ({
  id: record.id,
  name: record.name,
  engine: record.engine,
  config: record.config,
  icon: record.icon,
  iconColor: record.iconColor,
  environment: record.environment,
  color: record.color,
  safeMode: record.safeMode,
  defaultLimit: record.defaultLimit,
  allowAiDataAccess: record.allowAiDataAccess,
  pinned: record.pinned,
  secretState: store.stateOf(record),
  sortOrder: record.sortOrder,
  createdAt: record.createdAt,
  lastAccessedAt: record.lastAccessedAt
})
