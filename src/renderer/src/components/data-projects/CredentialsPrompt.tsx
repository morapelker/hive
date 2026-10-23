// Asks for a data project's password when the server has none it can use (DATA_CREDENTIALS_
// REQUIRED: never saved, saved on another Mac, Keychain reset, or kept for one session only and
// the app restarted). Opened by useDataProjectStore.connect; mounted once (DataProjectDialogs).
// What is typed goes straight to `provideSessionSecrets` and lives only in this dialog's state
// (gone when it closes); "Remember" stores it encrypted (safeStorage) instead of for this
// session only.

import { useState } from 'react'
import { KeyRound, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useDataProjectStore } from '@/stores/useDataProjectStore'
import type { DataProject, DataSecrets } from '@shared/data-projects/types'
import { DataProjectIcon } from './DataProjectIcon'
import {
  credentialFieldsFor,
  describeDataProjectTarget,
  type CredentialField
} from './data-project-ui'

const FIELD_LABEL: Readonly<Record<CredentialField, string>> = {
  password: 'Password',
  sshPassword: 'SSH password',
  sshPassphrase: 'SSH key passphrase'
}

export function CredentialsPrompt(): React.JSX.Element | null {
  const request = useDataProjectStore((s) => s.credentialsPrompt)
  const project = useDataProjectStore((s) =>
    request ? s.projects.find((p) => p.id === request.projectId) : undefined
  )
  if (!request || !project) return null
  return <CredentialsDialog key={project.id} project={project} message={request.message} />
}

function CredentialsDialog({
  project,
  message
}: {
  project: DataProject
  message?: string
}): React.JSX.Element {
  const close = useDataProjectStore((s) => s.closeCredentialsPrompt)
  const submitCredentials = useDataProjectStore((s) => s.submitCredentials)
  const openWizard = useDataProjectStore((s) => s.openWizard)
  const fields = credentialFieldsFor(project)
  const [values, setValues] = useState<Partial<Record<CredentialField, string>>>({})
  const [remember, setRemember] = useState(true)
  const [submitting, setSubmitting] = useState(false)

  const submit = async (): Promise<void> => {
    if (submitting) return
    setSubmitting(true)
    const secrets: DataSecrets = {}
    for (const field of fields) {
      const value = values[field]
      if (value !== undefined && value !== '') secrets[field] = value
    }
    try {
      await submitCredentials(project.id, secrets, remember)
    } finally {
      setSubmitting(false)
    }
  }

  const user = project.config.user?.trim()

  return (
    <Dialog open onOpenChange={(open) => !open && !submitting && close()}>
      <DialogContent
        className="max-w-md"
        data-testid="data-project-credentials-prompt"
        data-db-dialog=""
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[15px]">
            <KeyRound className="size-4 text-muted-foreground" />
            Credentials for {project.name}
          </DialogTitle>
          <DialogDescription className="text-[12px]">
            {message || 'No usable password is stored for this connection.'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2 rounded-md bg-muted/50 px-3 py-2">
          <DataProjectIcon
            engine={project.engine}
            icon={project.icon}
            iconColor={project.iconColor}
            size="md"
          />
          <span className="min-w-0 truncate text-[12px] text-muted-foreground">
            {user ? `${user}@` : ''}
            {describeDataProjectTarget(project)}
          </span>
        </div>

        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          {fields.length === 0 ? (
            <p className="text-[12px] text-muted-foreground">This connection takes no password.</p>
          ) : (
            fields.map((field, index) => (
              <label key={field} className="flex flex-col gap-1">
                <span className="text-[12px] font-medium">{FIELD_LABEL[field]}</span>
                <Input
                  type="password"
                  autoComplete="off"
                  autoFocus={index === 0}
                  value={values[field] ?? ''}
                  onChange={(e) => setValues((prev) => ({ ...prev, [field]: e.target.value }))}
                  data-testid={`data-project-credentials-${field}`}
                />
              </label>
            ))
          )}
          <label className="flex items-center gap-2 text-[13px]">
            <Checkbox
              checked={remember}
              onCheckedChange={setRemember}
              data-testid="data-project-credentials-remember"
            />
            Remember in secure storage (otherwise until the app quits)
          </label>
          <DialogFooter className="mt-1 items-center sm:justify-between">
            <Button
              type="button"
              variant="link"
              size="sm"
              className="px-0 text-muted-foreground"
              onClick={() => {
                close()
                openWizard({ mode: 'edit', projectId: project.id })
              }}
              data-testid="data-project-credentials-edit"
            >
              Edit connection…
            </Button>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={close}
                disabled={submitting}
                data-testid="data-project-credentials-cancel"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={submitting}
                data-testid="data-project-credentials-submit"
              >
                {submitting && <Loader2 className="size-3.5 animate-spin" />}
                Connect
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
