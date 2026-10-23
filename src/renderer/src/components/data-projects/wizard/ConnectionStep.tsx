// Wizard step 2: how to reach the database. Two synced views of one form:
// - Fields: host/port/user/password/database per engine, SSL (mode + CA/cert/key pickers), an
//   SSH tunnel for the SQL engines that support it, a file picker (incl. "New file…") for SQLite,
//   hosts / SRV / authSource / replica set / TLS for MongoDB, http/https for ClickHouse.
// - URL: the same settings as one connection URL (rebuilt from the fields when the tab opens,
//   never with the password). Typing a valid URL updates the fields at once; a password inside
//   the URL becomes the typed password and never shows up again.

import { useState } from 'react'
import { ArrowLeft, ChevronRight, Info, TriangleAlert } from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import {
  DATA_ENGINE_INFO,
  type DataProject,
  type DataSshAuthMethod,
  type DataSslMode
} from '@shared/data-projects/types'
import { parseConnectionUrl } from '@shared/data-projects/connection-url'
import type { DataProjectDefaults } from '@/stores/useDataProjectStore'
import { EngineTile } from '../engine-logos'
import {
  Field,
  FilePathInput,
  NativeSelect,
  SecretInput,
  SectionTitle,
  Segmented,
  invalidProps,
  type SelectOption
} from './wizard-fields'
import {
  SSH_CAPABLE_ENGINES,
  SSL_MODE_ENGINES,
  applyParsedUrl,
  autoEnvironment,
  urlFromForm,
  type FieldErrors,
  type WizardForm
} from './wizard-model'

const PG_SSL_OPTIONS: ReadonlyArray<SelectOption<DataSslMode | ''>> = [
  { value: 'disable', label: 'Disable — plain connection' },
  { value: 'prefer', label: 'Prefer — TLS when the server offers it' },
  { value: 'require', label: 'Require — TLS, certificate not checked' },
  { value: 'verify-ca', label: 'Verify CA — TLS, CA must sign the certificate' },
  { value: 'verify-full', label: 'Verify full — TLS, CA and host name checked' }
]

const MYSQL_SSL_OPTIONS: ReadonlyArray<SelectOption<DataSslMode | ''>> = [
  { value: 'disable', label: 'DISABLED — plain connection' },
  { value: 'prefer', label: 'PREFERRED — TLS when the server offers it' },
  { value: 'require', label: 'REQUIRED — TLS, certificate not checked' },
  { value: 'verify-ca', label: 'VERIFY_CA — TLS, CA must sign the certificate' },
  { value: 'verify-full', label: 'VERIFY_IDENTITY — TLS, CA and host name checked' }
]

const HTTPS_VERIFY_OPTIONS: ReadonlyArray<SelectOption<DataSslMode | ''>> = [
  { value: 'verify-full', label: 'Verify certificate and host name' },
  { value: 'verify-ca', label: 'Verify certificate only' },
  { value: 'require', label: 'Do not verify (self-signed)' }
]

const MONGO_AUTH_MECHANISMS: ReadonlyArray<SelectOption<string>> = [
  { value: '', label: 'Default (SCRAM)' },
  { value: 'SCRAM-SHA-256', label: 'SCRAM-SHA-256' },
  { value: 'SCRAM-SHA-1', label: 'SCRAM-SHA-1' },
  { value: 'MONGODB-X509', label: 'X.509 certificate' },
  { value: 'MONGODB-AWS', label: 'AWS IAM' },
  { value: 'PLAIN', label: 'LDAP (PLAIN)' }
]

const MONGO_READ_PREFERENCES: ReadonlyArray<SelectOption<string>> = [
  { value: '', label: 'Default (primary)' },
  { value: 'primary', label: 'primary' },
  { value: 'primaryPreferred', label: 'primaryPreferred' },
  { value: 'secondary', label: 'secondary' },
  { value: 'secondaryPreferred', label: 'secondaryPreferred' },
  { value: 'nearest', label: 'nearest' }
]

const SSH_AUTH_OPTIONS: ReadonlyArray<SelectOption<DataSshAuthMethod>> = [
  { value: 'agent', label: 'SSH agent' },
  { value: 'privateKey', label: 'Key file' },
  { value: 'password', label: 'Password' }
]

export interface ConnectionStepProps {
  form: WizardForm
  onChange: (updater: (form: WizardForm) => WizardForm) => void
  errors: FieldErrors
  /** Edit mode: the project being edited (engine fixed, secrets may be saved). */
  project: DataProject | null
  defaults: DataProjectDefaults
  onChangeEngine?: () => void
  /** Warnings of the URL that filled the form (from the engine step). */
  importWarnings?: string[]
}

export function ConnectionStep({
  form,
  onChange,
  errors,
  project,
  defaults,
  onChangeEngine,
  importWarnings
}: ConnectionStepProps): React.JSX.Element {
  const [view, setView] = useState<'fields' | 'url'>('fields')
  const [urlText, setUrlText] = useState('')
  const [urlError, setUrlError] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<string[]>(importWarnings ?? [])
  const info = DATA_ENGINE_INFO[form.engine]
  const editing = project !== null
  const hasSavedSecret = project?.secretState === 'stored' || project?.secretState === 'session'

  const set = <K extends keyof WizardForm>(key: K, value: WizardForm[K]): void =>
    onChange((f) => ({ ...f, [key]: value }))

  /** Host edits move the auto environment (localhost → local) until the user picks one. */
  const setHost = (key: 'host' | 'mongoHosts', value: string): void =>
    onChange((f) => autoEnvironment({ ...f, [key]: value }, defaults))

  const showView = (next: 'fields' | 'url'): void => {
    if (next === 'url') {
      setUrlText(urlFromForm(form))
      setUrlError(null)
    }
    setView(next)
  }

  const applyUrl = (text: string): void => {
    setUrlText(text)
    if (!text.trim()) {
      setUrlError(null)
      return
    }
    const result = parseConnectionUrl(text, form.engine)
    if (!result.ok) {
      setUrlError(result.error)
      return
    }
    if (editing && result.value.engine !== form.engine) {
      setUrlError(
        `This is a ${DATA_ENGINE_INFO[result.value.engine].label} URL; this connection is ${info.label}.`
      )
      return
    }
    setUrlError(null)
    setWarnings(result.value.warnings)
    onChange((f) => applyParsedUrl(f, result.value, defaults))
  }

  const id = (name: string): string => `data-project-wizard-${name}`

  return (
    <div className="flex flex-col gap-4" data-testid="data-project-wizard-connection-step">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <EngineTile engine={form.engine} className="size-6 rounded-[5px]" />
          <span className="text-[13px] font-medium">{info.label}</span>
          {!editing && onChangeEngine && (
            <button
              type="button"
              onClick={onChangeEngine}
              className="inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground"
              data-testid="data-project-wizard-change-engine"
            >
              <ArrowLeft className="size-3" />
              Change
            </button>
          )}
        </div>
        <Segmented
          ariaLabel="Connection input"
          value={view}
          onChange={showView}
          options={[
            { value: 'fields', label: 'Fields' },
            { value: 'url', label: 'URL' }
          ]}
          testId="data-project-wizard-view"
        />
      </div>

      {warnings.length > 0 && (
        <ul
          className="flex flex-col gap-1 rounded-md border border-amber-500/30 bg-amber-500/8 px-3 py-2 text-[12px] text-amber-700 dark:text-amber-300"
          data-testid="data-project-wizard-url-warnings"
        >
          {warnings.map((warning) => (
            <li key={warning} className="flex gap-1.5">
              <TriangleAlert className="mt-0.5 size-3 shrink-0" />
              <span>{warning}</span>
            </li>
          ))}
        </ul>
      )}

      {view === 'url' ? (
        <Field
          label="Connection URL"
          htmlFor={id('url')}
          error={urlError ?? undefined}
          hint="Edits here update the fields. The password is never shown here once saved."
        >
          <Input
            id={id('url')}
            value={urlText}
            onChange={(e) => applyUrl(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            className="font-mono text-[12px]"
            data-testid="data-project-wizard-url"
            {...invalidProps(id('url'), urlError ?? undefined)}
          />
        </Field>
      ) : form.engine === 'sqlite' ? (
        <SqliteFields form={form} set={set} errors={errors} id={id} />
      ) : form.engine === 'mongodb' ? (
        <MongoFields
          form={form}
          set={set}
          setHost={setHost}
          errors={errors}
          id={id}
          hasSavedSecret={hasSavedSecret}
        />
      ) : (
        <SqlFields
          form={form}
          set={set}
          setHost={setHost}
          errors={errors}
          id={id}
          hasSavedSecret={hasSavedSecret}
        />
      )}

      {project?.secretState === 'unavailable' && form.engine !== 'sqlite' && (
        <p
          className="flex gap-1.5 rounded-md bg-amber-500/8 px-3 py-2 text-[12px] text-amber-700 dark:text-amber-300"
          data-testid="data-project-wizard-secret-unavailable"
        >
          <Info className="mt-0.5 size-3.5 shrink-0" />
          The saved password cannot be read on this Mac (Keychain reset or a copied database). Enter
          it again to save it.
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Per-engine field groups
// ---------------------------------------------------------------------------------------------

type SetField = <K extends keyof WizardForm>(key: K, value: WizardForm[K]) => void

interface GroupProps {
  form: WizardForm
  set: SetField
  errors: FieldErrors
  id: (name: string) => string
}

function SqliteFields({ form, set, errors, id }: GroupProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <Field
        label="Database file"
        htmlFor={id('file-path')}
        error={errors.filePath}
        hint=".sqlite, .sqlite3, .db or .db3. “New file…” creates an empty database."
      >
        <FilePathInput
          id={id('file-path')}
          value={form.filePath}
          onChange={(value, meta) => {
            set('filePath', value)
            // Only a "New file…" pick is created; a typed or browsed path must exist.
            set('createFile', meta?.isNew === true)
          }}
          purpose="sqlite"
          allowCreate
          placeholder="/Users/me/data/app.sqlite"
          testId="data-project-wizard-file-path"
          error={errors.filePath}
        />
      </Field>
      <label className="flex items-center gap-2 text-[13px]">
        <Checkbox
          checked={form.readOnlyFile}
          onCheckedChange={(checked) => set('readOnlyFile', checked)}
          data-testid="data-project-wizard-read-only-file"
        />
        Open the file read-only
      </label>
    </div>
  )
}

interface NetworkGroupProps extends GroupProps {
  setHost: (key: 'host' | 'mongoHosts', value: string) => void
  hasSavedSecret: boolean
}

function CredentialsRow({
  form,
  set,
  errors,
  id,
  hasSavedSecret
}: GroupProps & { hasSavedSecret: boolean }): React.JSX.Element {
  return (
    <div className="grid grid-cols-2 gap-3">
      <Field
        label="User"
        htmlFor={id('user')}
        error={errors.user}
        optional={form.engine === 'mongodb'}
      >
        <Input
          id={id('user')}
          value={form.user}
          onChange={(e) => set('user', e.target.value)}
          autoComplete="off"
          spellCheck={false}
          placeholder={DATA_ENGINE_INFO[form.engine].defaultUser || 'user'}
          data-testid="data-project-wizard-user"
          {...invalidProps(id('user'), errors.user)}
        />
      </Field>
      <Field label="Password" htmlFor={id('password')} error={errors.password} optional>
        <SecretInput
          id={id('password')}
          value={form.password}
          onChange={(value) => set('password', value)}
          mode={form.passwordMode}
          onModeChange={(mode) => set('passwordMode', mode)}
          hasSaved={hasSavedSecret}
          testId="data-project-wizard-password"
          error={errors.password}
        />
      </Field>
    </div>
  )
}

function SqlFields(props: NetworkGroupProps): React.JSX.Element {
  const { form, set, setHost, errors, id } = props
  const isClickHouse = form.engine === 'clickhouse'
  const showSslMode = SSL_MODE_ENGINES.has(form.engine)
  const tlsOn = isClickHouse
    ? form.clickhouseProtocol === 'https'
    : form.sslMode !== '' && form.sslMode !== 'disable'
  const [sslOpen, setSslOpen] = useState(
    Boolean(form.caPath || form.certPath || form.keyPath) ||
      (form.sslMode !== '' && form.sslMode !== 'prefer' && form.sslMode !== 'disable')
  )

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-[1fr_96px] gap-3">
        <Field label="Host" htmlFor={id('host')} error={errors.host}>
          <Input
            id={id('host')}
            value={form.host}
            onChange={(e) => setHost('host', e.target.value)}
            autoComplete="off"
            spellCheck={false}
            placeholder="localhost"
            data-testid="data-project-wizard-host"
            {...invalidProps(id('host'), errors.host)}
          />
        </Field>
        <Field label="Port" htmlFor={id('port')} error={errors.port}>
          <Input
            id={id('port')}
            value={form.port}
            onChange={(e) => set('port', e.target.value.replace(/[^\d]/g, ''))}
            inputMode="numeric"
            placeholder={String(DATA_ENGINE_INFO[form.engine].defaultPort ?? '')}
            data-testid="data-project-wizard-port"
            {...invalidProps(id('port'), errors.port)}
          />
        </Field>
      </div>

      {isClickHouse && (
        <Field label="HTTP interface" htmlFor={id('protocol')}>
          <Segmented
            ariaLabel="ClickHouse protocol"
            value={form.clickhouseProtocol}
            onChange={(protocol) => {
              set('clickhouseProtocol', protocol)
              // Switch the port with the protocol when it was the other default.
              if (protocol === 'https' && (form.port === '8123' || !form.port)) set('port', '8443')
              if (protocol === 'http' && (form.port === '8443' || !form.port)) set('port', '8123')
            }}
            options={[
              { value: 'http', label: 'HTTP' },
              { value: 'https', label: 'HTTPS' }
            ]}
            testId="data-project-wizard-clickhouse-protocol"
          />
        </Field>
      )}

      <CredentialsRow {...props} />

      <Field
        label="Database"
        htmlFor={id('database')}
        optional
        hint={
          form.engine === 'postgres'
            ? 'The database to connect to; others are one click away in the client.'
            : 'Default database; leave empty to browse all of them.'
        }
      >
        <Input
          id={id('database')}
          value={form.database}
          onChange={(e) => set('database', e.target.value)}
          autoComplete="off"
          spellCheck={false}
          placeholder={DATA_ENGINE_INFO[form.engine].defaultDatabase || 'database'}
          data-testid="data-project-wizard-database"
        />
      </Field>

      <Collapsible
        title={isClickHouse ? 'TLS' : 'SSL / TLS'}
        summary={
          isClickHouse
            ? form.clickhouseProtocol === 'https'
              ? 'HTTPS'
              : 'Off (HTTP)'
            : sslSummary(form.sslMode)
        }
        open={sslOpen}
        onToggle={() => setSslOpen((v) => !v)}
        testId="data-project-wizard-ssl"
      >
        {showSslMode && (
          <Field label="SSL mode" htmlFor={id('ssl-mode')}>
            <NativeSelect
              id={id('ssl-mode')}
              value={form.sslMode || 'disable'}
              onChange={(mode) => set('sslMode', mode)}
              options={form.engine === 'postgres' ? PG_SSL_OPTIONS : MYSQL_SSL_OPTIONS}
              testId="data-project-wizard-ssl-mode"
            />
          </Field>
        )}
        {isClickHouse && form.clickhouseProtocol === 'https' && (
          <Field label="Certificate check" htmlFor={id('ssl-mode')}>
            <NativeSelect
              id={id('ssl-mode')}
              value={
                form.sslMode && form.sslMode !== 'disable' && form.sslMode !== 'prefer'
                  ? form.sslMode
                  : 'verify-full'
              }
              onChange={(mode) => set('sslMode', mode)}
              options={HTTPS_VERIFY_OPTIONS}
              testId="data-project-wizard-ssl-mode"
            />
          </Field>
        )}
        {isClickHouse && form.clickhouseProtocol === 'http' && (
          <p className="text-[12px] text-muted-foreground">
            Switch the HTTP interface to HTTPS to use TLS.
          </p>
        )}
        {tlsOn && <CertificateFields {...props} />}
      </Collapsible>

      {SSH_CAPABLE_ENGINES.has(form.engine) && <SshFields {...props} />}
    </div>
  )
}

function sslSummary(mode: DataSslMode | ''): string {
  switch (mode) {
    case '':
    case 'disable':
      return 'Off'
    case 'prefer':
      return 'Prefer'
    case 'require':
      return 'Required'
    case 'verify-ca':
      return 'Verify CA'
    case 'verify-full':
      return 'Verify full'
  }
}

function CertificateFields({ form, set, errors, id }: GroupProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <Field label="CA certificate" htmlFor={id('ca-path')} error={errors.caPath} optional>
        <FilePathInput
          id={id('ca-path')}
          value={form.caPath}
          onChange={(value) => set('caPath', value)}
          purpose="certificate"
          placeholder="~/certs/ca.pem"
          testId="data-project-wizard-ca-path"
          error={errors.caPath}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field
          label="Client certificate"
          htmlFor={id('cert-path')}
          error={errors.certPath}
          optional
        >
          <FilePathInput
            id={id('cert-path')}
            value={form.certPath}
            onChange={(value) => set('certPath', value)}
            purpose="certificate"
            testId="data-project-wizard-cert-path"
            error={errors.certPath}
          />
        </Field>
        {form.engine !== 'mongodb' && (
          <Field label="Client key" htmlFor={id('key-path')} error={errors.keyPath} optional>
            <FilePathInput
              id={id('key-path')}
              value={form.keyPath}
              onChange={(value) => set('keyPath', value)}
              purpose="certificate"
              testId="data-project-wizard-key-path"
              error={errors.keyPath}
            />
          </Field>
        )}
      </div>
    </div>
  )
}

function SshFields({
  form,
  set,
  errors,
  id,
  hasSavedSecret
}: NetworkGroupProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3 rounded-[9px] border border-border p-3">
      <label className="flex items-center gap-2 text-[13px] font-medium">
        <Checkbox
          checked={form.sshEnabled}
          onCheckedChange={(checked) => set('sshEnabled', checked)}
          data-testid="data-project-wizard-ssh-enabled"
        />
        Connect through an SSH tunnel
      </label>
      {form.sshEnabled && (
        <>
          <div className="grid grid-cols-[1fr_96px] gap-3">
            <Field label="SSH host" htmlFor={id('ssh-host')} error={errors.sshHost}>
              <Input
                id={id('ssh-host')}
                value={form.sshHost}
                onChange={(e) => set('sshHost', e.target.value)}
                autoComplete="off"
                spellCheck={false}
                placeholder="bastion.example.com"
                data-testid="data-project-wizard-ssh-host"
                {...invalidProps(id('ssh-host'), errors.sshHost)}
              />
            </Field>
            <Field label="Port" htmlFor={id('ssh-port')} error={errors.sshPort}>
              <Input
                id={id('ssh-port')}
                value={form.sshPort}
                onChange={(e) => set('sshPort', e.target.value.replace(/[^\d]/g, ''))}
                inputMode="numeric"
                data-testid="data-project-wizard-ssh-port"
                {...invalidProps(id('ssh-port'), errors.sshPort)}
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="SSH user" htmlFor={id('ssh-user')} error={errors.sshUser}>
              <Input
                id={id('ssh-user')}
                value={form.sshUser}
                onChange={(e) => set('sshUser', e.target.value)}
                autoComplete="off"
                spellCheck={false}
                placeholder="ubuntu"
                data-testid="data-project-wizard-ssh-user"
                {...invalidProps(id('ssh-user'), errors.sshUser)}
              />
            </Field>
            <Field label="Authentication" htmlFor={id('ssh-auth')}>
              <Segmented
                ariaLabel="SSH authentication"
                value={form.sshAuthMethod}
                onChange={(method) => set('sshAuthMethod', method)}
                options={SSH_AUTH_OPTIONS}
                testId="data-project-wizard-ssh-auth"
              />
            </Field>
          </div>
          {form.sshAuthMethod === 'privateKey' && (
            <>
              <Field label="Private key" htmlFor={id('ssh-key')} error={errors.sshKeyPath}>
                <FilePathInput
                  id={id('ssh-key')}
                  value={form.sshKeyPath}
                  onChange={(value) => set('sshKeyPath', value)}
                  purpose="ssh-key"
                  placeholder="~/.ssh/id_ed25519"
                  testId="data-project-wizard-ssh-key-path"
                  error={errors.sshKeyPath}
                />
              </Field>
              <Field label="Key passphrase" htmlFor={id('ssh-passphrase')} optional>
                <SecretInput
                  id={id('ssh-passphrase')}
                  value={form.sshPassphrase}
                  onChange={(value) => set('sshPassphrase', value)}
                  mode={form.sshPassphraseMode}
                  onModeChange={(mode) => set('sshPassphraseMode', mode)}
                  hasSaved={hasSavedSecret}
                  testId="data-project-wizard-ssh-passphrase"
                />
              </Field>
            </>
          )}
          {form.sshAuthMethod === 'password' && (
            <Field label="SSH password" htmlFor={id('ssh-password')}>
              <SecretInput
                id={id('ssh-password')}
                value={form.sshPassword}
                onChange={(value) => set('sshPassword', value)}
                mode={form.sshPasswordMode}
                onModeChange={(mode) => set('sshPasswordMode', mode)}
                hasSaved={hasSavedSecret}
                testId="data-project-wizard-ssh-password"
              />
            </Field>
          )}
          {form.sshAuthMethod === 'agent' && (
            <p className="text-[12px] text-muted-foreground">
              Uses the keys loaded in your SSH agent (SSH_AUTH_SOCK).
            </p>
          )}
        </>
      )}
    </div>
  )
}

function MongoFields(props: NetworkGroupProps): React.JSX.Element {
  const { form, set, setHost, errors, id } = props
  const [advancedOpen, setAdvancedOpen] = useState(
    Boolean(
      form.replicaSet ||
      form.authMechanism ||
      form.readPreference ||
      form.directConnection ||
      form.caPath ||
      form.certPath ||
      form.tlsAllowInvalidCertificates
    )
  )
  return (
    <div className="flex flex-col gap-3">
      <label className="flex items-center gap-2 text-[13px]">
        <Checkbox
          checked={form.mongoSrv}
          onCheckedChange={(checked) => {
            set('mongoSrv', checked)
            // SRV implies TLS (Atlas); a plain seed list keeps whatever was chosen.
            if (checked) set('mongoTls', true)
          }}
          data-testid="data-project-wizard-mongo-srv"
        />
        DNS seed list (mongodb+srv)
      </label>
      <Field
        label={form.mongoSrv ? 'Cluster host' : 'Hosts'}
        htmlFor={id('mongo-hosts')}
        error={errors.mongoHosts}
        hint={
          form.mongoSrv
            ? 'One host name, no port (e.g. cluster0.abcde.mongodb.net).'
            : 'host:port, comma-separated for a replica set.'
        }
      >
        <Input
          id={id('mongo-hosts')}
          value={form.mongoHosts}
          onChange={(e) => setHost('mongoHosts', e.target.value)}
          autoComplete="off"
          spellCheck={false}
          placeholder={form.mongoSrv ? 'cluster0.abcde.mongodb.net' : 'localhost:27017'}
          data-testid="data-project-wizard-mongo-hosts"
          {...invalidProps(id('mongo-hosts'), errors.mongoHosts)}
        />
      </Field>
      <CredentialsRow {...props} />
      <div className="grid grid-cols-2 gap-3">
        <Field label="Default database" htmlFor={id('database')} optional>
          <Input
            id={id('database')}
            value={form.database}
            onChange={(e) => set('database', e.target.value)}
            autoComplete="off"
            spellCheck={false}
            placeholder="shop"
            data-testid="data-project-wizard-database"
          />
        </Field>
        <Field label="Auth source" htmlFor={id('auth-source')} optional hint="Usually admin">
          <Input
            id={id('auth-source')}
            value={form.authSource}
            onChange={(e) => set('authSource', e.target.value)}
            autoComplete="off"
            spellCheck={false}
            placeholder="admin"
            data-testid="data-project-wizard-auth-source"
          />
        </Field>
      </div>
      <label className="flex items-center gap-2 text-[13px]">
        <Checkbox
          checked={form.mongoTls || form.mongoSrv}
          disabled={form.mongoSrv}
          onCheckedChange={(checked) => set('mongoTls', checked)}
          data-testid="data-project-wizard-mongo-tls"
        />
        Use TLS
      </label>
      <Collapsible
        title="Advanced"
        summary={form.replicaSet ? `Replica set ${form.replicaSet}` : ''}
        open={advancedOpen}
        onToggle={() => setAdvancedOpen((v) => !v)}
        testId="data-project-wizard-mongo-advanced"
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="Replica set" htmlFor={id('replica-set')} optional>
            <Input
              id={id('replica-set')}
              value={form.replicaSet}
              onChange={(e) => set('replicaSet', e.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder="rs0"
              data-testid="data-project-wizard-replica-set"
            />
          </Field>
          <Field label="Auth mechanism" htmlFor={id('auth-mechanism')}>
            <NativeSelect
              id={id('auth-mechanism')}
              value={form.authMechanism}
              onChange={(value) => set('authMechanism', value)}
              options={MONGO_AUTH_MECHANISMS}
              testId="data-project-wizard-auth-mechanism"
            />
          </Field>
          <Field label="Read preference" htmlFor={id('read-preference')}>
            <NativeSelect
              id={id('read-preference')}
              value={form.readPreference}
              onChange={(value) => set('readPreference', value)}
              options={MONGO_READ_PREFERENCES}
              testId="data-project-wizard-read-preference"
            />
          </Field>
          <div className="flex flex-col justify-end gap-2 pb-1">
            <label className="flex items-center gap-2 text-[13px]">
              <Checkbox
                checked={form.directConnection}
                disabled={form.mongoSrv}
                onCheckedChange={(checked) => set('directConnection', checked)}
                data-testid="data-project-wizard-direct-connection"
              />
              Direct connection
            </label>
            <label className="flex items-center gap-2 text-[13px]">
              <Checkbox
                checked={form.tlsAllowInvalidCertificates}
                onCheckedChange={(checked) => set('tlsAllowInvalidCertificates', checked)}
                data-testid="data-project-wizard-tls-allow-invalid"
              />
              Allow invalid certificates
            </label>
          </div>
        </div>
        {(form.mongoTls || form.mongoSrv) && <CertificateFields {...props} />}
      </Collapsible>
    </div>
  )
}

function Collapsible({
  title,
  summary,
  open,
  onToggle,
  testId,
  children
}: {
  title: string
  summary: string
  open: boolean
  onToggle: () => void
  testId: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex items-center gap-1.5 text-left"
        data-testid={`${testId}-toggle`}
      >
        <ChevronRight
          className={cn('size-3.5 text-muted-foreground transition-transform', open && 'rotate-90')}
        />
        <SectionTitle>{title}</SectionTitle>
        {summary && <span className="text-[11px] text-muted-foreground">· {summary}</span>}
      </button>
      {open && (
        <div className="flex flex-col gap-3 pl-5" data-testid={`${testId}-body`}>
          {children}
        </div>
      )}
    </div>
  )
}
