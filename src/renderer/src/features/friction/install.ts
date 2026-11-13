import { useStore } from '../../state/store'

let loaded: Promise<typeof import('./recorder')> | null = null
let wanted = false

export function installFrictionRecorder(): void {
  const apply = (): void => {
    const next = useStore.getState().settings?.frictionRecorder === true
    if (next === wanted) return
    wanted = next
    if (!next && !loaded) return
    loaded ??= import('./recorder')
    void loaded.then((mod) => mod.syncFrictionRecorder(wanted)).catch(() => undefined)
  }
  apply()
  useStore.subscribe(apply)
}
