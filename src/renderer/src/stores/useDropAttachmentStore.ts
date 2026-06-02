import { create } from 'zustand'
import type { Attachment } from '@/components/sessions/AttachmentPreview'

interface DropAttachmentState {
  pending: Array<Omit<Attachment, 'id'>>
  push: (items: Array<Omit<Attachment, 'id'>>) => void
  consume: () => Array<Omit<Attachment, 'id'>>
}

export const useDropAttachmentStore = create<DropAttachmentState>((set, get) => ({
  pending: [],
  push: (items) => set((state) => ({ pending: [...state.pending, ...items] })),
  consume: () => {
    const current = get().pending
    set({ pending: [] })
    return current
  }
}))
