import { useRef } from 'react'
import { Paperclip } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface AttachmentButtonProps {
  onAttach: (file: { name: string; mime: string; dataUrl: string }) => void
  disabled?: boolean
}

export function AttachmentButton({ onAttach, disabled }: AttachmentButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  const handleClick = () => {
    inputRef.current?.click()
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files) return

    for (const file of Array.from(files)) {
      const reader = new FileReader()
      reader.onload = () => {
        onAttach({
          name: file.name,
          mime: file.type,
          dataUrl: reader.result as string
        })
      }
      reader.readAsDataURL(file)
    }

    // Reset input so same file can be selected again
    if (inputRef.current) {
      inputRef.current.value = ''
    }
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/*,.pdf"
        multiple
        className="hidden"
        onChange={handleFileChange}
        data-testid="attachment-file-input"
      />
      <Button
        variant="ghost"
        size="sm"
        className="h-7 w-7 p-0"
        onClick={handleClick}
        disabled={disabled}
        title="Attach image or file"
        aria-label="Attach image or file"
        data-testid="attachment-button"
      >
        <Paperclip className="h-3.5 w-3.5" />
      </Button>
    </>
  )
}
