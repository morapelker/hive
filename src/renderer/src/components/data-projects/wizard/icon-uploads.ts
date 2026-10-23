// Uploaded data project icons live in ~/.hive/project-icons as `<key>.<ext>` (the git projects'
// pipeline: projectApi.pickProjectIcon / removeProjectIcon / getProjectIconPath). The wizard and
// the change-icon dialog upload under a fresh key per session, so cancelling never touches the
// icon a project already has; whatever ends up unreferenced is deleted again.

import { projectApi } from '@/api/project-api'

/** `<key>.<ext>` → `<key>` (what removeProjectIcon takes). */
export const iconFileKey = (fileName: string): string => fileName.replace(/\.[^.]+$/, '')

/** A fresh upload key for one wizard / dialog session. */
export const newIconUploadKey = (): string =>
  `dp-${
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
  }`

/** Deletes an uploaded icon file; best effort (a leftover file is harmless). */
export function removeIconUpload(key: string): void {
  projectApi.removeProjectIcon(key).catch(() => {})
}
