import { useCallback, useEffect } from 'react'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { NativeSessionPanel } from './NativeSessionPanel'
import { parseTreePayload, type NativeSessionAction, type NativeSessionLoadResult } from '../../../../shared/native-session'

export function NativeSessionSurface() {
  const panel = useStore(state => state.nativeSessionPanel)
  const sessionId = useStore(state => state.session?.sessionId)
  const close = useStore(state => state.closeNativeSessionPanel)
  const t = useT()
  useEffect(() => {
    if (panel && panel.sessionId !== sessionId) close()
  }, [panel, sessionId, close])

  const load = useCallback(async (): Promise<NativeSessionLoadResult> => {
    if (!panel || panel.mode === 'entries') return { ok: false, mode: 'tree', error: t('native.loadFailed') }
    const result = await window.yan.nativeSession({ action: panel.mode, expectedSessionId: panel.sessionId })
    if (!result.ok) return { ok: false, mode: panel.mode, error: result.error ?? t('native.loadFailed') }
    if (panel.mode === 'tree') return { ok: true, mode: 'tree', ...parseTreePayload(result) }
    if (panel.mode === 'trust') return {
      ok: true, mode: 'trust', cwd: result.cwd ?? '', trusted: result.trusted === true,
      entry: result.trustEntry ?? null, requiresTrust: result.requiresTrust ?? true
    }
    const selected = new Set(result.scopedModelIds ?? [])
    const current = useStore.getState().session?.model
    return {
      ok: true, mode: 'scoped-models', scopeIsAll: selected.size === 0,
      models: (result.models ?? []).map(model => ({
        ...model, inScope: selected.size === 0 || selected.has(`${model.provider}/${model.id}`),
        current: model.provider === current?.provider && model.id === current?.id
      }))
    }
  }, [panel, t])

  const onAction: NativeSessionAction = useCallback(async (action, args) => {
    if (!panel) return { ok: false, error: t('native.loadFailed') }
    const result = await window.yan.nativeSession({ action, ...args, expectedSessionId: panel.sessionId })
    if (result.ok) {
      const store = useStore.getState()
      await store.refreshSessions()
      if (action !== 'navigate') await Promise.all([store.reloadModels(), store.reloadCommands()])
      if (result.requiresReload) return { ok: true, message: t('native.requiresReload') }
    }
    return result.cancelled ? { ok: false, error: t('native.cancelled') } : result
  }, [panel, t])

  if (!panel || panel.mode === 'entries' || panel.sessionId !== sessionId) return null
  return <NativeSessionPanel mode={panel.mode} resetKey={panel.sessionId} onClose={close} load={load} onAction={onAction} />
}
