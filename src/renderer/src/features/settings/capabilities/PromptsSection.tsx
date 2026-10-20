import type { ReactElement } from 'react'
import { useStore } from '../../../state/store'
import { Badge, Button } from '../../../ui'
import { useCapsText } from './text'
import { Empty, Group, Item, ItemHead, Meta, Panel } from './parts'
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
            {prompts.map((command) => (
              <Item key={`${command.module ?? ''}:${command.name}`} testId="caps-prompt">
                <ItemHead>
                  <span className="caps-name">/{command.name}</span>
                  {command.usage ? <Badge>{command.usage}</Badge> : null}
                  {command.hiddenInMenu ? <Badge>{text('promptHiddenTag')}</Badge> : null}
                  <span className="caps-spacer" />
                </ItemHead>
                {command.description ? <Meta>{command.description}</Meta> : null}
                {command.location ? <Meta title={command.location}>{command.location}</Meta> : null}
                {command.availability ? <Meta>{command.availability}</Meta> : null}
              </Item>
            ))}
          </div>
        )}
      </Group>
    </Panel>
  )
}
