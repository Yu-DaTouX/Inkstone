import { useEffect, useRef, useState, type ReactElement } from 'react'
import { ChevronDown, Search } from 'lucide-react'
import {
  Button,
  Dialog,
  DialogFooter,
  Input,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  Menu,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  Modal,
  ModalOverlay,
  Notice,
  Popover,
  TextField
} from '../../ui'
import { useStore } from '../../state/store'
import { SEARCH_ENGINE_PRESETS, isSearchTemplate, searchEnginePreset } from '../../../../shared/browser-navigation'
import type { BrowserText } from './browser-text'

const CUSTOM_KEY = '__custom'

interface BrowserStartPageProps {
  tabId: string | undefined
  text: BrowserText
  onSubmit: (value: string) => void
}

function customEngineLabel(template: string): string {
  try {
    return new URL(template.replace(/%s/g, 'q')).hostname.replace(/^www\./, '')
  } catch {
    return template
  }
}

export function BrowserStartPage({ tabId, text, onSubmit }: BrowserStartPageProps): ReactElement {
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const engine = useStore((s) => s.settings?.browserSearchEngine)
  const patchSettings = useStore((s) => s.patchSettings)
  const preset = searchEnginePreset(engine)
  const engineLabel = preset ? preset.name : customEngineLabel(engine ?? '')
  const [customOpen, setCustomOpen] = useState(false)

  useEffect(() => {
    setValue('')
    const frame = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [tabId])

  return (
    <div className="v3-browser-start" data-testid="browser-start-page">
      <form
        className="v3-browser-start__form"
        role="search"
        onSubmit={(event) => {
          event.preventDefault()
          if (value.trim()) onSubmit(value)
        }}
      >
        <TextField className="v3-browser-start__field" aria-label={text.startAddress} value={value} onChange={setValue}>
          <InputGroup>
            <InputGroupAddon align="start">
              <Search size={16} aria-hidden="true" />
            </InputGroupAddon>
            <InputGroupInput
              ref={inputRef}
              placeholder={text.startAddress}
              aria-label={text.startAddress}
              data-testid="browser-start-address"
              spellCheck={false}
              autoComplete="off"
            />
            <InputGroupAddon align="end">
              <MenuTrigger>
                <Button variant="ghost" size="sm" aria-label={`${text.searchEngine}: ${engineLabel}`} data-testid="browser-start-engine">
                  <span>{engineLabel}</span>
                  <ChevronDown size={12} aria-hidden="true" />
                </Button>
                <Popover placement="bottom end">
                  <Menu
                    aria-label={text.searchEngine}
                    selectionMode="single"
                    disallowEmptySelection
                    selectedKeys={[preset ? preset.id : CUSTOM_KEY]}
                    onAction={(key) => {
                      if (key === CUSTOM_KEY) setCustomOpen(true)
                      else void patchSettings({ browserSearchEngine: String(key) })
                    }}
                  >
                    {SEARCH_ENGINE_PRESETS.map((item) => (
                      <MenuItem key={item.id} id={item.id} textValue={item.name} data-testid={`browser-start-engine-${item.id}`}>
                        {item.name}
                      </MenuItem>
                    ))}
                    <MenuSeparator />
                    <MenuItem id={CUSTOM_KEY} textValue={text.searchEngineCustom} data-testid="browser-start-engine-custom">
                      {preset ? text.searchEngineCustom : engineLabel}
                    </MenuItem>
                  </Menu>
                </Popover>
              </MenuTrigger>
            </InputGroupAddon>
          </InputGroup>
        </TextField>
      </form>
      <CustomEngineDialog
        isOpen={customOpen}
        initial={preset ? '' : engine ?? ''}
        text={text}
        onClose={() => setCustomOpen(false)}
        onSave={(template) => {
          void patchSettings({ browserSearchEngine: template })
          setCustomOpen(false)
        }}
      />
    </div>
  )
}

function CustomEngineDialog({
  isOpen,
  initial,
  text,
  onClose,
  onSave
}: {
  isOpen: boolean
  initial: string
  text: BrowserText
  onClose: () => void
  onSave: (template: string) => void
}): ReactElement {
  const [draft, setDraft] = useState(initial)
  const [invalid, setInvalid] = useState(false)

  useEffect(() => {
    if (!isOpen) return
    setDraft(initial)
    setInvalid(false)
  }, [isOpen, initial])

  const submit = (): void => {
    const template = draft.trim()
    if (!isSearchTemplate(template)) {
      setInvalid(true)
      return
    }
    onSave(template)
  }

  return (
    <ModalOverlay isDismissable isOpen={isOpen} onOpenChange={(open) => { if (!open) onClose() }}>
      <Modal className="v3-browser-sites">
        <Dialog title={text.searchEngine} closeLabel={text.cancel} data-testid="browser-start-engine-dialog">
          <form
            className="v3-browser-sites__add"
            onSubmit={(event) => {
              event.preventDefault()
              submit()
            }}
          >
            <TextField
              className="v3-browser-sites__add-field"
              aria-label={text.searchEngineCustomLabel}
              value={draft}
              isInvalid={invalid}
              onChange={(next) => {
                setDraft(next)
                setInvalid(false)
              }}
            >
              <Input
                className="ui-input"
                aria-label={text.searchEngineCustomLabel}
                placeholder="https://example.com/search?q=%s"
                spellCheck={false}
                autoComplete="off"
                autoFocus
                data-testid="browser-start-engine-input"
              />
            </TextField>
          </form>
          {invalid ? (
            <Notice tone="fail" compact data-testid="browser-start-engine-invalid">
              {text.searchEngineInvalid}
            </Notice>
          ) : null}
          <DialogFooter>
            <Button variant="secondary" onPress={onClose}>
              {text.cancel}
            </Button>
            <Button variant="primary" isDisabled={!draft.trim()} onPress={submit} data-testid="browser-start-engine-save">
              {text.save}
            </Button>
          </DialogFooter>
        </Dialog>
      </Modal>
    </ModalOverlay>
  )
}
