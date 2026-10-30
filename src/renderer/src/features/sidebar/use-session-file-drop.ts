import { useEffect, type RefObject } from 'react'
import type { TFunc } from '../../i18n'
import { useStore } from '../../state/store'
import { composerSubmitIdentity } from '../../state/composer-recovery'
import { useUiV3 } from '../../state/ui-v3'
import { showToast } from '../../ui'
import { acceptsFileDrop } from '../composer/FileDropZone'
import { attachDroppedFiles, captureDroppedFiles } from '../composer/drop-attach'
import { openSidebarSession } from './session-advance'
import { fileDropRowPath, sameSessionPathLoose, type DropTargetNode } from './session-nav'
import { useSessionNav } from './session-nav-store'

function setDropPath(path: string | null): void {
  if (useSessionNav.getState().fileDropPath !== path) useSessionNav.setState({ fileDropPath: path })
}

export function useSessionFileDrop(asideRef: RefObject<HTMLElement | null>, t: TFunc): void {
  useEffect(() => {
    const aside = asideRef.current
    if (!aside) return
    const rowPath = (event: DragEvent): string | null => fileDropRowPath(event.target as DropTargetNode | null)
    const onOver = (event: DragEvent): void => {
      if (!acceptsFileDrop(event.dataTransfer)) return
      const path = rowPath(event)
      setDropPath(path)
      if (!path) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
    }
    const onLeave = (event: DragEvent): void => {
      const next = event.relatedTarget as Node | null
      if (!next || !aside.contains(next)) setDropPath(null)
    }
    const onDrop = (event: DragEvent): void => {
      setDropPath(null)
      if (event.defaultPrevented || !acceptsFileDrop(event.dataTransfer)) return
      const path = rowPath(event)
      if (!path) return
      event.preventDefault()
      const dropped = captureDroppedFiles(event.dataTransfer)
      if (!dropped) return
      const summary = useStore.getState().sessions.find((item) => sameSessionPathLoose(item.path, path))
      const viewing = useStore.getState()
      const arrive = sameSessionPathLoose(viewing.peekedPath ?? viewing.session?.sessionFile, path)
        ? Promise.resolve(useUiV3.getState().navigate({ name: 'chat' }))
        : openSidebarSession({ id: summary?.id, path })
      void arrive.then(() => {
        const state = useStore.getState()
        if (!sameSessionPathLoose(state.peekedPath ?? state.session?.sessionFile, path)) return
        attachDroppedFiles(dropped, composerSubmitIdentity(state), (names) =>
          showToast(t('attachment.skipped', { names: names.join(', ') }), { tone: 'danger', timeout: 10000 })
        )
        state.requestComposerFocus({ sessionId: summary?.id, path })
      })
    }
    const clear = (): void => setDropPath(null)
    aside.addEventListener('dragenter', onOver)
    aside.addEventListener('dragover', onOver)
    aside.addEventListener('dragleave', onLeave)
    aside.addEventListener('drop', onDrop)
    window.addEventListener('dragend', clear)
    window.addEventListener('drop', clear)
    return () => {
      aside.removeEventListener('dragenter', onOver)
      aside.removeEventListener('dragover', onOver)
      aside.removeEventListener('dragleave', onLeave)
      aside.removeEventListener('drop', onDrop)
      window.removeEventListener('dragend', clear)
      window.removeEventListener('drop', clear)
      clear()
    }
  }, [asideRef, t])
}
