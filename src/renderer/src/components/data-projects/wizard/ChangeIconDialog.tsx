// "Change icon…" from the sidebar / pinned card context menu: the wizard's icon picker in a
// small dialog, applied on Save. Store-driven (useDataProjectStore.iconDialogProjectId).

import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useDataProjectStore } from '@/stores/useDataProjectStore'
import type { DataProject, DataProjectIcon } from '@shared/data-projects/types'
import { IconPicker } from './IconPicker'
import { iconFileKey, newIconUploadKey, removeIconUpload } from './icon-uploads'

export function ChangeIconDialog(): React.JSX.Element | null {
  const projectId = useDataProjectStore((s) => s.iconDialogProjectId)
  const project = useDataProjectStore((s) =>
    projectId ? s.projects.find((p) => p.id === projectId) : undefined
  )
  if (!project) return null
  return <IconDialog key={project.id} project={project} />
}

function IconDialog({ project }: { project: DataProject }): React.JSX.Element {
  const close = useDataProjectStore((s) => s.closeIconDialog)
  const setIcon = useDataProjectStore((s) => s.setIcon)
  const [icon, setIconState] = useState<DataProjectIcon | null>(project.icon)
  const [iconColor, setIconColor] = useState<string | null>(project.iconColor)
  const [saving, setSaving] = useState(false)
  const imageKey = useMemo(newIconUploadKey, [])
  const uploaded = useRef(false)
  const kept = useRef(false)

  useEffect(
    () => () => {
      if (uploaded.current && !kept.current) removeIconUpload(imageKey)
    },
    [imageKey]
  )

  const save = async (): Promise<void> => {
    setSaving(true)
    const ok = await setIcon(project.id, icon, iconColor)
    setSaving(false)
    if (!ok) return
    kept.current = icon?.kind === 'image' && iconFileKey(icon.fileName) === imageKey
    if (project.icon?.kind === 'image' && JSON.stringify(project.icon) !== JSON.stringify(icon)) {
      removeIconUpload(iconFileKey(project.icon.fileName))
    }
    close()
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && close()}>
      <DialogContent className="max-w-md" data-testid="data-project-icon-dialog" data-db-dialog="">
        <DialogHeader>
          <DialogTitle className="text-[15px]">Icon for {project.name}</DialogTitle>
          <DialogDescription className="text-[12px]">
            Shown in the sidebar, the pinned list and the header.
          </DialogDescription>
        </DialogHeader>
        <IconPicker
          engine={project.engine}
          icon={icon}
          iconColor={iconColor}
          onChange={(nextIcon, nextColor) => {
            setIconState(nextIcon)
            setIconColor(nextColor)
          }}
          imageKey={imageKey}
          onImageUploaded={() => {
            uploaded.current = true
          }}
        />
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={close}
            disabled={saving}
            data-testid="data-project-icon-dialog-cancel"
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => void save()}
            disabled={saving}
            data-testid="data-project-icon-dialog-save"
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
