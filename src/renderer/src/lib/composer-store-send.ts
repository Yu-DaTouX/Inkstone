import { useStore } from '../state/store'
import { composerLocalCommand } from '../features/composer/composer-layout'
import { roundRunningOf } from '../features/composer/composer-keys'
import { submitComposerInput, type ComposerSendActions } from './composer-submit'
import { runLocalCommandGuarded } from './v3-submit-ownership'
import type { HostT } from './host-actions'

export function composerStoreActions(): ComposerSendActions {
  const state = useStore.getState
  return {
    runBash: (command, options) => state().runBash(command, options),
    openSettings: (tab) => state().openSettings(tab),
    newSession: () => state().newSession({ scope: 'global' }),
    compact: (custom) => state().compact(custom),
    openBrowser: (url) => state().openBrowser(url),
    setModel: (provider, id) => state().setModel(provider, id),
    exportHtml: (path) => state().exportHtml(path),
    copyLastReply: () => state().copyLastReply(),
    clone: () => state().clone(),
    setManualTitle: (id, title) => state().setManualTitle(id, title),
    setThinking: (level) => state().setThinking(level),
    nativeSession: (action, args) => state().nativeSession(action, args),
    notify: (level, text) => state().notify(level, text)
  }
}

export async function sendAsComposerMessage(text: string, t: HostT): Promise<boolean> {
  const message = text.trim()
  if (!message) return false
  const state = useStore.getState()
  const submit = async (): Promise<void> => {
    const current = useStore.getState()
    const runner = current.runners.find((item) => (item.runId ?? item.id) === current.activeRunnerId)
    await submitComposerInput({
      text: message,
      attachments: [],
      commands: current.commands,
      models: current.models,
      t,
      session: current.session,
      thinkingLevels: current.thinkingLevels,
      roundRunning: roundRunningOf({
        runnerRunning: !!runner?.running,
        isStreaming: current.session?.isStreaming,
        isCompacting: current.session?.isCompacting
      }),
      isCompacting: !!current.session?.isCompacting,
      actions: composerStoreActions(),
      clearText: () => undefined,
      clearAll: () => undefined,
      restoreText: (raw) => useStore.getState().insertIntoComposer(raw),
      restoreAttachments: () => undefined,
      readAttachments: () => [],
      send: (outgoing, images, mode) => useStore.getState().send(outgoing, images, mode),
      holdSend: (outgoing, images) => useStore.getState().holdSend(outgoing, images),
      focusComposer: () => {
        const latest = useStore.getState()
        latest.requestComposerFocus({ sessionId: latest.session?.sessionId })
      }
    })
  }
  if (composerLocalCommand(message, state.commands)) {
    const outcome = await runLocalCommandGuarded({
      raw: message,
      ensureActivated: () => useStore.getState().ensureActivated(),
      run: submit,
      notifyBlocked: () => useStore.getState().notify('error', t('composer.localCommandBlocked'))
    })
    return outcome === 'ran'
  }
  await submit()
  return true
}
