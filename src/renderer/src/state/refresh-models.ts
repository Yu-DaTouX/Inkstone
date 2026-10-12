import { useStore } from './store'

let timer: ReturnType<typeof setTimeout> | null = null
let generation = 0

/**
 * 凭证或自定义服务变更后，主进程会重启 pi 让它重读 auth.json / models.json。
 * 重启可能快到连接心跳看不到 非 ready → ready，所以这里主动轮询重拉模型列表：
 * 只在连接 ready 时拉（重启间隙拉到的是空结果），模型数量一变就停；
 * 最多约 40 秒，重启要等当前回合结束时可能更久，之后由心跳兜底。
 */
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
