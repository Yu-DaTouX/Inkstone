import { useStore } from './store'

let timer: ReturnType<typeof setTimeout> | null = null

/**
 * 凭证或自定义服务变更后，主进程会重启 pi 让它重读 auth.json / models.json。
 * 重启可能快到连接心跳看不到 非 ready → ready，所以这里主动轮询重拉模型列表：
 * 只在连接 ready 时拉（重启间隙拉到的是空结果），模型数量一变就停；
 * 最多约 40 秒，重启要等当前回合结束时可能更久，之后由心跳兜底。
 */
export function refreshModelsAfterRestart(): void {
  if (timer) clearTimeout(timer)
  const before = useStore.getState().models.length
  let tries = 0
  const tick = async (): Promise<void> => {
    timer = null
    if (useStore.getState().conn === 'ready') {
      await useStore.getState().reloadModels()
      if (useStore.getState().models.length !== before) return
    }
    if (++tries < 20) timer = setTimeout(() => void tick(), 2000)
  }
  timer = setTimeout(() => void tick(), 1500)
}
