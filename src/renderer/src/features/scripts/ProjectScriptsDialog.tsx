import { useEffect, useState, type ReactElement } from 'react'
import { ArrowDown, ArrowUp, FileJson, Plus, Trash2 } from 'lucide-react'
import {
  Button,
  Card,
  Checkbox,
  Dialog,
  DialogFooter,
  EmptyState,
  IconButton,
  ListBoxItem,
  Modal,
  ModalOverlay,
  Notice,
  Select,
  Spinner,
  TextField
} from '../../ui'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { PROJECT_SCRIPT_ICONS, type PackageScript, type ProjectScript } from '../../../../shared/project-scripts'
import type { ProjectRecord } from '../../../../shared/ipc'
import {
  addProjectScripts,
  importablePackageScripts,
  moveProjectScript,
  normalizeProjectScripts,
  removeProjectScript,
  replaceProjectScript
} from './project-scripts'
import { SCRIPT_ICON_LABEL } from './script-icons'
import './scripts.css'

export interface ProjectScriptsDialogProps {
  project: ProjectRecord
  scripts: readonly ProjectScript[]
  initialImport?: boolean
  onClose: () => void
}

function newScript(): ProjectScript {
  return { id: crypto.randomUUID(), name: '', command: '', icon: 'play' }
}

export function ProjectScriptsDialog({
  project,
  scripts,
  initialImport = false,
  onClose
}: ProjectScriptsDialogProps): ReactElement {
  const t = useT()
  const [draft, setDraft] = useState<ProjectScript[]>(() => scripts.map((script) => ({ ...script })))
  const [available, setAvailable] = useState<PackageScript[]>([])
  const [importShown, setImportShown] = useState(initialImport)
  const [importLoading, setImportLoading] = useState(false)
  const [importError, setImportError] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const importable = importablePackageScripts(draft, available)

  const loadImportable = async (): Promise<void> => {
    setImportShown(true)
    setImportLoading(true)
    setImportError('')
    const result = await window.yan.projectScripts.read(project.id).catch(() => null)
    setImportLoading(false)
    if (!result) {
      setImportError(t('script.importFailed'))
      return
    }
    if (!result.ok) {
      setImportError(result.error || t('script.importFailed'))
      return
    }
    setAvailable(result.scripts)
    setPicked([])
  }

  useEffect(() => {
    if (!initialImport) return
    void loadImportable()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toggleImport = (): void => {
    if (importShown) {
      setImportShown(false)
      return
    }
    void loadImportable()
  }

  const applyImport = (): void => {
    const adds = importable.filter((item) => picked.includes(item.name))
    if (adds.length === 0) return
    setDraft((current) => addProjectScripts(current, adds, () => crypto.randomUUID()))
    setPicked([])
    setImportShown(false)
  }

  const update = (id: string, patch: Partial<Omit<ProjectScript, 'id'>>): void => {
    setDraft((current) => replaceProjectScript(current, id, patch))
  }

  const save = async (close: () => void): Promise<void> => {
    if (draft.some((script) => !script.name.trim() || !script.command.trim())) {
      setError(t('script.invalid'))
      return
    }
    const normalized = normalizeProjectScripts(draft)
    const all = { ...(useStore.getState().settings?.projectScripts ?? {}) }
    if (normalized.length > 0) all[project.id] = normalized
    else delete all[project.id]
    setBusy(true)
    setError('')
    try {
      await useStore.getState().patchSettings({ projectScripts: all })
      close()
    } catch {
      setError(t('script.saveFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <ModalOverlay
      isDismissable
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <Modal className="scripts-modal">
        <Dialog title={t('script.dialogTitle')} closeLabel={t('script.cancel')} data-testid="scripts-dialog">
          {({ close }) => (
            <div className="scripts-dialog">
              <p className="scripts-dialog-project">{project.name || project.cwd}</p>

              <div className="scripts-dialog-list">
                {draft.length === 0 ? <EmptyState size="sm" title={t('script.empty')} /> : null}
                {draft.map((script, index) => (
                  <Card padding="sm" quiet className="scripts-card" key={script.id} data-testid={`script-card-${index}`}>
                    <div className="scripts-card-head">
                      <Select
                        aria-label={t('script.icon')}
                        selectedKey={script.icon ?? 'play'}
                        onSelectionChange={(key) => {
                          const icon = PROJECT_SCRIPT_ICONS.find((item) => item === key) ?? 'play'
                          update(script.id, { icon })
                        }}
                      >
                        {PROJECT_SCRIPT_ICONS.map((icon) => (
                          <ListBoxItem key={icon} id={icon} textValue={t(SCRIPT_ICON_LABEL[icon])}>
                            {t(SCRIPT_ICON_LABEL[icon])}
                          </ListBoxItem>
                        ))}
                      </Select>
                      <TextField
                        aria-label={t('script.name')}
                        placeholder={t('script.namePlaceholder')}
                        value={script.name}
                        onChange={(name) => update(script.id, { name })}
                      />
                      <div className="scripts-card-tools">
                        <IconButton
                          aria-label={t('script.moveUp')}
                          tooltip={t('script.moveUp')}
                          isDisabled={index === 0}
                          onPress={() => setDraft((current) => moveProjectScript(current, script.id, -1))}
                          data-testid={`script-up-${index}`}
                        >
                          <ArrowUp size={14} />
                        </IconButton>
                        <IconButton
                          aria-label={t('script.moveDown')}
                          tooltip={t('script.moveDown')}
                          isDisabled={index === draft.length - 1}
                          onPress={() => setDraft((current) => moveProjectScript(current, script.id, 1))}
                          data-testid={`script-down-${index}`}
                        >
                          <ArrowDown size={14} />
                        </IconButton>
                        <IconButton
                          aria-label={t('script.remove')}
                          tooltip={t('script.remove')}
                          variant="danger"
                          onPress={() => setDraft((current) => removeProjectScript(current, script.id))}
                          data-testid={`script-remove-${index}`}
                        >
                          <Trash2 size={14} />
                        </IconButton>
                      </div>
                    </div>
                    <TextField
                      label={t('script.command')}
                      placeholder={t('script.commandPlaceholder')}
                      value={script.command}
                      onChange={(command) => update(script.id, { command })}
                    />
                    <TextField
                      label={t('script.previewUrl')}
                      placeholder={t('script.previewUrlPlaceholder')}
                      value={script.previewUrl ?? ''}
                      onChange={(previewUrl) => update(script.id, { previewUrl })}
                    />
                  </Card>
                ))}
              </div>

              <div className="scripts-dialog-actions">
                <Button
                  size="sm"
                  icon={<Plus size={14} />}
                  isDisabled={busy}
                  onPress={() => setDraft((current) => [...current, newScript()])}
                  data-testid="script-add-row"
                >
                  {t('script.addRow')}
                </Button>
                <Button
                  size="sm"
                  icon={<FileJson size={14} />}
                  isDisabled={busy || importLoading}
                  onPress={toggleImport}
                  data-testid="script-import-toggle"
                >
                  {importShown ? t('script.importHide') : t('script.import')}
                </Button>
              </div>

              {importShown ? (
                <Card padding="sm" quiet className="scripts-import" data-testid="scripts-import">
                  {importLoading ? <Notice compact variant="hint" icon={<Spinner size="sm" />}>{t('script.importLoading')}</Notice> : null}
                  {importError ? (
                    <Notice tone="fail" compact>
                      {importError}
                    </Notice>
                  ) : null}
                  {!importLoading && !importError ? (
                    importable.length === 0 ? (
                      <EmptyState size="sm" title={t('script.importEmpty')} />
                    ) : (
                      <>
                        <div className="scripts-import-list">
                          {importable.map((item) => (
                            <Checkbox
                              key={item.name}
                              isSelected={picked.includes(item.name)}
                              onChange={(selected) =>
                                setPicked((current) =>
                                  selected ? [...current, item.name] : current.filter((name) => name !== item.name)
                                )
                              }
                              data-testid={`script-import-${item.name}`}
                            >
                              <span className="scripts-import-name">{item.name}</span>
                              <span className="scripts-import-command">{item.command}</span>
                            </Checkbox>
                          ))}
                        </div>
                        <Button
                          size="sm"
                          variant="primary"
                          isDisabled={picked.length === 0}
                          onPress={applyImport}
                          data-testid="script-import-apply"
                        >
                          {t('script.importApply', { n: picked.length })}
                        </Button>
                      </>
                    )
                  ) : null}
                </Card>
              ) : null}

              {error ? (
                <Notice tone="fail" compact>
                  {error}
                </Notice>
              ) : null}

              <DialogFooter>
                <Button variant="ghost" isDisabled={busy} onPress={close}>
                  {t('script.cancel')}
                </Button>
                <Button
                  variant="primary"
                  isDisabled={busy}
                  onPress={() => void save(close)}
                  data-testid="scripts-save"
                >
                  {t('script.save')}
                </Button>
              </DialogFooter>
            </div>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  )
}
