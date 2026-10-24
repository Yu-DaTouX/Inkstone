import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import type { PromptTemplateDirectories } from '../../../../../shared/ipc'
import { useStore } from '../../../state/store'
import { Button } from '../../../ui'
import { useCapsText } from './text'
import { Empty, Entry, Group, Meta, Panel, Warn } from './parts'
import { promptCommands } from './model'
import { PromptTemplateForm } from './PromptTemplateForm'

export function PromptsSection(): ReactElement {
  const text = useCapsText()
  const commands = useStore((s) => s.commands)
  const sessionId = useStore((s) => s.session?.sessionId)
  const cwd = useStore((s) => s.session?.cwd)
  const runnerId = useStore((s) => s.activeRunnerId)
  const reloadCommands = useStore((s) => s.reloadCommands)
  const prompts = promptCommands(commands)
  const [directories, setDirectories] = useState<PromptTemplateDirectories | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [opening, setOpening] = useState('')
  const [creating, setCreating] = useState(false)
  const generation = useRef(0)

  const readDirectories = useCallback(async (): Promise<void> => {
    const request = ++generation.current
    setDirectories(null)
    setError(null)
    setOpening('')
    try {
      const next = await window.yan.capabilities.promptDirectories()
      if (request === generation.current) setDirectories(next)
    } catch (cause) {
      if (request === generation.current) setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  useEffect(() => {
    setCreating(false)
    void readDirectories()
    return () => {
      generation.current++
    }
  }, [readDirectories, runnerId, sessionId, cwd])

  const openDirectory = async (path: string): Promise<void> => {
    const request = generation.current
    setError(null)
    setOpening(path)
    try {
      const result = await window.yan.capabilities.openPromptDirectory(path)
      if (request === generation.current && !result.ok) setError(result.error ?? text('promptOpenFailed'))
    } catch (cause) {
      if (request === generation.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (request === generation.current) setOpening('')
    }
  }

  return (
    <Panel label={text('prompts')}>
      <Group
        title={text('prompts')}
        desc={text('promptsHiddenHint')}
        settingId="caps-prompts"
        actions={
          <>
            <Button
              variant="primary"
              isDisabled={!!opening}
              onPress={() => setCreating(true)}
              data-testid="caps-prompts-create"
            >
              {text('promptCreate')}
            </Button>
            <Button
              variant="secondary"
              isDisabled={!!opening}
              onPress={() => void Promise.all([reloadCommands(), readDirectories()])}
              data-testid="caps-prompts-reload"
            >
              {text('promptsRefresh')}
            </Button>
          </>
        }
      >
        {error ? <Warn>{error}</Warn> : null}
        {directories ? (
          <div className="caps-list" data-testid="caps-prompt-directories">
            {(['user', 'project'] as const).map((scope) => {
              const path = directories[scope]
              return path ? (
                <Entry
                  key={scope}
                  name={text(scope === 'user' ? 'promptUserDirectory' : 'promptProjectDirectory')}
                  actions={
                    <Button
                      variant="secondary"
                      isPending={opening === path}
                      isDisabled={!!opening}
                      onPress={() => void openDirectory(path)}
                      data-testid={`caps-prompts-open-${scope}`}
                    >
                      {text('promptOpenDirectory')}
                    </Button>
                  }
                >
                  <Meta title={path}>{path}</Meta>
                </Entry>
              ) : null
            })}
          </div>
        ) : null}
        {!sessionId ? (
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
      {creating ? (
        <PromptTemplateForm
          key={`${runnerId ?? ''}:${sessionId ?? ''}`}
          runnerId={runnerId}
          sessionId={sessionId}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false)
            void readDirectories()
          }}
        />
      ) : null}
    </Panel>
  )
}
