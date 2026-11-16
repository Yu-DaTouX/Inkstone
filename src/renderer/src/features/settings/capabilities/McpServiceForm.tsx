import { useState } from 'react'
import { useI18n } from '../../../i18n'
import { Button, SegmentedControl, TextArea, TextField } from '../../../ui'
import type { McpSettingsMutation, McpSettingsScope, McpSettingsSnapshot } from '../../../../../shared/mcp-settings'
import { mcpServicesText } from './mcp-services-text'
import { Actions, Meta, Warn } from './parts'
import { SettingsAdvanced } from '../root/controls'

export function McpServiceForm({ snapshot, initialScope, onSave, onCancel, busy }: { snapshot: McpSettingsSnapshot; initialScope: McpSettingsScope; onSave(input: McpSettingsMutation): Promise<void>; onCancel(): void; busy: boolean }) {
  const { lang } = useI18n()
  const text = mcpServicesText(lang)
  const [name, setName] = useState('')
  const [scope, setScope] = useState<McpSettingsScope>(snapshot.project && snapshot.projectTrusted ? initialScope : 'global')
  const [transport, setTransport] = useState<'local' | 'remote'>('local')
  const [owner, setOwner] = useState<'pi' | 'inkstone'>('pi')
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
    await onSave({ action: 'add', scope, context: snapshot.context, revision: snapshot.revision, name: name.trim(), owner, config: {
      ...(transport === 'local' ? { command: command.trim(), args: args.split(/\r?\n/).filter((arg) => arg.length > 0) } : { url: url.trim() }),
      ...(variables ? { env: variables } : {})
    } })
  }
  return <div className="caps-stack mcp-service-form" data-testid="mcp-service-form">
    <TextField label={text.name} value={name} onChange={setName} isDisabled={busy} />
    {snapshot.project && snapshot.projectTrusted ? <SegmentedControl showLabel label={text.scope} value={scope} onChange={setScope} isDisabled={busy} options={[
      { value: 'global', label: text.allSessions },
      { value: 'project', label: `${text.projectOnly}：${snapshot.project.name}` }
    ]} /> : <Meta>{text.scopeAllOnly}</Meta>}
    <div className="mcp-form-field">
      <SegmentedControl showLabel label={text.owner} value={owner} onChange={setOwner} isDisabled={busy} options={[{ value: 'pi', label: text.ownerPi, testId: 'mcp-owner-pi' }, { value: 'inkstone', label: text.ownerHost, testId: 'mcp-owner-inkstone' }]} />
      <Meta>{text.ownerHint}</Meta>
    </div>
    <SegmentedControl showLabel label={text.transport} value={transport} onChange={setTransport} isDisabled={busy} options={[{ value: 'local', label: text.local }, { value: 'remote', label: text.remote }]} />
    {transport === 'local' ? <>
      <TextField label={text.command} value={command} onChange={setCommand} isDisabled={busy} />
      <TextArea label={text.args} value={args} onChange={setArgs} isDisabled={busy} rows={3} />
    </> : <TextField label={text.url} value={url} onChange={setUrl} isDisabled={busy} />}
    <SettingsAdvanced label={text.showAdvanced} testId="mcp-form-advanced"><TextArea label={text.env} value={env} onChange={setEnv} isDisabled={busy} rows={3} /></SettingsAdvanced>
    {error ? <Warn>{error}</Warn> : null}
    <Actions><Button isDisabled={busy} onPress={onCancel}>{text.cancel}</Button><Button variant="primary" isDisabled={busy || !name.trim() || !(transport === 'local' ? command.trim() : url.trim())} onPress={() => void save()}>{text.save}</Button></Actions>
  </div>
}
