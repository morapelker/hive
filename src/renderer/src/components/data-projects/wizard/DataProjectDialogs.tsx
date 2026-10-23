// The data projects' global dialogs, mounted once in AppLayout: add/edit wizard, credentials
// prompt and change-icon dialog. Each renders nothing until useDataProjectStore asks for it.

import { CredentialsPrompt } from '../CredentialsPrompt'
import { AddDataProjectWizard } from './AddDataProjectWizard'
import { ChangeIconDialog } from './ChangeIconDialog'

export function DataProjectDialogs(): React.JSX.Element {
  return (
    <>
      <AddDataProjectWizard />
      <CredentialsPrompt />
      <ChangeIconDialog />
    </>
  )
}
