// The wizard's form model: URL → fields → config round trips per engine, environment/safe-mode
// defaults, per-field validation, the edit-mode secret semantics (keep / replace / clear) and the
// SQLite "New file…" create switch (test config only, never saved).

import { describe, expect, it } from 'vitest'
import { parseConnectionUrl } from '@shared/data-projects/connection-url'
import { BUILTIN_DATA_PROJECT_DEFAULTS } from '@/stores/useDataProjectStore'
import { sampleDataProject } from '../data-project.sample'
import {
  applyParsedUrl,
  chooseEnvironment,
  defaultSafeModeFor,
  emptyForm,
  fileToCreate,
  formFromProject,
  formSecrets,
  formSecretsPatch,
  formToConfig,
  formToCreateInput,
  formToUpdatePatch,
  splitHostList,
  suggestName,
  testConfig,
  testSecrets,
  urlFromForm,
  validateConnection,
  validateDetails
} from './wizard-model'

const defaults = BUILTIN_DATA_PROJECT_DEFAULTS

const parsed = (url: string) => {
  const result = parseConnectionUrl(url)
  if (!result.ok) throw new Error(result.error)
  return result.value
}

describe('URL import', () => {
  it('fills a PostgreSQL form, moves the password to secrets and suggests a name', () => {
    const form = applyParsedUrl(
      emptyForm('mysql', defaults),
      parsed('postgres://app:p%40ss@db.example.com:5433/shop?sslmode=require'),
      defaults
    )
    expect(form).toMatchObject({
      engine: 'postgres',
      host: 'db.example.com',
      port: '5433',
      user: 'app',
      database: 'shop',
      sslMode: 'require',
      password: 'p@ss',
      name: 'shop @ db.example.com',
      environment: 'development'
    })
    expect(formToConfig(form)).toEqual({
      host: 'db.example.com',
      port: 5433,
      user: 'app',
      database: 'shop',
      ssl: { mode: 'require' }
    })
    expect(formSecrets(form)).toEqual({ password: 'p@ss' })
    // The URL tab never shows the password again.
    expect(urlFromForm(form)).not.toContain('p@ss')
    expect(urlFromForm(form)).toContain('db.example.com:5433/shop')
  })

  it('treats localhost as a local environment with the local safe mode', () => {
    const form = applyParsedUrl(
      emptyForm('mysql', defaults),
      parsed('mysql://root:pw@localhost/shop'),
      defaults
    )
    expect(form.environment).toBe('local')
    expect(form.safeMode).toBe('off')
    // No sslmode in the URL: libpq's default.
    expect(form.sslMode).toBe('prefer')
  })

  it('round-trips a MongoDB replica set and an SRV cluster', () => {
    const replica = applyParsedUrl(
      emptyForm('mongodb', defaults),
      parsed('mongodb://u:p@h1:27017,h2:27018/shop?replicaSet=rs0&tls=true&authSource=admin'),
      defaults
    )
    expect(replica.mongoHosts).toBe('h1:27017, h2:27018')
    expect(formToConfig(replica).mongo).toEqual({
      srv: false,
      hosts: ['h1:27017', 'h2:27018'],
      authSource: 'admin',
      replicaSet: 'rs0',
      tls: true
    })

    const srv = applyParsedUrl(
      emptyForm('mongodb', defaults),
      parsed('mongodb+srv://u:p@cluster0.abc.mongodb.net/shop'),
      defaults
    )
    const config = formToConfig(srv)
    expect(config.mongo).toMatchObject({
      srv: true,
      hosts: ['cluster0.abc.mongodb.net'],
      tls: true
    })
    expect(config.port).toBeUndefined()
  })

  it('maps ClickHouse native TLS to HTTPS and SQLite paths to files', () => {
    const ch = applyParsedUrl(
      emptyForm('clickhouse', defaults),
      parsed('clickhouse://default:pw@ch.example.com:9440/shop'),
      defaults
    )
    expect(formToConfig(ch)).toMatchObject({
      host: 'ch.example.com',
      port: 8443,
      clickhouseProtocol: 'https',
      ssl: { mode: 'verify-full' }
    })

    const sqlite = applyParsedUrl(
      emptyForm('mysql', defaults),
      parsed('file:/tmp/x.db?mode=ro'),
      defaults
    )
    expect(formToConfig(sqlite)).toEqual({
      filePath: '/tmp/x.db',
      database: 'main',
      readOnlyFile: true
    })
    expect(sqlite.environment).toBe('local')
    expect(suggestName(sqlite)).toBe('x')
  })

  it('keeps an SSH tunnel and a typed name when a URL is pasted over the form', () => {
    const start = {
      ...emptyForm('postgres', defaults),
      name: 'Billing',
      nameEdited: true,
      sshEnabled: true,
      sshHost: 'bastion',
      sshUser: 'ubuntu'
    }
    const form = applyParsedUrl(start, parsed('postgres://u@10.0.0.5/billing'), defaults)
    expect(form.name).toBe('Billing')
    expect(formToConfig(form).ssh).toMatchObject({
      enabled: true,
      host: 'bastion',
      username: 'ubuntu'
    })
  })
})

describe('environment and safe mode defaults', () => {
  it('follows the environment unless a global default is stricter', () => {
    expect(defaultSafeModeFor('local', { safeMode: 'auto' })).toBe('off')
    expect(defaultSafeModeFor('production', { safeMode: 'auto' })).toBe('half-safe')
    expect(defaultSafeModeFor('local', { safeMode: 'safe' })).toBe('safe')
    // A loose global default never lowers production below its own default.
    expect(defaultSafeModeFor('production', { safeMode: 'off' })).toBe('half-safe')
  })

  it('picking production raises a hand-picked loose mode, keeps a stricter one', () => {
    const loose = {
      ...emptyForm('postgres', defaults),
      safeMode: 'off' as const,
      safeModeEdited: true
    }
    expect(chooseEnvironment(loose, 'production', defaults).safeMode).toBe('half-safe')
    const strict = { ...loose, safeMode: 'read-only' as const }
    expect(chooseEnvironment(strict, 'production', defaults).safeMode).toBe('read-only')
    const untouched = emptyForm('postgres', defaults)
    expect(chooseEnvironment(untouched, 'staging', defaults).safeMode).toBe('half-safe')
  })
})

describe('validation', () => {
  it('requires a host, a valid port and SSH details when the tunnel is on', () => {
    const form = {
      ...emptyForm('postgres', defaults),
      host: '',
      port: '70000',
      sshEnabled: true,
      sshHost: '',
      sshUser: '',
      sshAuthMethod: 'privateKey' as const
    }
    expect(validateConnection(form)).toEqual({
      host: 'Host is required',
      port: 'Port must be 1–65535',
      sshHost: 'SSH host is required',
      sshUser: 'SSH user is required',
      sshKeyPath: 'Choose the private key file'
    })
  })

  it('rejects a URL typed into the host field and relative file paths', () => {
    expect(validateConnection({ ...emptyForm('mysql', defaults), host: 'mysql://x' }).host).toBe(
      'Enter a host name or IP address only'
    )
    expect(
      validateConnection({ ...emptyForm('sqlite', defaults), filePath: 'db.sqlite' }).filePath
    ).toBe('Use an absolute path (or one starting with ~/)')
    expect(
      validateConnection({ ...emptyForm('sqlite', defaults), filePath: '~/db.sqlite' })
    ).toEqual({})
  })

  it('checks Mongo host lists, SRV included', () => {
    const mongo = emptyForm('mongodb', defaults)
    expect(validateConnection({ ...mongo, mongoHosts: '' }).mongoHosts).toBe(
      'At least one host is required'
    )
    expect(validateConnection({ ...mongo, mongoHosts: 'a:1, b:99999' }).mongoHosts).toContain(
      'b:99999'
    )
    expect(
      validateConnection({ ...mongo, mongoSrv: true, mongoHosts: 'a.net:27017' }).mongoHosts
    ).toBe('An SRV host name has no port')
    expect(validateConnection({ ...mongo, mongoHosts: '[::1]:27017, db2' })).toEqual({})
    expect(splitHostList('[::1]:27017, db2')).toEqual([
      { host: '[::1]', port: 27017, raw: '[::1]:27017' },
      { host: 'db2', port: undefined, raw: 'db2' }
    ])
  })

  it('validates the details step', () => {
    const form = {
      ...emptyForm('postgres', defaults),
      host: '',
      defaultLimit: '200000',
      queryTimeoutSec: 'x'
    }
    const errors = validateDetails(form)
    expect(errors.defaultLimit).toBeDefined()
    expect(errors.queryTimeoutSec).toBeDefined()
    // The suggested name counts: an empty name field is fine when there is a suggestion.
    expect(errors.name).toBeUndefined()
  })
})

describe('create input', () => {
  it('sends only typed secrets and the chosen details', () => {
    const form = {
      ...emptyForm('postgres', defaults),
      host: 'db',
      password: 'pw',
      pinned: true,
      icon: { kind: 'emoji' as const, emoji: '🐘' }
    }
    expect(formToCreateInput(form)).toMatchObject({
      name: 'postgres @ db',
      engine: 'postgres',
      secrets: { password: 'pw' },
      pinned: true,
      icon: { kind: 'emoji', emoji: '🐘' },
      environment: 'development',
      safeMode: 'off',
      defaultLimit: 1000
    })
    expect(formToCreateInput({ ...form, password: '' }).secrets).toBeUndefined()
  })
})

describe('edit mode secrets', () => {
  const project = sampleDataProject({
    config: {
      host: 'db',
      port: 5432,
      database: 'shop',
      user: 'app',
      ssh: { enabled: true, host: 'bastion', port: 22, username: 'u', authMethod: 'password' }
    }
  })

  it('starts as "keep" when a secret is stored and sends nothing for it', () => {
    const form = formFromProject(project, defaults)
    expect(form.passwordMode).toBe('keep')
    expect(formSecretsPatch(form)).toBeUndefined()
    expect(formToUpdatePatch(form, project)).toEqual({})
  })

  it('replace sends the new value, clear sends null', () => {
    const form = {
      ...formFromProject(project, defaults),
      passwordMode: 'replace' as const,
      password: 'new',
      sshPasswordMode: 'clear' as const
    }
    expect(formSecretsPatch(form)).toEqual({ password: 'new', sshPassword: null })
    expect(formToUpdatePatch(form, project)).toEqual({
      secrets: { password: 'new', sshPassword: null }
    })
    // The test uses the typed password and an empty one for the cleared secret.
    expect(testSecrets(form)).toEqual({ password: 'new', sshPassword: '' })
  })

  it('a project without stored secrets edits them like a new one', () => {
    const form = formFromProject(sampleDataProject({ secretState: 'none' }), defaults)
    expect(form.passwordMode).toBe('replace')
    expect(formSecretsPatch({ ...form, password: '' })).toBeUndefined()
    expect(formSecretsPatch({ ...form, password: 'x' })).toEqual({ password: 'x' })
  })

  it('only changed fields go into the update', () => {
    const form = { ...formFromProject(project, defaults), host: 'db2', safeMode: 'safe' as const }
    const patch = formToUpdatePatch(form, project)
    expect(patch.config?.host).toBe('db2')
    expect(patch.safeMode).toBe('safe')
    expect(patch.name).toBeUndefined()
    expect(patch.secrets).toBeUndefined()
  })
})

describe('SQLite "New file…"', () => {
  const newFile = {
    ...emptyForm('sqlite', defaults),
    filePath: ' ~/data/new.sqlite ',
    createFile: true
  }

  it('tests with the create switch and saves without it', () => {
    expect(fileToCreate(newFile)).toBe('~/data/new.sqlite')
    expect(testConfig(newFile)).toEqual({
      filePath: '~/data/new.sqlite',
      database: 'main',
      options: { create: 'true' }
    })
    expect(formToConfig(newFile)).toEqual({ filePath: '~/data/new.sqlite', database: 'main' })
    expect(formToCreateInput(newFile).config).toEqual({
      filePath: '~/data/new.sqlite',
      database: 'main'
    })
  })

  it('never creates a typed path, a read-only file or anything for other engines', () => {
    const typed = { ...newFile, createFile: false }
    expect(fileToCreate(typed)).toBeNull()
    expect(testConfig(typed).options).toBeUndefined()
    expect(fileToCreate({ ...newFile, readOnlyFile: true })).toBeNull()
    expect(testConfig({ ...newFile, readOnlyFile: true }).options).toBeUndefined()
    expect(fileToCreate({ ...emptyForm('postgres', defaults), createFile: true })).toBeNull()
  })

  it('drops a stored create switch from an edited connection and keeps its other options', () => {
    const project = sampleDataProject({
      engine: 'sqlite',
      config: { filePath: '/data/app.sqlite', options: { create: 'true', mode: 'wal' } }
    })
    const form = formFromProject(project, defaults)
    expect(form.createFile).toBe(false)
    expect(formToConfig(form)).toEqual({
      filePath: '/data/app.sqlite',
      database: 'main',
      options: { mode: 'wal' }
    })
  })
})
