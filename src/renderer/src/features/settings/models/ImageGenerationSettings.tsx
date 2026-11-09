import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { IMAGE_SERVICES, type ImageComplexity, type ImageConfigView, type ImageKeyService, type ImageModelService, type ImageProviderChoice, type ImageService } from '../../../../../shared/image-config'
import { useI18n } from '../../../i18n'
import { Badge, Button, CollapsibleChevron, ListBoxItem, Notice, Select, TextField } from '../../../ui'
import { Segmented, SettingsGroup, SettingsRow } from '../root/controls'
import { imageText } from './image-text'
import './models-settings.css'

const KEY_SERVICES: readonly ImageKeyService[] = ['compatible', 'openai', 'google', 'doubao']
const hasKeyField = (service: ImageService): service is ImageKeyService => (KEY_SERVICES as readonly string[]).includes(service)
const hasModelField = (service: ImageService): service is ImageModelService => service !== 'local' && service !== 'codex'

export function ImageGenerationSettings(): ReactElement {
  const { lang } = useI18n()
  const text = imageText(lang)
  const [view, setView] = useState<ImageConfigView | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set())
  const toggleCard = (service: string): void => setOpened((current) => { const next = new Set(current); if (next.has(service)) next.delete(service); else next.add(service); return next })
  const [msg, setMsg] = useState<{ kind: 'ok' | 'fail'; text: string } | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const reload = useCallback(async (): Promise<void> => {
    try {
      const next = await window.yan.image.config()
      if (alive.current) setView(next)
    } catch (error) {
      if (alive.current) setMsg({ kind: 'fail', text: error instanceof Error ? error.message : String(error) })
    }
  }, [])
  useEffect(() => {
    void reload()
  }, [reload])

  const run = async (action: Promise<{ ok: boolean; error?: string }>, done?: string): Promise<boolean> => {
    const result = await action.catch((error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }))
    if (!alive.current) return false
    setMsg(result.ok ? (done ? { kind: 'ok', text: done } : null) : { kind: 'fail', text: result.error ?? text.failed })
    if (result.ok) await reload()
    return result.ok
  }
  const draft = (field: string, fallback: string): string => drafts[field] ?? fallback
  const setDraft = (field: string, value: string): void => setDrafts((current) => ({ ...current, [field]: value }))
  const clearDraft = (field: string): void =>
    setDrafts((current) => {
      const { [field]: _removed, ...rest } = current
      return rest
    })

  if (!view) return <SettingsGroup title={text.title} settingId="models-image-generation" className="ms-group" plain fold={{}}>{msg ? <Notice tone={msg.kind}>{msg.text}</Notice> : null}</SettingsGroup>

  const labelOf = (service: ImageProviderChoice | 'unavailable' | 'mock'): string => (service === 'auto' ? text.auto : service === 'unavailable' ? text.unavailable : service === 'mock' ? text.mock : text.service[service])
  const status = (service: ImageService): { tone: 'ok' | 'neutral'; label: string } => {
    if (service === 'codex') return view.codex ? { tone: 'ok', label: text.signedIn } : { tone: 'neutral', label: text.notSignedIn }
    if (service === 'local') return view.local ? { tone: 'ok', label: text.detected } : { tone: 'neutral', label: text.notDetected }
    const source = view.keys[service as ImageKeyService]
    if (source === 'file') return { tone: 'ok', label: text.keySaved }
    if (source === 'other') return { tone: 'ok', label: text.keyElsewhere }
    return { tone: 'neutral', label: text.noKey }
  }

  return (
    <SettingsGroup title={text.title} description={text.description} settingId="models-image-generation" className="ms-group" plain testId="ms-image-generation" fold={{ summary: text.current.replace('{name}', labelOf(view.provider === 'auto' ? view.resolved : view.provider)) }}>
      <SettingsRow label={text.defaultService} description={view.provider === 'auto' ? text.autoHint.replace('{name}', labelOf(view.resolved)) : undefined}>
        <Select
          aria-label={text.defaultService}
          selectedKey={view.provider}
          onSelectionChange={(key) => void run(window.yan.image.update({ provider: String(key) as ImageProviderChoice }))}
          data-testid="ms-image-provider"
        >
          <ListBoxItem id="auto">{text.auto}</ListBoxItem>
          {IMAGE_SERVICES.map((service) => (
            <ListBoxItem key={service} id={service}>
              {text.service[service]}
            </ListBoxItem>
          ))}
        </Select>
      </SettingsRow>
      <SettingsRow label={text.complexity} description={text.complexityDesc}>
        <Segmented
          label={text.complexity}
          value={view.complexity}
          options={[
            { value: 'default', label: text.complexityDefault, testId: 'ms-image-complexity-default' },
            { value: 'low', label: text.complexityLow, testId: 'ms-image-complexity-low' },
            { value: 'medium', label: text.complexityMedium, testId: 'ms-image-complexity-medium' },
            { value: 'high', label: text.complexityHigh, testId: 'ms-image-complexity-high' }
          ]}
          onChange={(value) => void run(window.yan.image.update({ complexity: value as ImageComplexity | 'default' }))}
        />
      </SettingsRow>
      {IMAGE_SERVICES.map((service) => {
        const state = status(service)
        const modelField = `model:${service}`
        const keyField = `key:${service}`
        const baseField = 'baseUrl'
        const cardOpen = opened.has(service)
        const savedModel = hasModelField(service) ? view.models[service] ?? '' : ''
        const keySource = hasKeyField(service) ? view.keys[service] : undefined
        return (
          <div className="ms-image-card" key={service} data-testid={`ms-image-${service}`}>
            <Button variant="ghost" className="ms-image-head" aria-expanded={cardOpen} icon={<CollapsibleChevron expanded={cardOpen} />} onPress={() => toggleCard(service)} data-testid={`ms-image-toggle-${service}`}>
              <span className="ms-image-name">{text.service[service]}</span>
              <Badge tone={state.tone}>{state.label}</Badge>
              {view.provider === service ? <Badge tone="accent">{text.inUse}</Badge> : null}
            </Button>
            {cardOpen ? <div className="ms-image-note">{text.note[service]}</div> : null}
            {cardOpen ? <div className="ms-image-fields">
              {service === 'compatible' ? (
                <TextField
                  label={text.baseUrl}
                  placeholder="https://api.example.com/v1"
                  value={draft(baseField, view.baseUrl)}
                  onChange={(value) => setDraft(baseField, value)}
                  onBlur={() => {
                    const value = draft(baseField, view.baseUrl).trim()
                    if (value === view.baseUrl) return clearDraft(baseField)
                    void run(window.yan.image.update({ baseUrl: value })).then((ok) => { if (ok) clearDraft(baseField) })
                  }}
                  inputClassName="ms-custom-input"
                  data-testid="ms-image-base-url"
                />
              ) : null}
              {hasModelField(service) ? (
                <TextField
                  label={text.model}
                  placeholder={view.defaults[service]}
                  value={draft(modelField, savedModel)}
                  onChange={(value) => setDraft(modelField, value)}
                  onBlur={() => {
                    const value = draft(modelField, savedModel).trim()
                    if (value === savedModel) return clearDraft(modelField)
                    void run(window.yan.image.update({ model: { service, value } })).then((ok) => { if (ok) clearDraft(modelField) })
                  }}
                  inputClassName="ms-custom-input"
                  data-testid={`ms-image-model-${service}`}
                />
              ) : null}
              {hasKeyField(service) ? (
                <form
                  className="ms-image-key"
                  onSubmit={(event) => {
                    event.preventDefault()
                    const value = draft(keyField, '')
                    if (!value.trim()) return
                    void run(window.yan.image.setKey(service, value), text.keySavedMsg).then((ok) => { if (ok) clearDraft(keyField) })
                  }}
                >
                  <TextField
                    label="API key"
                    type="password"
                    autoComplete="off"
                    placeholder={keySource === 'file' ? text.keyReplace : keySource === 'other' ? text.keyOverride : text.keyPlaceholder}
                    value={draft(keyField, '')}
                    onChange={(value) => setDraft(keyField, value)}
                    inputClassName="ms-custom-input"
                    data-testid={`ms-image-key-${service}`}
                  />
                  <Button variant="secondary" type="submit" isDisabled={!draft(keyField, '').trim()} data-testid={`ms-image-key-save-${service}`}>
                    {text.save}
                  </Button>
                  {keySource === 'file' ? (
                    <Button variant="secondary" onPress={() => void run(window.yan.image.clearKey(service), text.keyClearedMsg)} data-testid={`ms-image-key-clear-${service}`}>
                      {text.clear}
                    </Button>
                  ) : null}
                </form>
              ) : null}
            </div> : null}
          </div>
        )
      })}
      {msg ? (
        <Notice tone={msg.kind} className="ms-msg" data-testid="ms-image-msg">
          {msg.text}
        </Notice>
      ) : null}
    </SettingsGroup>
  )
}
