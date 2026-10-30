import { useEffect } from 'react'
import { holdMotion } from '../../ui'
import { useStore } from '../../state/store'
import { useRightPanel } from '../../state/right-panel'
import { useUiV3 } from '../../state/ui-v3'

export function useNavigationMotionHold(): void {
  useEffect(() => {
    const offSession = useStore.subscribe((next, prev) => {
      if (next.session?.sessionFile !== prev.session?.sessionFile || next.peekedPath !== prev.peekedPath || next.peekedSessionId !== prev.peekedSessionId) holdMotion()
    })
    const offPanel = useRightPanel.subscribe((next, prev) => {
      if (next.key !== prev.key) holdMotion()
    })
    const offRoute = useUiV3.subscribe((next, prev) => {
      if (next.route !== prev.route) holdMotion()
    })
    return () => {
      offSession()
      offPanel()
      offRoute()
    }
  }, [])
}
