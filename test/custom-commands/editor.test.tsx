import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { CustomCommandsEditor } from '../../src/renderer/src/components/custom-commands/CustomCommandsEditor'
import type { CustomProjectCommand } from '../../src/renderer/src/lib/custom-commands'

function ControlledEditor({ initial }: { initial: CustomProjectCommand[] }): React.JSX.Element {
  const [commands, setCommands] = useState(initial)
  return <CustomCommandsEditor value={commands} onChange={setCommands} />
}

describe('CustomCommandsEditor', () => {
  it('allows deleting the last command without recreating a blank row', async () => {
    const user = userEvent.setup()

    render(
      <ControlledEditor
        initial={[{ id: 'cmd-1', name: 'Run tests', prompt: 'Run tests for {{project.name}}' }]}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Delete command' }))

    await waitFor(() => {
      expect(screen.queryByPlaceholderText('Command name')).not.toBeInTheDocument()
    })
  })

  it('adds a blank command only when the user clicks add command', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()

    render(<CustomCommandsEditor value={[]} onChange={onChange} />)

    expect(onChange).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: /add command/i }))

    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({
        name: '',
        prompt: ''
      })
    ])
  })
})
