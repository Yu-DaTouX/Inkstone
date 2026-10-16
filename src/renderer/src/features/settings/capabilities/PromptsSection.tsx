/**
 * 「提示词」分页（S2）。
 *
 * 提示词没有独立的设置 / 安装接口，只能读当前 pi 会话的命令注册表
 *（`yan:listCommands`，store 的 `commands`）。这里如实只读展示：
 *   · 未连接会话 → 明说需要会话，而不是「没有提示词」；
 *   · 已连接但注册表里没有 prompt 来源 → 空态说明；
 *   · `hiddenInMenu` 的条目照常列出（它们是注册表的一部分，只是不出现在补全菜单，
 *     不是停用）。
 */
import type { ReactElement } from 'react'
import { useStore } from '../../../state/store'
import { Button } from '../../../ui'
import { useCapsText } from './text'
import { Empty, Group, Item, ItemHead, Meta, Note, Panel } from './parts'
import { promptCommands } from './model'

export function PromptsSection(): ReactElement {
  const text = useCapsText()
  const commands = useStore((s) => s.commands)
  const hasSession = useStore((s) => !!s.session?.sessionId)
  const reloadCommands = useStore((s) => s.reloadCommands)
  const prompts = promptCommands(commands)

  return (
    <Panel label={text('prompts')}>
      <Note>{text('promptsNote')}</Note>
      <Note>{text('promptsReadonly')}</Note>
      <Note>{text('promptsHiddenHint')}</Note>

      <Group
        title={text('prompts')}
        actions={
          <Button
            size="sm"
            variant="ghost"
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
                  {command.usage ? <span className="caps-tag">{command.usage}</span> : null}
                  {command.hiddenInMenu ? <span className="caps-tag">{text('promptHiddenTag')}</span> : null}
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
