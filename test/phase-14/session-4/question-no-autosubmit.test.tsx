import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QuestionPrompt } from '../../../src/renderer/src/components/sessions/QuestionPrompt'

describe('Session 4: Question No Auto-Submit', () => {
  const singleQuestionRequest = {
    id: 'req1',
    sessionID: 'sess1',
    questions: [
      {
        question: 'Pick one',
        header: 'Q1',
        options: [
          { label: 'A', description: 'Option A' },
          { label: 'B', description: 'Option B' }
        ]
      }
    ]
  }

  test('clicking option does NOT call onReply for single question', async () => {
    const onReply = vi.fn()
    render(
      <QuestionPrompt
        request={singleQuestionRequest}
        onReply={onReply}
        onReject={vi.fn()}
      />
    )
    await userEvent.click(screen.getByTestId('option-A'))
    expect(onReply).not.toHaveBeenCalled()
  })

  test('Submit button is visible for single question', () => {
    render(
      <QuestionPrompt
        request={singleQuestionRequest}
        onReply={vi.fn()}
        onReject={vi.fn()}
      />
    )
    expect(screen.getByText('Submit')).toBeInTheDocument()
  })

  test('Submit button disabled when no option selected', () => {
    render(
      <QuestionPrompt
        request={singleQuestionRequest}
        onReply={vi.fn()}
        onReject={vi.fn()}
      />
    )
    // The Submit button in the action bar (not the custom input Submit)
    const buttons = screen.getAllByText('Submit')
    // The action bar Submit button should be disabled
    const actionSubmit = buttons[0]
    expect(actionSubmit).toBeDisabled()
  })

  test('clicking Submit after selecting option calls onReply', async () => {
    const onReply = vi.fn()
    render(
      <QuestionPrompt
        request={singleQuestionRequest}
        onReply={onReply}
        onReject={vi.fn()}
      />
    )
    await userEvent.click(screen.getByTestId('option-A'))
    // Get the Submit button from the action bar
    const buttons = screen.getAllByText('Submit')
    await userEvent.click(buttons[0])
    expect(onReply).toHaveBeenCalledWith('req1', [['A']])
  })

  test('selecting a different option replaces previous selection', async () => {
    const onReply = vi.fn()
    render(
      <QuestionPrompt
        request={singleQuestionRequest}
        onReply={onReply}
        onReject={vi.fn()}
      />
    )
    await userEvent.click(screen.getByTestId('option-A'))
    await userEvent.click(screen.getByTestId('option-B'))
    const buttons = screen.getAllByText('Submit')
    await userEvent.click(buttons[0])
    expect(onReply).toHaveBeenCalledWith('req1', [['B']])
  })

  test('custom text input saves answer but does not auto-submit', async () => {
    const onReply = vi.fn()
    render(
      <QuestionPrompt
        request={singleQuestionRequest}
        onReply={onReply}
        onReject={vi.fn()}
      />
    )
    // Click "Type your own answer"
    await userEvent.click(screen.getByTestId('custom-option'))
    // Type custom text
    const input = screen.getByPlaceholderText('Type your answer...')
    await userEvent.type(input, 'My custom answer')
    // Submit the custom input form (not the action bar Submit)
    const formSubmit = screen.getByTestId('custom-input-form').querySelector('button[type="submit"]')!
    await userEvent.click(formSubmit)
    // Should NOT auto-submit — onReply should not be called yet
    expect(onReply).not.toHaveBeenCalled()
  })

  test('custom text saved then submitted via action bar Submit', async () => {
    const onReply = vi.fn()
    render(
      <QuestionPrompt
        request={singleQuestionRequest}
        onReply={onReply}
        onReject={vi.fn()}
      />
    )
    // Click "Type your own answer"
    await userEvent.click(screen.getByTestId('custom-option'))
    const input = screen.getByPlaceholderText('Type your answer...')
    await userEvent.type(input, 'My custom answer')
    // Submit the custom form to save the answer
    const formSubmit = screen.getByTestId('custom-input-form').querySelector('button[type="submit"]')!
    await userEvent.click(formSubmit)
    // Now click the action bar Submit
    const actionSubmit = screen.getByText('Submit')
    await userEvent.click(actionSubmit)
    expect(onReply).toHaveBeenCalledWith('req1', [['My custom answer']])
  })

  test('dismiss button calls onReject', async () => {
    const onReject = vi.fn()
    render(
      <QuestionPrompt
        request={singleQuestionRequest}
        onReply={vi.fn()}
        onReject={onReject}
      />
    )
    await userEvent.click(screen.getByText('Dismiss'))
    expect(onReject).toHaveBeenCalledWith('req1')
  })

  test('multi-question flow still auto-advances on single-choice', async () => {
    const multiRequest = {
      id: 'req2',
      sessionID: 'sess1',
      questions: [
        {
          question: 'Question 1',
          header: 'Q1',
          options: [{ label: 'X', description: '' }]
        },
        {
          question: 'Question 2',
          header: 'Q2',
          options: [{ label: 'Y', description: '' }]
        }
      ]
    }
    const onReply = vi.fn()
    render(
      <QuestionPrompt
        request={multiRequest}
        onReply={onReply}
        onReject={vi.fn()}
      />
    )
    // Click option on first question — should auto-advance
    await userEvent.click(screen.getByTestId('option-X'))
    // Should NOT call onReply (auto-advance, not submit)
    expect(onReply).not.toHaveBeenCalled()
    // After auto-advance timeout, question 2 should be visible
    await vi.waitFor(() => {
      expect(screen.getByText('Question 2')).toBeInTheDocument()
    })
  })
})
