import type { ReactElement } from 'react'
import { useStore } from '../../../state/store'
import { Button } from '../../../ui'
import { useCapsText } from './text'
import { Empty, Entry, Group, Panel } from './parts'
import { promptCommands } from './model'

export function PromptsSection(): ReactElement {
  const text = useCapsText()
  const commands = useStore((s) => s.commands)
  const hasSession = useStore((s) => !!s.session?.sessionId)
  const reloadCommands = useStore((s) => s.reloadCommands)
  const prompts = promptCommands(commands)

  return (
    <Panel label={text('prompts')}>
      <Group
        title={text('prompts')}
        desc={text('promptsHiddenHint')}
        settingId="caps-prompts"
        actions={
          <Button
            variant="secondary"
            isDisabled={!hasSession}
            onPress={() => void reloadCommands()}
            data-testid="caps-prompts-reload"
          >
            {text('sectionReload')}
          </Button>
        }
      >
        {!hasSession ? (
          <Empty>{text('promptsNoSession')}</Empty>
        ) : prompts.length === 0 ? (
          <Empty>{text('promptsEmpty')}</Empty>
        ) : (
          <div className="caps-list" data-testid="caps-prompts-list">
            {prompts.map((command) => {
              const metaParts = [
                command.hiddenInMenu ? text('promptHiddenTag') : null,
                command.availability,
                command.usage,
                command.description,
                command.location
              ]
              return (
                <Entry
                  key={`${command.module ?? ''}:${command.name}`}
                  testId="caps-prompt"
                  name={`/${command.name}`}
                  meta={metaParts}
                />
              )
            })}
          </div>
        )}
      </Group>
    </Panel>
  )
}
