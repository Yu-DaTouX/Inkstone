import type { ProjectRecord } from '../../../../shared/ipc'
import type { ProjectScript } from '../../../../shared/project-scripts'
import { currentLang, translate } from '../../i18n'
import { useStore } from '../../state/store'
import { openPanelTool } from '../workbench/panel-actions'
import { requestTerminalTab } from '../terminal/terminal-requests'
import { primaryProjectScript, scriptsOfProject } from './project-scripts'
import { currentProjectTarget } from './use-current-project'

const COMMAND_DELAY_MS = 400
const PREVIEW_DELAY_MS = 2000

function terminalBridge(): typeof window.yan.terminal | null {
  if (typeof window === 'undefined') return null
  return window.yan?.terminal ?? null
}

export async function runProjectScript(
  project: ProjectRecord,
  script: ProjectScript,
  ownerKey: string
): Promise<boolean> {
  const terminal = terminalBridge()
  if (!terminal) return false
  const cwd = project.cwd
  const snapshot = await terminal
    .start({ cwd, fallbackCwd: cwd, owner: ownerKey, title: script.name })
    .catch(() => null)
  if (!snapshot) return false
  openPanelTool('terminal')
  requestTerminalTab({ ownerKey, terminalId: snapshot.id })
  window.setTimeout(() => {
    void terminal.write(snapshot.id, `${script.command.trim()}\r`)
  }, COMMAND_DELAY_MS)
  const previewUrl = script.previewUrl?.trim()
  if (previewUrl) {
    window.setTimeout(() => {
      void useStore.getState().openBrowser(previewUrl)
    }, PREVIEW_DELAY_MS)
  }
  return true
}

export async function runPrimaryProjectScript(): Promise<boolean> {
  const target = currentProjectTarget()
  if (!target.project) return false
  const script = primaryProjectScript(
    scriptsOfProject(useStore.getState().settings?.projectScripts, target.project.id)
  )
  if (!script) {
    useStore.getState().notify('info', translate(currentLang(), 'script.none'))
    return false
  }
  return runProjectScript(target.project, script, target.ownerKey)
}
