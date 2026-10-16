import { useStore } from './store'

let timer: ReturnType<typeof setTimeout> | null = null
let generation = 0

export function refreshModelsAfterRestart(): void {
  const mine = ++generation
  if (timer) clearTimeout(timer)
  const signature = (models: ReturnType<typeof useStore.getState>['models']): string => models.map((model) => `${model.provider}:${model.id}`).sort().join('|')
  const before = signature(useStore.getState().models)
  let tries = 0
  const tick = async (): Promise<void> => {
    timer = null
    if (mine !== generation) return
    if (useStore.getState().conn === 'ready') {
      await useStore.getState().reloadModels()
      if (mine !== generation) return
      if (signature(useStore.getState().models) !== before) return
    }
    if (mine === generation && ++tries < 20) timer = setTimeout(() => void tick(), 2000)
  }
  timer = setTimeout(() => void tick(), 1500)
}
