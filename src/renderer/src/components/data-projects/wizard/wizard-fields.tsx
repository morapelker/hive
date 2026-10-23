// Small form building blocks for the data project wizard and its dialogs: labelled field with
// error/hint lines (aria-invalid + aria-describedby wired), password input with show/hide and the
// edit-mode "•••• saved · Replace · Clear" state, file path input with a native Browse… picker,
// a native select and a compact segmented control. Plain controlled components, house styling.

import { useState } from 'react'
import { Eye, EyeOff, FolderOpen, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { dataProjectsApi } from '@/api/data-projects-api'
import { toast } from '@/lib/toast'
import type { SecretMode } from './wizard-model'

// ---------------------------------------------------------------------------------------------
// Field
// ---------------------------------------------------------------------------------------------

export interface FieldProps {
  label: string
  htmlFor?: string
  error?: string
  hint?: React.ReactNode
  optional?: boolean
  className?: string
  children: React.ReactNode
}

export function Field({
  label,
  htmlFor,
  error,
  hint,
  optional,
  className,
  children
}: FieldProps): React.JSX.Element {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)}>
      <label htmlFor={htmlFor} className="text-[12px] font-medium text-foreground">
        {label}
        {optional && <span className="ml-1 font-normal text-muted-foreground">(optional)</span>}
      </label>
      {children}
      {error ? (
        <p
          id={htmlFor ? `${htmlFor}-error` : undefined}
          className="text-[11px] text-destructive"
          role="alert"
        >
          {error}
        </p>
      ) : hint ? (
        <p
          id={htmlFor ? `${htmlFor}-hint` : undefined}
          className="text-[11px] text-muted-foreground"
        >
          {hint}
        </p>
      ) : null}
    </div>
  )
}

/** aria props for an input inside <Field htmlFor={id} error={error}>. */
export const invalidProps = (
  id: string,
  error: string | undefined
): { 'aria-invalid'?: true; 'aria-describedby'?: string } =>
  error ? { 'aria-invalid': true, 'aria-describedby': `${id}-error` } : {}

export function SectionTitle({
  children,
  className
}: {
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <h4
      className={cn(
        'text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground',
        className
      )}
    >
      {children}
    </h4>
  )
}

// ---------------------------------------------------------------------------------------------
// Native select (forms: research codebase-ui §1.1 allows a styled native <select>)
// ---------------------------------------------------------------------------------------------

export interface SelectOption<T extends string> {
  value: T
  label: string
}

export function NativeSelect<T extends string>({
  id,
  value,
  options,
  onChange,
  testId,
  disabled,
  className
}: {
  id?: string
  value: T
  options: ReadonlyArray<SelectOption<T>>
  onChange: (value: T) => void
  testId?: string
  disabled?: boolean
  className?: string
}): React.JSX.Element {
  return (
    <select
      id={id}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as T)}
      className={cn(
        'h-8 w-full rounded-md border border-input bg-transparent px-2 text-[13px] tracking-[0.01em] focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:border-ring disabled:opacity-64 dark:bg-input/30',
        className
      )}
      data-testid={testId}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
}

// ---------------------------------------------------------------------------------------------
// Segmented control
// ---------------------------------------------------------------------------------------------

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  testId,
  ariaLabel
}: {
  value: T
  options: ReadonlyArray<SelectOption<T>>
  onChange: (value: T) => void
  testId?: string
  ariaLabel: string
}): React.JSX.Element {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="inline-flex h-8 items-center rounded-[8px] bg-secondary p-0.5"
      data-testid={testId}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            'h-full rounded-[6px] px-2.5 text-[12px] font-medium transition-colors',
            value === option.value
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          )}
          data-testid={testId ? `${testId}-${option.value}` : undefined}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Secret input
// ---------------------------------------------------------------------------------------------

export interface SecretInputProps {
  id: string
  value: string
  onChange: (value: string) => void
  mode: SecretMode
  onModeChange: (mode: SecretMode) => void
  /** Something is stored server-side (edit mode): show "saved" with Replace / Clear. */
  hasSaved: boolean
  placeholder?: string
  testId: string
  error?: string
  autoFocus?: boolean
}

/**
 * Password-style input. In edit mode with a stored secret it starts as "•••• saved": the secret
 * itself is never fetched; Replace switches to an empty input, Clear marks it for deletion.
 */
export function SecretInput({
  id,
  value,
  onChange,
  mode,
  onModeChange,
  hasSaved,
  placeholder,
  testId,
  error,
  autoFocus
}: SecretInputProps): React.JSX.Element {
  const [visible, setVisible] = useState(false)

  if (hasSaved && mode !== 'replace') {
    return (
      <div className="flex h-8 items-center gap-2" data-testid={`${testId}-saved`}>
        <span
          className={cn(
            'flex h-8 min-w-0 flex-1 items-center rounded-md border border-dashed border-input px-2.5 text-[13px]',
            mode === 'clear' ? 'text-destructive line-through' : 'text-muted-foreground'
          )}
        >
          {mode === 'clear' ? 'Will be removed' : '•••••••• saved'}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            onChange('')
            onModeChange('replace')
          }}
          data-testid={`${testId}-replace`}
        >
          Replace
        </Button>
        {mode === 'clear' ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onModeChange('keep')}
            data-testid={`${testId}-keep`}
          >
            Keep
          </Button>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
            onClick={() => onModeChange('clear')}
            data-testid={`${testId}-clear`}
          >
            Clear
          </Button>
        )}
      </div>
    )
  }

  return (
    <div className="flex items-center gap-1.5">
      <div className="relative min-w-0 flex-1">
        <Input
          id={id}
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          autoFocus={autoFocus}
          className="pr-8"
          data-testid={testId}
          {...invalidProps(id, error)}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          className="absolute right-1.5 top-1/2 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:text-foreground"
          aria-label={visible ? 'Hide' : 'Show'}
          aria-pressed={visible}
          data-testid={`${testId}-toggle-visibility`}
        >
          {visible ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
        </button>
      </div>
      {hasSaved && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            onChange('')
            onModeChange('keep')
          }}
          data-testid={`${testId}-cancel-replace`}
        >
          Keep saved
        </Button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// File path input
// ---------------------------------------------------------------------------------------------

export interface FilePathInputProps {
  id: string
  value: string
  /** `isNew`: the path came from "New file…" (a save dialog), so nothing exists there yet. */
  onChange: (value: string, meta?: { isNew: boolean }) => void
  purpose: 'sqlite' | 'certificate' | 'ssh-key'
  placeholder?: string
  testId: string
  error?: string
  /** Extra button ("Create new database file") next to Browse. */
  allowCreate?: boolean
}

export function FilePathInput({
  id,
  value,
  onChange,
  purpose,
  placeholder,
  testId,
  error,
  allowCreate
}: FilePathInputProps): React.JSX.Element {
  const [picking, setPicking] = useState<'open' | 'create' | null>(null)

  const pick = async (create: boolean): Promise<void> => {
    if (picking) return
    setPicking(create ? 'create' : 'open')
    try {
      const { filePath } = await dataProjectsApi.pickFile(purpose, create || undefined)
      if (filePath) onChange(filePath, { isNew: create })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not open the file dialog')
    } finally {
      setPicking(null)
    }
  }

  return (
    <div className="flex items-center gap-1.5">
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        className="min-w-0 flex-1 font-mono text-[12px]"
        data-testid={testId}
        {...invalidProps(id, error)}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => void pick(false)}
        disabled={picking !== null}
        data-testid={`${testId}-browse`}
      >
        {picking === 'open' ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <FolderOpen className="size-3.5" />
        )}
        Browse…
      </Button>
      {allowCreate && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void pick(true)}
          disabled={picking !== null}
          data-testid={`${testId}-create`}
        >
          {picking === 'create' && <Loader2 className="size-3.5 animate-spin" />}
          New file…
        </Button>
      )}
    </div>
  )
}
