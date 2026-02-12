import { Check } from 'lucide-react'
import type { ToolViewProps } from './types'

interface QuestionOption {
  label: string
  description: string
}

interface QuestionInfo {
  question: string
  header: string
  options: QuestionOption[]
  multiple?: boolean
}

interface QuestionInput {
  questions: QuestionInfo[]
}

/** Parse the output string into a map of question → answer(s) */
function parseAnswers(output: string): Map<string, string> {
  const map = new Map<string, string>()
  // Format: "question1"="answer1", "question2"="answer2"
  const regex = /"([^"]+)"="([^"]+)"/g
  let match
  while ((match = regex.exec(output)) !== null) {
    map.set(match[1], match[2])
  }
  return map
}

export function QuestionToolView({ input, output, error }: ToolViewProps) {
  const questionInput = input as unknown as QuestionInput
  const questions = questionInput?.questions || []
  const answerMap = output ? parseAnswers(output) : new Map<string, string>()

  return (
    <div data-testid="question-tool-view">
      {/* Error */}
      {error && (
        <div className="mb-2">
          <div className="text-red-400 font-mono text-xs whitespace-pre-wrap break-all bg-red-500/10 rounded p-2">
            {error}
          </div>
        </div>
      )}

      {/* Questions + Answers */}
      <div className="space-y-2.5">
        {questions.map((q, i) => {
          const answer = answerMap.get(q.question)
          const answerLabels = answer ? answer.split(', ') : []

          return (
            <div key={i}>
              {/* Question header */}
              <div className="flex items-center gap-1.5 mb-1">
                <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                  {q.header}
                </span>
                {answer && <Check className="h-3 w-3 text-green-500 shrink-0" />}
              </div>

              {/* Question text */}
              <p className="text-xs text-muted-foreground mb-1.5">{q.question}</p>

              {/* Options as compact pills */}
              <div className="flex flex-wrap gap-1">
                {q.options.map((opt) => {
                  const isSelected = answerLabels.includes(opt.label)
                  return (
                    <span
                      key={opt.label}
                      className={
                        isSelected
                          ? 'inline-flex items-center gap-1 text-[11px] rounded-md px-2 py-0.5 bg-blue-500/15 text-blue-400 font-medium'
                          : 'inline-flex items-center gap-1 text-[11px] rounded-md px-2 py-0.5 bg-muted/50 text-muted-foreground'
                      }
                    >
                      {isSelected && <Check className="h-2.5 w-2.5" />}
                      {opt.label}
                    </span>
                  )
                })}
                {/* Show custom answer if it doesn't match any option */}
                {answer && answerLabels.some((a) => !q.options.find((o) => o.label === a)) && (
                  <span className="inline-flex items-center gap-1 text-[11px] rounded-md px-2 py-0.5 bg-blue-500/15 text-blue-400 font-medium">
                    <Check className="h-2.5 w-2.5" />
                    {answerLabels.find((a) => !q.options.find((o) => o.label === a))}
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Fallback if no questions parsed */}
      {questions.length === 0 && output && (
        <pre className="text-xs font-mono text-muted-foreground bg-muted/50 rounded p-2 whitespace-pre-wrap break-words">
          {output}
        </pre>
      )}
    </div>
  )
}
