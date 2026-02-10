import { describe, test, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { QuestionPrompt } from '@/components/sessions/QuestionPrompt'
import type { QuestionRequest } from '@/stores/useQuestionStore'

describe('Session 2: QuestionPrompt UI', () => {
  const singleQuestion: QuestionRequest = {
    id: 'q1',
    sessionID: 's1',
    questions: [
      {
        question: 'Which framework?',
        header: 'Framework',
        options: [
          { label: 'React', description: 'Component-based UI' },
          { label: 'Vue', description: 'Progressive framework' }
        ]
      }
    ]
  }

  const multiChoiceRequest: QuestionRequest = {
    id: 'q2',
    sessionID: 's1',
    questions: [
      {
        question: 'Which frameworks do you want?',
        header: 'Frameworks',
        options: [
          { label: 'React', description: 'Component-based UI' },
          { label: 'Vue', description: 'Progressive framework' },
          { label: 'Svelte', description: 'Compiler-based' }
        ],
        multiple: true
      }
    ]
  }

  const multiQuestionRequest: QuestionRequest = {
    id: 'q3',
    sessionID: 's1',
    questions: [
      {
        question: 'Which framework?',
        header: 'Framework',
        options: [
          { label: 'React', description: 'Component-based UI' },
          { label: 'Vue', description: 'Progressive framework' }
        ]
      },
      {
        question: 'Which bundler?',
        header: 'Bundler',
        options: [
          { label: 'Vite', description: 'Fast dev server' },
          { label: 'Webpack', description: 'Established bundler' }
        ]
      }
    ]
  }

  const noOptionsRequest: QuestionRequest = {
    id: 'q4',
    sessionID: 's1',
    questions: [
      {
        question: 'What is the project name?',
        header: 'Project',
        options: []
      }
    ]
  }

  const noCustomRequest: QuestionRequest = {
    id: 'q5',
    sessionID: 's1',
    questions: [
      {
        question: 'Pick one:',
        header: 'Choice',
        options: [
          { label: 'A', description: 'Option A' },
          { label: 'B', description: 'Option B' }
        ],
        custom: false
      }
    ]
  }

  describe('rendering', () => {
    test('renders question text and options', () => {
      render(<QuestionPrompt request={singleQuestion} onReply={vi.fn()} onReject={vi.fn()} />)
      expect(screen.getByText('Which framework?')).toBeInTheDocument()
      expect(screen.getByText('React')).toBeInTheDocument()
      expect(screen.getByText('Vue')).toBeInTheDocument()
      expect(screen.getByText('Component-based UI')).toBeInTheDocument()
      expect(screen.getByText('Progressive framework')).toBeInTheDocument()
    })

    test('renders header with question icon and dismiss button', () => {
      render(<QuestionPrompt request={singleQuestion} onReply={vi.fn()} onReject={vi.fn()} />)
      // Header contains the MessageCircleQuestion icon and dismiss X button
      expect(screen.getByLabelText('Dismiss')).toBeInTheDocument()
      expect(screen.getByTestId('question-prompt')).toBeInTheDocument()
    })

    test('renders "Type your own answer" when custom is allowed (default)', () => {
      render(<QuestionPrompt request={singleQuestion} onReply={vi.fn()} onReject={vi.fn()} />)
      expect(screen.getByText(/type your own/i)).toBeInTheDocument()
    })

    test('does not render "Type your own answer" when custom is false', () => {
      render(<QuestionPrompt request={noCustomRequest} onReply={vi.fn()} onReject={vi.fn()} />)
      expect(screen.queryByText(/type your own/i)).not.toBeInTheDocument()
    })

    test('renders with empty options array gracefully (shows only custom input)', () => {
      render(<QuestionPrompt request={noOptionsRequest} onReply={vi.fn()} onReject={vi.fn()} />)
      expect(screen.getByText('What is the project name?')).toBeInTheDocument()
      expect(screen.getByText(/type your own/i)).toBeInTheDocument()
    })
  })

  describe('single-choice behavior', () => {
    test('auto-submits on click', () => {
      const onReply = vi.fn()
      render(<QuestionPrompt request={singleQuestion} onReply={onReply} onReject={vi.fn()} />)
      fireEvent.click(screen.getByText('React'))
      expect(onReply).toHaveBeenCalledWith('q1', [['React']])
    })

    test('does not show submit button for single-choice single-question', () => {
      render(<QuestionPrompt request={singleQuestion} onReply={vi.fn()} onReject={vi.fn()} />)
      // No "Submit" button in the action buttons area (only Dismiss)
      const buttons = screen.getAllByRole('button')
      const submitButton = buttons.find((b) => b.textContent === 'Submit' && !b.closest('form'))
      expect(submitButton).toBeUndefined()
    })
  })

  describe('multi-choice behavior', () => {
    test('allows toggling options with checkmarks', () => {
      render(<QuestionPrompt request={multiChoiceRequest} onReply={vi.fn()} onReject={vi.fn()} />)
      fireEvent.click(screen.getByText('React'))
      fireEvent.click(screen.getByText('Vue'))

      // Both should be visually selected (blue border)
      const reactOption = screen.getByTestId('option-React')
      const vueOption = screen.getByTestId('option-Vue')
      expect(reactOption.className).toContain('border-blue-500')
      expect(vueOption.className).toContain('border-blue-500')
    })

    test('can toggle off a selection', () => {
      render(<QuestionPrompt request={multiChoiceRequest} onReply={vi.fn()} onReject={vi.fn()} />)
      fireEvent.click(screen.getByText('React'))
      fireEvent.click(screen.getByText('React')) // toggle off

      const reactOption = screen.getByTestId('option-React')
      expect(reactOption.className).not.toContain('bg-blue-500/10')
    })

    test('submit sends all selected labels', () => {
      const onReply = vi.fn()
      render(<QuestionPrompt request={multiChoiceRequest} onReply={onReply} onReject={vi.fn()} />)
      fireEvent.click(screen.getByText('React'))
      fireEvent.click(screen.getByText('Vue'))
      fireEvent.click(screen.getByText(/^submit$/i))
      expect(onReply).toHaveBeenCalledWith('q2', [['React', 'Vue']])
    })

    test('submit button disabled when no selections', () => {
      render(<QuestionPrompt request={multiChoiceRequest} onReply={vi.fn()} onReject={vi.fn()} />)
      const submitButton = screen.getByRole('button', { name: /^submit$/i })
      expect(submitButton).toBeDisabled()
    })
  })

  describe('custom text input', () => {
    test('shows input form when clicking "Type your own answer"', () => {
      render(<QuestionPrompt request={singleQuestion} onReply={vi.fn()} onReject={vi.fn()} />)
      fireEvent.click(screen.getByText(/type your own/i))
      expect(screen.getByPlaceholderText(/type your answer/i)).toBeInTheDocument()
    })

    test('custom text input works for single question', () => {
      const onReply = vi.fn()
      render(<QuestionPrompt request={singleQuestion} onReply={onReply} onReject={vi.fn()} />)
      fireEvent.click(screen.getByText(/type your own/i))
      const input = screen.getByPlaceholderText(/type your answer/i)
      fireEvent.change(input, { target: { value: 'Svelte' } })
      fireEvent.submit(input.closest('form')!)
      expect(onReply).toHaveBeenCalledWith('q1', [['Svelte']])
    })

    test('submit disabled when custom input is empty', () => {
      render(<QuestionPrompt request={singleQuestion} onReply={vi.fn()} onReject={vi.fn()} />)
      fireEvent.click(screen.getByText(/type your own/i))
      const form = screen.getByTestId('custom-input-form')
      const submitButton = form.querySelector('button[type="submit"]')
      expect(submitButton).toBeDisabled()
    })

    test('cancel hides custom input form', () => {
      render(<QuestionPrompt request={singleQuestion} onReply={vi.fn()} onReject={vi.fn()} />)
      fireEvent.click(screen.getByText(/type your own/i))
      expect(screen.getByPlaceholderText(/type your answer/i)).toBeInTheDocument()
      fireEvent.click(screen.getByText('Cancel'))
      expect(screen.queryByPlaceholderText(/type your answer/i)).not.toBeInTheDocument()
    })
  })

  describe('dismiss', () => {
    test('dismiss button calls onReject', () => {
      const onReject = vi.fn()
      render(<QuestionPrompt request={singleQuestion} onReply={vi.fn()} onReject={onReject} />)
      fireEvent.click(screen.getByText(/dismiss/i))
      expect(onReject).toHaveBeenCalledWith('q1')
    })

    test('X button in header calls onReject', () => {
      const onReject = vi.fn()
      render(<QuestionPrompt request={singleQuestion} onReply={vi.fn()} onReject={onReject} />)
      fireEvent.click(screen.getByLabelText('Dismiss'))
      expect(onReject).toHaveBeenCalledWith('q1')
    })
  })

  describe('multi-question tabs', () => {
    test('renders tabs for multi-question request', () => {
      render(<QuestionPrompt request={multiQuestionRequest} onReply={vi.fn()} onReject={vi.fn()} />)
      expect(screen.getByTestId('question-tabs')).toBeInTheDocument()
      expect(screen.getByText('Framework')).toBeInTheDocument()
      expect(screen.getByText('Bundler')).toBeInTheDocument()
    })

    test('shows first question by default', () => {
      render(<QuestionPrompt request={multiQuestionRequest} onReply={vi.fn()} onReject={vi.fn()} />)
      expect(screen.getByText('Which framework?')).toBeInTheDocument()
    })

    test('selecting option and clicking Next advances to next question', () => {
      render(<QuestionPrompt request={multiQuestionRequest} onReply={vi.fn()} onReject={vi.fn()} />)
      // Select option on first question
      fireEvent.click(screen.getByText('React'))
      // Click Next
      fireEvent.click(screen.getByText(/next/i))
      // Now should show second question
      expect(screen.getByText('Which bundler?')).toBeInTheDocument()
    })

    test('clicking tab directly switches question', () => {
      render(<QuestionPrompt request={multiQuestionRequest} onReply={vi.fn()} onReject={vi.fn()} />)
      fireEvent.click(screen.getByText('Bundler'))
      expect(screen.getByText('Which bundler?')).toBeInTheDocument()
    })

    test('Submit All sends all answers', () => {
      const onReply = vi.fn()
      render(<QuestionPrompt request={multiQuestionRequest} onReply={onReply} onReject={vi.fn()} />)
      // Answer first question
      fireEvent.click(screen.getByText('React'))
      fireEvent.click(screen.getByText(/next/i))

      // Answer second question
      fireEvent.click(screen.getByText('Vite'))
      fireEvent.click(screen.getByText(/submit all/i))

      expect(onReply).toHaveBeenCalledWith('q3', [['React'], ['Vite']])
    })

    test('Submit All button disabled until all questions answered', () => {
      render(<QuestionPrompt request={multiQuestionRequest} onReply={vi.fn()} onReject={vi.fn()} />)
      // Answer first question and go to last tab
      fireEvent.click(screen.getByText('React'))
      fireEvent.click(screen.getByText(/next/i))

      // Now on last tab but second question not answered yet
      const submitAll = screen.getByText(/submit all/i).closest('button')
      expect(submitAll).toBeDisabled()
    })

    test('Back button goes to previous question', () => {
      render(<QuestionPrompt request={multiQuestionRequest} onReply={vi.fn()} onReject={vi.fn()} />)
      // Go to second question
      fireEvent.click(screen.getByText('React'))
      fireEvent.click(screen.getByText(/next/i))
      expect(screen.getByText('Which bundler?')).toBeInTheDocument()

      // Go back
      fireEvent.click(screen.getByText('Back'))
      expect(screen.getByText('Which framework?')).toBeInTheDocument()
    })
  })

  describe('sending state', () => {
    test('auto-submit calls onReply exactly once', () => {
      const onReply = vi.fn()
      render(<QuestionPrompt request={singleQuestion} onReply={onReply} onReject={vi.fn()} />)
      fireEvent.click(screen.getByText('React'))
      expect(onReply).toHaveBeenCalledTimes(1)
    })
  })
})
