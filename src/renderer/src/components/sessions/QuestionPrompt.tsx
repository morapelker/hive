import { useState, useCallback } from 'react'
import { MessageCircleQuestion, Check, X, ChevronRight, Pencil } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import type { QuestionRequest, QuestionAnswer } from '@/stores/useQuestionStore'

interface QuestionPromptProps {
  request: QuestionRequest
  onReply: (requestId: string, answers: QuestionAnswer[]) => void
  onReject: (requestId: string) => void
}

export function QuestionPrompt({ request, onReply, onReject }: QuestionPromptProps) {
  const [currentTab, setCurrentTab] = useState(0)
  const [answers, setAnswers] = useState<QuestionAnswer[]>(request.questions.map(() => []))
  const [customInputs, setCustomInputs] = useState<string[]>(request.questions.map(() => ''))
  const [editingCustom, setEditingCustom] = useState(false)
  const [sending, setSending] = useState(false)

  const isMultiQuestion = request.questions.length > 1
  const currentQuestion = request.questions[currentTab]
  const isMultiple = currentQuestion?.multiple ?? false
  const isCustomAllowed = currentQuestion?.custom !== false
  const isLastTab = currentTab === request.questions.length - 1

  const handleSubmit = useCallback(
    (finalAnswers?: QuestionAnswer[]) => {
      if (sending) return
      setSending(true)
      onReply(request.id, finalAnswers || answers)
    },
    [sending, onReply, request.id, answers]
  )

  const handleOptionClick = useCallback(
    (label: string) => {
      if (sending) return

      if (isMultiple) {
        // Multi-choice: toggle the selection
        setAnswers((prev) => {
          const updated = [...prev]
          const current = updated[currentTab] || []
          if (current.includes(label)) {
            updated[currentTab] = current.filter((l) => l !== label)
          } else {
            updated[currentTab] = [...current, label]
          }
          return updated
        })
        return
      }

      // Single-choice: select this option (replaces previous selection)
      setAnswers((prev) => {
        const updated = [...prev]
        updated[currentTab] = [label]
        return updated
      })

      // Multi-question: auto-advance to next tab
      if (isMultiQuestion && !isLastTab) {
        setTimeout(() => {
          setCurrentTab((t) => t + 1)
          setEditingCustom(false)
        }, 150)
      }
    },
    [sending, isMultiple, isMultiQuestion, currentTab, isLastTab]
  )

  const handleCustomSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault()
      const text = customInputs[currentTab]?.trim()
      if (!text || sending) return

      // Save custom text as the selected answer (no auto-submit)
      setAnswers((prev) => {
        const updated = [...prev]
        updated[currentTab] = [text]
        return updated
      })
      setEditingCustom(false)

      // Multi-question: auto-advance
      if (isMultiQuestion && !isLastTab) {
        setCurrentTab((t) => t + 1)
      }
    },
    [customInputs, currentTab, sending, isMultiQuestion, isLastTab]
  )

  const handleCustomInputChange = useCallback(
    (value: string) => {
      setCustomInputs((prev) => {
        const updated = [...prev]
        updated[currentTab] = value
        return updated
      })
    },
    [currentTab]
  )

  const handleNext = useCallback(() => {
    if (isLastTab) {
      handleSubmit()
    } else {
      setCurrentTab((t) => t + 1)
      setEditingCustom(false)
    }
  }, [isLastTab, handleSubmit])

  const handleDismiss = useCallback(() => {
    if (sending) return
    onReject(request.id)
  }, [sending, onReject, request.id])

  const currentAnswers = answers[currentTab] || []
  const hasCurrentAnswer = currentAnswers.length > 0

  // Detect a custom answer (one not matching any predefined option label)
  const customAnswer = isCustomAllowed
    ? currentAnswers.find((a) => !currentQuestion?.options.some((o) => o.label === a))
    : undefined

  // For multi-question: check all questions have at least one answer
  const allAnswered = isMultiQuestion ? answers.every((a) => a.length > 0) : false

  if (!currentQuestion) return null

  return (
    <div
      className="rounded-md border border-border bg-zinc-900/50 overflow-hidden"
      data-testid="question-prompt"
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-muted/30">
        <MessageCircleQuestion className="h-4 w-4 text-blue-400 shrink-0" />
        {isMultiQuestion ? (
          <div className="flex gap-1 flex-1 min-w-0" data-testid="question-tabs">
            {request.questions.map((q, i) => (
              <button
                key={i}
                onClick={() => {
                  setCurrentTab(i)
                  setEditingCustom(false)
                }}
                className={cn(
                  'px-2 py-1 text-xs rounded transition-colors',
                  i === currentTab
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {q.header}
                {answers[i]?.length > 0 && (
                  <Check className="h-3 w-3 ml-1 inline text-green-500" />
                )}
              </button>
            ))}
          </div>
        ) : (
          <span className="text-sm font-medium text-foreground truncate flex-1">
            {currentQuestion.header}
          </span>
        )}
        <button
          onClick={handleDismiss}
          disabled={sending}
          className="ml-auto text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 shrink-0"
          aria-label="Dismiss"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="px-3 py-2.5">
        {/* Question text */}
        <p className="text-sm text-foreground mb-3">{currentQuestion.question}</p>

        {/* Options */}
        <div className="space-y-1.5">
          {currentQuestion.options.map((option) => {
            const isSelected = currentAnswers.includes(option.label)
            return (
              <button
                key={option.label}
                onClick={() => handleOptionClick(option.label)}
                disabled={sending}
                className={cn(
                  'w-full text-left px-3 py-2 rounded-md border transition-colors disabled:opacity-50',
                  isSelected
                    ? 'border-blue-500/50 bg-blue-500/10'
                    : 'border-border hover:border-muted-foreground/30 hover:bg-muted/50'
                )}
                data-testid={`option-${option.label}`}
              >
                <div className="flex items-center gap-2">
                  {isMultiple && (
                    <div
                      className={cn(
                        'h-4 w-4 rounded border flex items-center justify-center shrink-0',
                        isSelected ? 'bg-blue-500 border-blue-500' : 'border-muted-foreground/40'
                      )}
                    >
                      {isSelected && <Check className="h-3 w-3 text-white" />}
                    </div>
                  )}
                  <span className="text-sm font-medium">{option.label}</span>
                </div>
                {option.description && (
                  <p className={cn('text-xs text-muted-foreground mt-0.5', isMultiple && 'ml-6')}>
                    {option.description}
                  </p>
                )}
              </button>
            )
          })}

          {/* Custom answer display (when a custom answer has been entered) */}
          {isCustomAllowed && !editingCustom && customAnswer && (
            <button
              onClick={() => {
                setEditingCustom(true)
                handleCustomInputChange(customAnswer)
              }}
              disabled={sending}
              className="w-full text-left px-3 py-2 rounded-md border border-blue-500/50 bg-blue-500/10 transition-colors disabled:opacity-50"
              data-testid="custom-answer-display"
            >
              <div className="flex items-center gap-2 min-w-0">
                <Pencil className="h-3.5 w-3.5 shrink-0 text-blue-400" />
                <span className="text-sm font-medium truncate">{customAnswer}</span>
              </div>
            </button>
          )}

          {/* Custom text option (when no custom answer yet) */}
          {isCustomAllowed && !editingCustom && !customAnswer && (
            <button
              onClick={() => setEditingCustom(true)}
              disabled={sending}
              className="w-full text-left px-3 py-2 rounded-md border border-dashed border-border hover:border-muted-foreground/30 hover:bg-muted/50 transition-colors disabled:opacity-50"
              data-testid="custom-option"
            >
              <div className="flex items-center gap-2 text-muted-foreground">
                <Pencil className="h-3.5 w-3.5 shrink-0" />
                <span className="text-sm">Type your own answer</span>
              </div>
            </button>
          )}

          {/* Custom text input form */}
          {editingCustom && (
            <form
              onSubmit={handleCustomSubmit}
              className="flex gap-2"
              data-testid="custom-input-form"
            >
              <input
                autoFocus
                value={customInputs[currentTab] || ''}
                onChange={(e) => handleCustomInputChange(e.target.value)}
                className="flex-1 bg-background border border-border rounded px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500/50 transition-colors"
                placeholder="Type your answer..."
                disabled={sending}
              />
              <Button
                size="sm"
                type="submit"
                disabled={!customInputs[currentTab]?.trim() || sending}
              >
                Submit
              </Button>
              <Button
                size="sm"
                variant="ghost"
                type="button"
                onClick={() => setEditingCustom(false)}
                disabled={sending}
              >
                Cancel
              </Button>
            </form>
          )}
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2 mt-3 pt-2 border-t border-border/50">
          {/* Single-question submit */}
          {!isMultiQuestion && (
            <Button
              size="sm"
              onClick={() => handleSubmit()}
              disabled={!hasCurrentAnswer || sending}
            >
              {sending ? 'Sending...' : 'Submit'}
            </Button>
          )}

          {/* Multi-question navigation */}
          {isMultiQuestion && (
            <>
              {currentTab > 0 && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setCurrentTab((t) => t - 1)
                    setEditingCustom(false)
                  }}
                  disabled={sending}
                >
                  Back
                </Button>
              )}
              <Button
                size="sm"
                onClick={handleNext}
                disabled={
                  (isLastTab && !allAnswered) || (!isLastTab && !hasCurrentAnswer) || sending
                }
              >
                {sending ? (
                  'Sending...'
                ) : isLastTab ? (
                  'Submit All'
                ) : (
                  <>
                    Next
                    <ChevronRight className="h-3.5 w-3.5" />
                  </>
                )}
              </Button>
            </>
          )}

          {/* Dismiss button */}
          <Button
            size="sm"
            variant="ghost"
            onClick={handleDismiss}
            disabled={sending}
            className="text-muted-foreground"
          >
            Dismiss
          </Button>
        </div>
      </div>
    </div>
  )
}
