import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { CustomCommandsEditor } from '@/components/custom-commands/CustomCommandsEditor'
import type { CustomProjectCommand } from '@/lib/custom-commands'
import { toast } from '@/lib/toast'
import { useSettingsStore } from '@/stores/useSettingsStore'

function cleanCommands(commands: CustomProjectCommand[]): CustomProjectCommand[] {
  return commands.filter((command) => command.name.trim() !== '' && command.prompt.trim() !== '')
}

export function SettingsCustomCommands(): React.JSX.Element {
  const customProjectCommands = useSettingsStore((state) => state.customProjectCommands)
  const updateSetting = useSettingsStore((state) => state.updateSetting)
  const [commands, setCommands] = useState<CustomProjectCommand[]>(customProjectCommands)

  useEffect(() => {
    setCommands(customProjectCommands)
  }, [customProjectCommands])

  const handleSave = async (): Promise<void> => {
    await updateSetting('customProjectCommands', cleanCommands(commands))
    toast.success('Custom commands saved')
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold">Custom Commands</h2>
        <p className="text-sm text-muted-foreground">
          Global commands appear on every worktree. Project commands with the same name override
          them.
        </p>
      </div>

      <CustomCommandsEditor value={commands} onChange={setCommands} />

      <div className="flex justify-end">
        <Button onClick={handleSave}>Save</Button>
      </div>
    </div>
  )
}
