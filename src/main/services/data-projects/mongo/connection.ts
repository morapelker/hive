// DataConnectionConfig (+ secrets) → MongoClient URI and options.
//
// The URI never carries credentials: user and password go in the `auth` option, so the URI can
// be logged and shown in errors as is. The configured default database goes in the URI path on
// purpose: without an explicit authSource the driver then authenticates against it, exactly as
// mongosh and Compass do with the same pasted URL (and `mongodb+srv` TXT records still apply).
// Extra `config.options` (non-secret URI options the wizard did not map, e.g. retryWrites=false)
// go into the query string so the driver parses and validates them itself.

import { homedir } from 'node:os'
import type { MongoClientOptions } from 'mongodb'
import type { DataConnectionConfig, DataSecrets } from '../../../../shared/data-projects/types'
import type { DataProjectRecord } from '../contracts'

export const MONGO_APP_NAME = 'Hive'
export const MONGO_SERVER_SELECTION_TIMEOUT_MS = 10_000
const DEFAULT_PORT = 27017

/** URI options that must never come from `config.options` (secrets, or set by us). */
const BLOCKED_OPTION = /pass|secret|token|credential|^appname$|^authmechanismproperties$/i

export interface MongoClientConfig {
  uri: string
  options: MongoClientOptions
  /** Separate cert/key files to read at connect time (mongo wants them in one PEM otherwise). */
  tlsFiles?: { certPath: string; keyPath: string }
  /** Host list and database for logs and the status DTO (no credentials). */
  describe: string
}

const expandHome = (path: string): string =>
  path === '~' ? homedir() : path.startsWith('~/') ? `${homedir()}${path.slice(1)}` : path

/** "host:port" with IPv6 literals bracketed. */
function formatHost(entry: string, srv: boolean): string {
  let host = entry.trim()
  if (!host) return host
  if (srv) {
    // SRV: one hostname, no port.
    if (host.startsWith('[')) return host.replace(/\]:\d+$/, ']')
    return host.replace(/:\d+$/, '')
  }
  if (host.startsWith('[')) return host
  const colons = host.match(/:/g)?.length ?? 0
  if (colons > 1) host = `[${host}]`
  return host
}

function hostList(config: DataConnectionConfig, srv: boolean): string[] {
  const fromMongo = (config.mongo?.hosts ?? []).map((h) => formatHost(h, srv)).filter(Boolean)
  if (fromMongo.length > 0) return srv ? fromMongo.slice(0, 1) : fromMongo
  const host = config.host?.trim() || 'localhost'
  const bracketed = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  if (srv) return [bracketed]
  return [`${bracketed}:${config.port ?? DEFAULT_PORT}`]
}

function tlsFromSslMode(config: DataConnectionConfig): Partial<MongoClientOptions> {
  const ssl = config.ssl
  if (!ssl) return {}
  const options: Partial<MongoClientOptions> = {}
  switch (ssl.mode) {
    case 'disable':
      options.tls = false
      break
    case 'prefer':
      break
    case 'require':
      // libpq semantics shared by the wizard: encrypt, do not verify the certificate.
      options.tls = true
      if (!ssl.caPath) {
        options.tlsAllowInvalidCertificates = true
        options.tlsAllowInvalidHostnames = true
      }
      break
    case 'verify-ca':
      options.tls = true
      options.tlsAllowInvalidHostnames = true
      break
    case 'verify-full':
      options.tls = true
      break
  }
  return options
}

export function buildMongoClientConfig(
  project: DataProjectRecord,
  secrets: DataSecrets
): MongoClientConfig {
  const config = project.config
  const mongo = config.mongo
  const srv = mongo?.srv === true
  const hosts = hostList(config, srv)
  const database = config.database?.trim() || ''
  const scheme = srv ? 'mongodb+srv' : 'mongodb'

  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(config.options ?? {})) {
    if (BLOCKED_OPTION.test(key) || typeof value !== 'string') continue
    query.set(key, value)
  }
  const queryText = query.toString()
  const path = `/${database ? encodeURIComponent(database) : ''}`
  const uri = `${scheme}://${hosts.join(',')}${path}${queryText ? `?${queryText}` : ''}`

  const options: MongoClientOptions = {
    appName: MONGO_APP_NAME,
    serverSelectionTimeoutMS: MONGO_SERVER_SELECTION_TIMEOUT_MS,
    connectTimeoutMS: MONGO_SERVER_SELECTION_TIMEOUT_MS,
    // session + control + export + schema sampling run concurrently.
    maxPoolSize: 10,
    maxIdleTimeMS: 60_000,
    // The console log (console-log.ts) records the commands from command monitoring events, but
    // only while a Console tab follows the project: monitoring makes the driver decode every
    // reply a second time (a third slower on big reads), so console-log's MongoCommandMonitor
    // switches each pooled connection's flag as the pool checks it out, off while unwatched.
    // Created on, so that a driver whose pool it cannot reach still logs (always, slower).
    monitorCommands: true,
    // Stored regexes decode as BSONRegExp, never as a JS RegExp: JS rejects the `s`/`x` options
    // and PCRE-only syntax ((?i), (?P<name>…)) and that failed the whole page; the BSON value
    // keeps pattern and options as the server has them. Every read inherits this client option.
    bsonRegExp: true
  }

  const mechanism = mongo?.authMechanism?.trim() || undefined
  if (mechanism) options.authMechanism = mechanism as MongoClientOptions['authMechanism']
  if (mongo?.authSource?.trim()) options.authSource = mongo.authSource.trim()
  const user = config.user?.trim()
  const passwordless =
    mechanism === 'MONGODB-X509' ||
    mechanism === 'MONGODB-AWS' ||
    mechanism === 'MONGODB-OIDC' ||
    mechanism === 'GSSAPI'
  // No user: unauthenticated, or X.509 / AWS / OIDC taking the identity from the certificate or
  // the environment.
  if (user) {
    options.auth =
      passwordless && !secrets.password
        ? { username: user }
        : { username: user, password: secrets.password ?? '' }
  }

  if (mongo?.replicaSet?.trim()) options.replicaSet = mongo.replicaSet.trim()
  if (mongo?.directConnection !== undefined && !srv)
    options.directConnection = mongo.directConnection
  if (mongo?.readPreference?.trim()) {
    options.readPreference = mongo.readPreference.trim() as MongoClientOptions['readPreference']
  }

  Object.assign(options, tlsFromSslMode(config))
  if (mongo?.tls !== undefined) options.tls = mongo.tls
  if (mongo?.tlsAllowInvalidCertificates !== undefined) {
    options.tlsAllowInvalidCertificates = mongo.tlsAllowInvalidCertificates
  }
  let tlsFiles: MongoClientConfig['tlsFiles']
  if (config.ssl && config.ssl.mode !== 'disable') {
    if (config.ssl.caPath) options.tlsCAFile = expandHome(config.ssl.caPath)
    const certPath = config.ssl.certPath ? expandHome(config.ssl.certPath) : undefined
    const keyPath = config.ssl.keyPath ? expandHome(config.ssl.keyPath) : undefined
    if (certPath && keyPath && certPath !== keyPath) tlsFiles = { certPath, keyPath }
    else if (certPath || keyPath) options.tlsCertificateKeyFile = certPath ?? keyPath
    if ((options.tlsCAFile || certPath || keyPath) && options.tls === undefined) options.tls = true
  }
  if (options.tls === false) {
    delete options.tlsAllowInvalidCertificates
    delete options.tlsAllowInvalidHostnames
    delete options.tlsCAFile
    delete options.tlsCertificateKeyFile
    tlsFiles = undefined
  }

  return {
    uri,
    options,
    tlsFiles,
    describe: `${scheme}://${hosts.join(',')}${database ? `/${database}` : ''}`
  }
}
