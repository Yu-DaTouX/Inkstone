import { CapabilityCommandError } from '../capability-server'
import { comfyStatus, ComfyLaunchError, ensureComfyRunning, stopManagedComfy } from '../comfy-launcher'

export async function runLocalImageServiceCommand(command: 'image.local.status' | 'image.local.start' | 'image.local.stop'): Promise<{ data?: unknown; summary: Record<string, unknown> }> {
  if (command === 'image.local.stop') {
    const stopped = stopManagedComfy()
    const status = await comfyStatus()
    return { data: status, summary: { kind: 'comfyui', stopped, running: status.running, note: stopped ? '已关闭砚启动的 ComfyUI' : status.running ? '正在运行的 ComfyUI 不是砚启动的，没有关闭' : 'ComfyUI 没有在运行' } }
  }
  if (command === 'image.local.start') {
    try {
      const server = await ensureComfyRunning()
      const status = await comfyStatus()
      return { data: status, summary: { kind: 'comfyui', running: true, baseUrl: server.baseUrl, managed: status.managed, workflows: server.models.length } }
    } catch (error) {
      if (error instanceof ComfyLaunchError) throw new CapabilityCommandError(error.code, error.reason ? `ComfyUI 启动失败：${error.reason}` : 'ComfyUI 启动失败')
      throw error
    }
  }
  const status = await comfyStatus()
  return { data: status, summary: { kind: 'comfyui', running: status.running, managed: status.managed, launchable: status.launchable, ...(status.idleStopAt ? { idleStopInSeconds: Math.max(0, Math.round((status.idleStopAt - Date.now()) / 1000)) } : {}), workflows: status.workflows.length } }
}
