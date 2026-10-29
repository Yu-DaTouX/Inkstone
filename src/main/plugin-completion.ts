import { PiRpc } from './protocol'
import { PI_AGENT_DIR, YAN_DIR } from './paths'
import { getSettings } from './settings'

export async function completePluginText(model: string, system: string, prompt: string, signal: AbortSignal): Promise<string> {
  if (signal.aborted) throw new Error('已取消')
  const settings = await getSettings()
  if (signal.aborted) throw new Error('已取消')
  const rpc = new PiRpc({
    cwd: YAN_DIR,
    piBin: settings.piBin,
    args: [
      '--no-session', '--no-extensions', '--no-context-files', '--no-skills',
      '--no-prompt-templates', '--no-tools', '--model', model,
      ...(system ? ['--system-prompt', system] : [])
    ],
    env: { PI_CODING_AGENT_DIR: PI_AGENT_DIR, YAN_DATA_DIR: YAN_DIR }
  })
  let cancel = (): void => {}
  try {
    return await new Promise<string>((resolve, reject) => {
      let text = '', failure = '', settled = false
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) reject(error)
        else if (text.trim()) resolve(text.trim())
        else reject(new Error(failure || '模型未返回文本'))
      }
      const timer = setTimeout(() => finish(new Error('插件文本补全超时')), 60_000)
      cancel = () => finish(new Error('已取消'))
      signal.addEventListener('abort', cancel, { once: true })
      if (signal.aborted) { cancel(); return }
      rpc.on('event', (event: Record<string, unknown>) => {
        if (settled) return
        if (event.type === 'message_update') {
          const update = event.assistantMessageEvent as Record<string, unknown> | undefined
          if (update?.type === 'text_delta') {
            text += String(update.delta ?? '')
            if (text.length > 128_000) finish(new Error('插件文本输出过长'))
          }
        } else if (event.type === 'message_end') {
          const message = event.message as { errorMessage?: unknown } | undefined
          if (typeof message?.errorMessage === 'string') failure = message.errorMessage
        } else if (event.type === 'agent_settled') finish()
      })
      rpc.on('exit', () => finish())
      rpc.on('spawn-error', error => finish(error))
      rpc.spawn()
      void (async () => {
        try {
          let ready = false
          for (let attempt = 0; attempt < 40 && !settled; attempt++) {
            await new Promise(wait => setTimeout(wait, 250))
            if (settled) return
            try { if ((await rpc.command('get_state')).success) { ready = true; break } } catch {}
          }
          if (settled) return
          if (!ready) throw new Error('插件文本模型未就绪')
          await rpc.command('set_thinking_level', { level: 'off' })
          if (!settled) await rpc.command('prompt', { message: prompt })
        } catch (error) { finish(error instanceof Error ? error : new Error(String(error))) }
      })()
    })
  } finally {
    signal.removeEventListener('abort', cancel)
    await rpc.close()
  }
}
