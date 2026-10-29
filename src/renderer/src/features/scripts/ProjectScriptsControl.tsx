import { useState, type ReactElement } from 'react'
import { ChevronDown, Plus } from 'lucide-react'
import { Button, IconButton, KbdGroup, Menu, MenuItem, MenuSeparator, MenuTrigger, Popover, Tooltip, TooltipHint, TooltipTrigger } from '../../ui'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { SHORTCUTS, shortcutOverridesFromSettings } from '../../app/shortcuts'
import { ProjectScriptsDialog } from './ProjectScriptsDialog'
import { primaryProjectScript, scriptsOfProject } from './project-scripts'
import { runProjectScript } from './run-project-script'
import { scriptIconGlyph } from './script-icons'
import { useProjectTarget } from './use-current-project'
import type { ProjectScript } from '../../../../shared/project-scripts'
import './scripts.css'

const MENU_IMPORT = 'menu:import'
const MENU_MANAGE = 'menu:manage'
const RUN_SHORTCUT_ID = 'runProjectScript'

function runShortcutKeys(overrides: ReturnType<typeof shortcutOverridesFromSettings>): readonly string[] {
  const custom = overrides[RUN_SHORTCUT_ID]
  if (custom && custom.length > 0) return custom
  return SHORTCUTS.find((def) => def.id === RUN_SHORTCUT_ID)?.keys ?? []
}

export function ProjectScriptsControl(): ReactElement | null {
  const t = useT()
  const target = useProjectTarget()
  const scriptsByProject = useStore((s) => s.settings?.projectScripts)
  const overrides = shortcutOverridesFromSettings(useStore((s) => s.settings))
  const [dialog, setDialog] = useState<{ importMode: boolean } | null>(null)

  const project = target.project
  if (!project) return null

  const scripts = scriptsOfProject(scriptsByProject, project.id)
  const primary = primaryProjectScript(scripts)
  const keys = runShortcutKeys(overrides)
  const run = (script: ProjectScript): void => {
    void runProjectScript(project, script, target.ownerKey)
  }
  const closeDialog = (): void => setDialog(null)

  if (!primary) {
    return (
      <>
        <IconButton
          aria-label={t('script.add')}
          tooltip={t('script.add')}
          onPress={() => setDialog({ importMode: false })}
          data-testid="scripts-add"
        >
          <Plus size={16} />
        </IconButton>
        {dialog ? (
          <ProjectScriptsDialog
            project={project}
            scripts={scripts}
            initialImport={dialog.importMode}
            onClose={closeDialog}
          />
        ) : null}
      </>
    )
  }

  const keysText = keys.join('+')
  const runLabel = keysText
    ? t('script.runWithKeys', { name: primary.name, keys: keysText })
    : t('script.run', { name: primary.name })

  return (
    <div className="scripts-control" data-testid="scripts-control">
      <TooltipTrigger>
        <Button
          variant="ghost"
          className="scripts-run"
          aria-label={runLabel}
          icon={scriptIconGlyph(primary.icon)}
          onPress={() => run(primary)}
          data-testid="scripts-run"
        >
          <span className="scripts-run-name">{primary.name}</span>
        </Button>
        <Tooltip>
          <TooltipHint label={t('script.run', { name: primary.name })} shortcut={keys.length > 0 ? keysText : undefined} />
        </Tooltip>
      </TooltipTrigger>
      <MenuTrigger>
        <IconButton aria-label={t('script.menu')} tooltip={t('script.menu')} data-testid="scripts-menu-trigger">
          <ChevronDown size={14} />
        </IconButton>
        <Popover placement="bottom end" offset={4}>
          <Menu
            aria-label={t('script.menu')}
            autoFocus="first"
            data-testid="scripts-menu"
            onAction={(key) => {
              if (key === MENU_IMPORT) {
                setDialog({ importMode: true })
                return
              }
              if (key === MENU_MANAGE) {
                setDialog({ importMode: false })
                return
              }
              const script = scripts.find((item) => item.id === key)
              if (script) run(script)
            }}
          >
            {scripts.map((script, index) => (
              <MenuItem
                key={script.id}
                id={script.id}
                textValue={script.name}
                icon={scriptIconGlyph(script.icon)}
                shortcut={index === 0 && keys.length > 0 ? <KbdGroup keys={keys} /> : undefined}
                data-testid={`scripts-menu-${index}`}
              >
                {script.name}
              </MenuItem>
            ))}
            <MenuSeparator />
            <MenuItem id={MENU_IMPORT} textValue={t('script.import')}>
              {t('script.import')}
            </MenuItem>
            <MenuItem id={MENU_MANAGE} textValue={t('script.manage')}>
              {t('script.manage')}
            </MenuItem>
          </Menu>
        </Popover>
      </MenuTrigger>
      {dialog ? (
        <ProjectScriptsDialog
          project={project}
          scripts={scripts}
          initialImport={dialog.importMode}
          onClose={closeDialog}
        />
      ) : null}
    </div>
  )
}
