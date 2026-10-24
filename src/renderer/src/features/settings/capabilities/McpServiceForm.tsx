import { useState } from 'react'
import { useI18n } from '../../../i18n'
import { Button, SegmentedControl, TextArea, TextField } from '../../../ui'
import type { McpSettingsMutation, McpSettingsScope, McpSettingsSnapshot } from '../../../../../shared/mcp-settings'
import { mcpServicesText } from './mcp-services-text'
import { Actions, Meta, Warn } from './parts'

export function McpServiceForm({ snapshot, initialScope, onSave, onCancel, busy }: { snapshot: McpSettingsSnapshot; initialScope: McpSettingsScope; onSave(input: McpSettingsMutation): Promise<void>; onCancel(): void; busy: boolean }) {
  const { lang } = useI18n()
  const text = mcpServicesText(lang)
  const [name, setName] = useState('')
  const [scope, setScope] = useState<McpSettingsScope>(snapshot.project && snapshot.projectTrusted ? initialScope : 'global')
  const [transport, setTransport] = useState<'local' | 'remote'>('local')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [url, setUrl] = useState('')
  const [env, setEnv] = useState('')
  const [error, setError] = useState('')
  const save = async (): Promise<void> => {
    setError('')
    let variables: Record<string, string> | undefined
    if (env.trim()) {
      try {
        const parsed: unknown = JSON.parse(env)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Object.values(parsed).every((value) => typeof value === 'string')) throw new Error()
        variables = parsed as Record<string, string>
      } catch { setError(text.envInvalid); return }
    }
    await onSave({ action: 'add', scope, context: snapshot.context, revision: snapshot.revision, name: name.trim(), config: {
      ...(transport === 'local' ? { command: command.trim(), args: args.split(/\r?\n/).filter((arg) => arg.length > 0) } : { url: url.trim() }),
      ...(variables ? { env: variables } : {})
    } })
  }
  return <div className="caps-stack mcp-service-form" data-testid="mcp-service-form">
    <TextField label={text.name} value={name} onChange={setName} isDisabled={busy} />
    <SegmentedControl label={text.scope} value={scope} onChange={setScope} isDisabled={busy} options={[
      { value: 'global', label: text.allSessions },
      ...(snapshot.project && snapshot.projectTrusted ? [{ value: 'project' as const, label: `${text.projectOnly}：${snapshot.project.name}` }] : [])
    ]} />
    <SegmentedControl label={text.transport} value={transport} onChange={setTransport} isDisabled={busy} options={[{ value: 'local', label: text.local }, { value: 'remote', label: text.remote }]} />
    {transport === 'local' ? <>
      <TextField label={text.command} value={command} onChange={setCommand} isDisabled={busy} />
      <TextArea label={text.args} value={args} onChange={setArgs} isDisabled={busy} rows={3} />
    </> : <TextField label={text.url} value={url} onChange={setUrl} isDisabled={busy} />}
    <details><summary>{text.showAdvanced}</summary><TextArea label={text.env} value={env} onChange={setEnv} isDisabled={busy} rows={3} /></details>
    <Meta>{scope === 'global' ? text.globalHint : text.projectHint}</Meta>
    {error ? <Warn>{error}</Warn> : null}
    <Actions><Button variant="primary" isDisabled={busy || !name.trim() || !(transport === 'local' ? command.trim() : url.trim())} onPress={() => void save()}>{text.save}</Button><Button isDisabled={busy} onPress={onCancel}>{text.cancel}</Button></Actions>
  </div>
}
