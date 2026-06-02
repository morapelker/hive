import { useCallback } from 'react'
import { Hammer, Map, Sparkles, Send } from 'lucide-react'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { AttachmentButton } from '@/components/sessions/AttachmentButton'
import { AttachmentPreview } from '@/components/sessions/AttachmentPreview'
import type { Attachment } from '@/components/sessions/AttachmentPreview'
import { cn } from '@/lib/utils'
import { MAX_ATTACHMENTS } from '@/lib/file-attachment-utils'
import { toast } from '@/lib/toast'
import { Tip } from '@/components/ui/Tip'

type FollowUpMode = 'build' | 'plan' | 'super-plan'

interface FollowupInputProps {
  text: string
  onTextChange: (text: string) => void
  attachments: Attachment[]
  onAttach: (file: Omit<Attachment, 'id'>) => void
  onRemoveAttachment: (id: string) => void
  followUpMode: FollowUpMode
  onToggleMode: () => void
  onSend: () => void
  isSending: boolean
  placeholder: string
  testIdPrefix: string
  showInlineSendButton?: boolean
  textareaRef?: React.RefObject<HTMLTextAreaElement>
}

export function FollowupInput({
  text,
  onTextChange,
  attachments,
  onAttach,
  onRemoveAttachment,
  followUpMode,
  onToggleMode,
  onSend,
  isSending,
  placeholder,
  testIdPrefix,
  showInlineSendButton = false,
  textareaRef
}: FollowupInputProps) {
  const hasContent = text.trim().length > 0 || attachments.length > 0

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items
      if (!items) return
      for (const item of Array.from(items)) {
        if (item.type.startsWith('image/')) {
          e.preventDefault()
          const file = item.getAsFile()
          if (!file) continue
          if (attachments.length >= MAX_ATTACHMENTS) {
            toast.warning(`Maximum ${MAX_ATTACHMENTS} attachments reached`)
            return
          }
          const reader = new FileReader()
          reader.onload = () => {
            onAttach({
              kind: 'data',
              name: file.name || 'pasted-image.png',
              mime: file.type,
              dataUrl: reader.result as string
            })
          }
          reader.readAsDataURL(file)
        }
      }
    },
    [onAttach, attachments.length]
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        if (hasContent) {
          onSend()
        }
      }
    },
    [onSend, hasContent]
  )

  const handleAttachWithLimit = useCallback(
    (file: Omit<Attachment, 'id'>) => {
      if (attachments.length >= MAX_ATTACHMENTS) {
        toast.warning(`Maximum ${MAX_ATTACHMENTS} attachments reached`)
        return
      }
      onAttach(file)
    },
    [onAttach, attachments.length]
  )

  const ModeIcon = followUpMode === 'build' ? Hammer : followUpMode === 'plan' ? Map : Sparkles
  const modeLabel = followUpMode === 'build' ? 'Build' : followUpMode === 'plan' ? 'Plan' : 'Super Plan'

  return (
    <div className="space-y-1.5 flex-shrink-0">
      {/* Label row: Followup label + mode toggle */}
      <div className="flex items-center gap-2">
        <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Followup
        </label>
        <Tip tipId="super-plan-shortcut" enabled={followUpMode === 'super-plan'}>
          <button
            data-testid={`${testIdPrefix}-mode-toggle`}
            data-mode={followUpMode}
            type="button"
            onClick={onToggleMode}
            className={cn(
              'flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium transition-colors',
              'border select-none',
              followUpMode === 'build'
                ? 'bg-blue-500/10 border-blue-500/30 text-blue-500 hover:bg-blue-500/20'
                : followUpMode === 'plan'
                  ? 'bg-violet-500/10 border-violet-500/30 text-violet-500 hover:bg-violet-500/20'
                  : 'bg-orange-500/10 border-orange-500/30 text-orange-500 hover:bg-orange-500/20'
            )}
          >
            <ModeIcon className="h-3 w-3" />
            <span>{modeLabel}</span>
          </button>
        </Tip>
      </div>

      {/* Attachment previews */}
      <AttachmentPreview attachments={attachments} onRemove={onRemoveAttachment} />

      {/* Textarea row + optional inline Send button */}
      <div className="flex gap-2 items-end">
        <div className="flex-1 relative">
          <Textarea
            ref={textareaRef}
            data-testid={`${testIdPrefix}-followup-input`}
            value={text}
            onChange={(e) => onTextChange(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            rows={2}
            placeholder={placeholder}
            className="resize-y font-mono text-xs leading-relaxed pr-8"
          />
          {/* Paperclip button positioned inside the textarea area */}
          <div className="absolute right-1 bottom-1">
            <AttachmentButton
              onAttach={handleAttachWithLimit}
              disabled={isSending}
            />
          </div>
        </div>
        {showInlineSendButton && (
          <Button
            type="button"
            data-testid={`${testIdPrefix}-send-followup-btn`}
            disabled={isSending || !hasContent}
            onClick={onSend}
            size="icon"
            className="shrink-0 h-8 w-8"
          >
            <Send className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    </div>
  )
}
