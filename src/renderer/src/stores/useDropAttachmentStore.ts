import { create } from 'zustand'
import type { AttachmentInput } from '@/components/sessions/AttachmentPreview'

interface DropAttachmentState {
  pending: AttachmentInput[]
  push: (items: AttachmentInput[]) => void
  consume: () => AttachmentInput[]
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
